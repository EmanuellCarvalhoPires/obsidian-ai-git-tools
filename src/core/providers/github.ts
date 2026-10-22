// GitHub implementation of GitProvider over the REST API (https://api.github.com). Every call goes
// through the SecureHttp of the context: the token is the `{{bearer:NAME}}` placeholder in the
// Authorization header and never appears here. Errors are RemoteError (errors.ts).
import { RemoteError, assertOk, cleanText, providerMessage } from "./errors";
import { authHeaders, list, num, obj, parseJson, str, withQuery } from "./http";
import { paginateGithub } from "./pagination";
import type {
  ComentarPrParams,
  ComentarioInfo,
  CommitInfo,
  CriarPrParams,
  AnexarReleaseParams,
  CriarReleaseParams,
  CriarRepoParams,
  GitProvider,
  ListarComentariosParams,
  ListarPrsParams,
  Lista,
  MergeResult,
  MesclarPrParams,
  ObterPrParams,
  PipelineEstado,
  PipelineInfo,
  PipelineStep,
  PrDetalhe,
  PrEstado,
  PrInfo,
  ProviderContext,
  ProviderFactory,
  ReleaseAtivo,
  ReleaseInfo,
  RepoCriado,
  StatusPipelinesParams,
} from "./provider";

export const GITHUB_API = "https://api.github.com";
/** Host that receives the files of a release (the secret must allow it, like api.github.com). */
export const GITHUB_UPLOADS = "https://uploads.github.com";
export const GITHUB_API_VERSION = "2022-11-28";
const ACCEPT_JSON = "application/vnd.github+json";
const ACCEPT_DIFF = "application/vnd.github.v3.diff";

export const DEFAULT_MAX_BYTES_DIFF = 200_000;
const DEFAULT_LIST_LIMIT = 30;
const DEFAULT_COMMENT_LIMIT = 100;
const DEFAULT_RUN_LIMIT = 5;
const MAX_COMMITS = 250;

type Json = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

/** `merged_at` wins over `closed`: a merged PR is closed on GitHub too. */
function prEstado(raw: Json): PrEstado {
  if (str(raw.merged_at) !== undefined) return "mesclado";
  return raw.state === "closed" ? "fechado" : "aberto";
}

function toPr(raw: Json): PrInfo {
  const head = obj(raw.head);
  const base = obj(raw.base);
  const pr: PrInfo = {
    numero: num(raw.number) ?? 0,
    titulo: str(raw.title) ?? "",
    estado: prEstado(raw),
    origem: str(head.ref) ?? "",
    destino: str(base.ref) ?? "",
    url: str(raw.html_url) ?? "",
    autor: str(obj(raw.user).login) ?? "",
    criadoEm: str(raw.created_at) ?? "",
  };
  const descricao = str(raw.body);
  if (descricao !== undefined) pr.descricao = descricao;
  const sha = str(head.sha);
  if (sha !== undefined) pr.headSha = sha;
  return pr;
}

function toCommit(raw: Json): CommitInfo {
  const commit = obj(raw.commit);
  const author = obj(commit.author);
  return {
    hash: str(raw.sha) ?? "",
    mensagem: str(commit.message) ?? "",
    autor: str(author.name) ?? str(obj(raw.author).login) ?? "",
    data: str(author.date) ?? "",
  };
}

function toComentario(raw: Json): ComentarioInfo {
  const c: ComentarioInfo = {
    id: idText(raw.id),
    autor: str(obj(raw.user).login) ?? "",
    texto: typeof raw.body === "string" ? raw.body : "",
    criadoEm: str(raw.created_at) ?? "",
  };
  const url = str(raw.html_url);
  if (url !== undefined) c.url = url;
  return c;
}

/** Maps the `status` and `conclusion` of a run or job to the normalized state. */
export function mapRunState(status: unknown, conclusion: unknown): PipelineEstado {
  const concl = typeof conclusion === "string" ? conclusion : "";
  if (status === "completed" || concl !== "") {
    switch (concl) {
      case "success":
        return "sucesso";
      case "failure":
      case "timed_out":
      case "startup_failure":
        return "falha";
      case "cancelled":
      case "skipped":
      case "neutral":
      case "stale":
      case "action_required":
        return "parado";
      default:
        return "parado";
    }
  }
  switch (status) {
    case "in_progress":
      return "executando";
    case "queued":
    case "waiting":
    case "requested":
    case "pending":
    default:
      return "pendente";
  }
}

function toStep(job: Json): PipelineStep {
  return { nome: str(job.name) ?? "", estado: mapRunState(job.status, job.conclusion) };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** An id that GitHub sends as a number (or a string) as text. */
function idText(v: unknown): string {
  return typeof v === "number" || typeof v === "string" ? String(v) : "";
}

function assertNumero(numero: number): number {
  if (!Number.isInteger(numero) || numero <= 0) {
    throw new RemoteError("argumento_invalido", "O número do PR deve ser um inteiro positivo.");
  }
  return numero;
}

function limitOf(limite: number | undefined, fallback: number): number {
  return limite === undefined || !Number.isFinite(limite) ? fallback : Math.max(1, Math.floor(limite));
}

/** The text cut to `maxBytes` of UTF-8 (a character cut in half at the end is dropped). */
export function truncateBytes(text: string, maxBytes: number): { texto: string; truncado: boolean } {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= maxBytes) return { texto: text, truncado: false };
  const cut = new TextDecoder("utf-8", { fatal: false }).decode(bytes.subarray(0, Math.max(0, maxBytes)));
  return { texto: cut.replace(/�+$/u, ""), truncado: true };
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export const createGithubProvider: ProviderFactory = (ctx: ProviderContext): GitProvider => {
  const { http, ref, redact } = ctx;
  const repoBase = `${GITHUB_API}/repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.slug)}`;

  const headers = (accept: string = ACCEPT_JSON): Record<string, string> =>
    authHeaders(ctx, { Accept: accept, "X-GitHub-Api-Version": GITHUB_API_VERSION });

  async function getJson(url: string): Promise<unknown> {
    return parseJson(assertOk("github", await http({ method: "GET", url, headers: headers() }), redact));
  }

  async function readPr(numero: number): Promise<Json> {
    return obj(await getJson(`${repoBase}/pulls/${assertNumero(numero)}`));
  }

  async function criarPr(p: CriarPrParams): Promise<PrInfo> {
    const body: Record<string, unknown> = { title: p.titulo, head: p.origem, base: p.destino };
    if (p.descricao !== undefined) body.body = p.descricao;
    if (p.rascunho !== undefined) body.draft = p.rascunho;
    const res = assertOk("github", await http({ method: "POST", url: `${repoBase}/pulls`, headers: headers(), body }), redact);
    return toPr(obj(parseJson(res)));
  }

  async function listarPrs(p: ListarPrsParams): Promise<Lista<PrInfo>> {
    const limite = limitOf(p.limite, DEFAULT_LIST_LIMIT);
    const state = p.estado === "aberto" ? "open" : p.estado === "todos" ? "all" : "closed";
    const url = withQuery(`${repoBase}/pulls`, {
      state,
      head: p.origem !== undefined && p.origem !== "" ? `${ref.owner}:${p.origem}` : undefined,
      base: p.destino,
      per_page: Math.min(100, limite),
    });
    // `mesclado` and `fechado` are both `closed` on GitHub: the filter runs before the cut to `limite`.
    const pick = (body: unknown): unknown => {
      const items = list(body);
      if (p.estado === "mesclado") return items.filter((i) => str(i.merged_at) !== undefined);
      if (p.estado === "fechado") return items.filter((i) => str(i.merged_at) === undefined);
      return items;
    };
    const page = await paginateGithub<Json>(http, url, { headers: headers(), maxItems: limite, pick, redact });
    return { itens: page.itens.map(toPr), truncado: page.truncado };
  }

  async function obterPr(p: ObterPrParams): Promise<PrDetalhe> {
    const numero = assertNumero(p.numero);
    const detalhe: PrDetalhe = toPr(await readPr(numero));
    const incluir = new Set(p.incluir ?? []);
    if (incluir.has("commits")) {
      const page = await paginateGithub<Json>(http, withQuery(`${repoBase}/pulls/${numero}/commits`, { per_page: 100 }), {
        headers: headers(),
        maxItems: MAX_COMMITS,
        redact,
      });
      detalhe.commits = page.itens.map(toCommit);
    }
    if (incluir.has("diff")) {
      const res = assertOk("github", await http({ method: "GET", url: `${repoBase}/pulls/${numero}`, headers: headers(ACCEPT_DIFF) }), redact);
      const cut = truncateBytes(res.body, limitOf(p.max_bytes_diff, DEFAULT_MAX_BYTES_DIFF));
      detalhe.diff = cut.texto;
      detalhe.diffTruncado = cut.truncado;
    }
    if (incluir.has("comentarios")) {
      detalhe.comentarios = (await listarComentarios({ numero })).itens;
    }
    return detalhe;
  }

  async function comentarPr(p: ComentarPrParams): Promise<ComentarioInfo> {
    const url = `${repoBase}/issues/${assertNumero(p.numero)}/comments`;
    const res = assertOk("github", await http({ method: "POST", url, headers: headers(), body: { body: p.texto } }), redact);
    return toComentario(obj(parseJson(res)));
  }

  async function listarComentarios(p: ListarComentariosParams): Promise<Lista<ComentarioInfo>> {
    const limite = limitOf(p.limite, DEFAULT_COMMENT_LIMIT);
    const url = withQuery(`${repoBase}/issues/${assertNumero(p.numero)}/comments`, { per_page: Math.min(100, limite) });
    const page = await paginateGithub<Json>(http, url, { headers: headers(), maxItems: limite, redact });
    return { itens: page.itens.map(toComentario), truncado: page.truncado };
  }

  async function mesclarPr(p: MesclarPrParams): Promise<MergeResult> {
    if (p.estrategia === "fast_forward") {
      throw new RemoteError(
        "argumento_invalido",
        "O GitHub não oferece fast-forward ao mesclar PR pela API. Use a estratégia merge (commit de merge) ou squash.",
      );
    }
    const numero = assertNumero(p.numero);
    // Pins the head: when the branch moves after the check, GitHub answers 409 instead of merging other code.
    const sha = p.sha !== undefined && p.sha !== "" ? p.sha : str(obj((await readPr(numero)).head).sha);
    const body: Record<string, unknown> = { merge_method: p.estrategia };
    if (p.titulo !== undefined) body.commit_title = p.titulo;
    if (p.mensagem !== undefined) body.commit_message = p.mensagem;
    if (sha !== undefined) body.sha = sha;
    const res = await http({ method: "PUT", url: `${repoBase}/pulls/${numero}/merge`, headers: headers(), body });
    if (res.status === 405 || res.status === 409) {
      const detalhe = providerMessage(res.body);
      const extra = detalhe === undefined ? "" : ` Detalhe do GitHub: ${cleanText(detalhe, redact)}`;
      const mensagem =
        res.status === 405
          ? `O PR #${numero} não pode ser mesclado agora (405): há conflitos, checks ou revisões pendentes, ou ele já foi fechado.${extra}`
          : `A cabeça do PR #${numero} mudou depois da conferência (409): leia o PR de novo e repita a aprovação.${extra}`;
      throw new RemoteError(`provedor_http_${res.status}`, mensagem, { status: res.status });
    }
    const out = obj(parseJson(assertOk("github", res, redact)));
    const result: MergeResult = {
      numero,
      mesclado: out.merged !== false,
      estado: "mesclado",
      url: `https://github.com/${ref.owner}/${ref.slug}/pull/${numero}`,
    };
    const commit = str(out.sha);
    if (commit !== undefined) result.commit = commit;
    return result;
  }

  async function statusPipelines(p: StatusPipelinesParams): Promise<Lista<PipelineInfo>> {
    const limite = limitOf(p.limite, DEFAULT_RUN_LIMIT);
    let headSha = p.commit;
    if (p.numero_pr !== undefined) headSha = str(obj((await readPr(p.numero_pr)).head).sha) ?? headSha;
    const url = withQuery(`${repoBase}/actions/runs`, { branch: p.branch, head_sha: headSha, per_page: Math.min(100, limite) });
    const pick = (body: unknown): unknown => obj(body).workflow_runs;
    const page = await paginateGithub<Json>(http, url, { headers: headers(), maxItems: limite, pick, redact });
    const itens = await Promise.all(
      page.itens.map(async (run): Promise<PipelineInfo> => {
        const id = idText(run.id);
        const jobs = list(obj(await getJson(withQuery(`${repoBase}/actions/runs/${encodeURIComponent(id)}/jobs`, { per_page: 100 }))).jobs);
        return {
          id,
          estado: mapRunState(run.status, run.conclusion),
          branch: str(run.head_branch) ?? "",
          commit: str(run.head_sha) ?? "",
          url: str(run.html_url) ?? "",
          criadoEm: str(run.created_at) ?? "",
          steps: jobs.map(toStep),
        };
      }),
    );
    return { itens, truncado: page.truncado };
  }

  /** Attaches files to a release that already exists (looked up by its tag). */
  async function anexarRelease(p: AnexarReleaseParams): Promise<ReleaseInfo> {
    const found = obj(await getJson(`${repoBase}/releases/tags/${encodeURIComponent(p.tag)}`));
    const id = idText(found.id);
    if (id === "") throw new RemoteError("provedor_http_404", `Não há release com a tag ${p.tag} no GitHub.`, { status: 404 });
    const anexados = await enviarAtivos(id, p.tag, p.ativos);
    return {
      id,
      tag: str(found.tag_name) ?? p.tag,
      titulo: str(found.name) ?? p.tag,
      url: str(found.html_url) ?? "",
      rascunho: found.draft === true,
      prerelease: found.prerelease === true,
      ativos: anexados,
    };
  }

  /** Uploads each file to a release, through the uploads host. Stops at the first failure and says what was attached. */
  async function enviarAtivos(id: string, tag: string, ativos: ReleaseAtivo[]): Promise<string[]> {
    const anexados: string[] = [];
    for (const ativo of ativos) {
      const upload = withQuery(`${GITHUB_UPLOADS}/repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.slug)}/releases/${encodeURIComponent(id)}/assets`, { name: ativo.nome });
      try {
        assertOk("github", await http({ method: "POST", url: upload, headers: { ...headers(), "Content-Type": ativo.contentType }, body: ativo.conteudo, rawBody: true }), redact);
      } catch (err) {
        if (!(err instanceof RemoteError)) throw err;
        const feitos = anexados.length === 0 ? "nenhum arquivo foi anexado" : `anexados: ${anexados.join(", ")}`;
        throw new RemoteError(err.codigo, `Falha ao enviar ${ativo.nome} para a release ${tag} (${feitos}). ${err.mensagem}`, {
          ...(err.status !== undefined ? { status: err.status } : {}),
          ...(err.dica !== undefined ? { dica: err.dica } : {}),
        });
      }
      anexados.push(ativo.nome);
    }
    return anexados;
  }

  async function criarRelease(p: CriarReleaseParams): Promise<ReleaseInfo> {
    const comNotas = p.notas !== undefined && p.notas !== "";
    const body: Record<string, unknown> = {
      tag_name: p.tag,
      name: p.titulo ?? p.tag,
      draft: p.rascunho,
      prerelease: p.prerelease,
      generate_release_notes: p.gerarNotas && !comNotas,
    };
    if (comNotas) body.body = p.notas;
    if (p.alvo !== undefined) body.target_commitish = p.alvo;
    const created = obj(parseJson(assertOk("github", await http({ method: "POST", url: `${repoBase}/releases`, headers: headers(), body }), redact)));
    const id = idText(created.id);
    const url = str(created.html_url) ?? "";
    let anexados: string[];
    try {
      anexados = await enviarAtivos(id, p.tag, p.ativos);
    } catch (err) {
      if (!(err instanceof RemoteError)) throw err;
      throw new RemoteError(err.codigo, `A release ${p.tag} foi criada (${url}), mas ${err.mensagem.charAt(0).toLowerCase()}${err.mensagem.slice(1)}`, {
        ...(err.status !== undefined ? { status: err.status } : {}),
        ...(err.dica !== undefined ? { dica: err.dica } : {}),
      });
    }
    return {
      id,
      tag: str(created.tag_name) ?? p.tag,
      titulo: str(created.name) ?? p.titulo ?? p.tag,
      url,
      rascunho: created.draft === true,
      prerelease: created.prerelease === true,
      ativos: anexados,
    };
  }

  return { id: "github", criarPr, listarPrs, obterPr, comentarPr, listarComentarios, mesclarPr, statusPipelines, criarRelease, anexarRelease };
};

const REPO_NAME = /^[A-Za-z0-9._-]{1,100}$/;

/**
 * Creates a repository on GitHub: of the user of the secret, or of the organization `dono`. It is a
 * function of its own, not a method of GitProvider, because there is no repository (and so no
 * RemoteRef) before it exists. The repository starts empty: the first push gives it a branch.
 */
export async function criarRepoGithub(ctx: Pick<ProviderContext, "http" | "secretName" | "secretInfo" | "redact">, p: CriarRepoParams): Promise<RepoCriado> {
  const { http, redact } = ctx;
  if (!REPO_NAME.test(p.nome) || p.nome === "." || p.nome === "..") {
    throw new RemoteError("argumento_invalido", "Nome de repositório inválido. Use letras, números, ponto, hífen e sublinhado (até 100).");
  }
  const dono = p.dono?.trim() ?? "";
  if (dono !== "" && !REPO_NAME.test(dono)) throw new RemoteError("argumento_invalido", "Nome de dono inválido.");
  const headers = authHeaders({ ...ctx, ref: { provider: "github", owner: dono, slug: p.nome, repo: `${dono}/${p.nome}` } }, { Accept: ACCEPT_JSON, "X-GitHub-Api-Version": GITHUB_API_VERSION });

  const me = obj(parseJson(assertOk("github", await http({ method: "GET", url: `${GITHUB_API}/user`, headers }), redact)));
  const login = str(me.login) ?? "";
  const path = dono === "" || dono.toLowerCase() === login.toLowerCase() ? "/user/repos" : `/orgs/${encodeURIComponent(dono)}/repos`;
  const body: Record<string, unknown> = { name: p.nome, private: p.privado, auto_init: false };
  if (p.descricao !== undefined) body.description = p.descricao;
  const res = obj(parseJson(assertOk("github", await http({ method: "POST", url: `${GITHUB_API}${path}`, headers, body }), redact)));
  return {
    provedor: "github",
    dono: str(obj(res.owner).login) ?? (dono !== "" ? dono : login),
    slug: str(res.name) ?? p.nome,
    privado: res.private === true,
    url: str(res.html_url) ?? "",
    cloneUrl: str(res.clone_url) ?? "",
    branchPadrao: str(res.default_branch) ?? "main",
  };
}
