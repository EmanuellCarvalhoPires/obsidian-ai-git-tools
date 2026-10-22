// Bitbucket Cloud provider (API 2.0): pull requests, comments, merge and Pipelines. Everything goes
// through the `SecureHttp` of the context, so the token is only a placeholder in the Authorization
// header. The merge can be asynchronous: a 202 answer carries a `Location` that is polled until the
// task ends (or 30 s pass). No branch is ever deleted: `close_source_branch` is always false.
import { assertOk, providerMessage, RemoteError } from "./errors";
import { authHeaders, num, obj, parseJson, str } from "./http";
import { paginateBitbucket } from "./pagination";
import type {
  ComentarPrParams,
  ComentarioInfo,
  CommitInfo,
  CriarPrParams,
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
  StatusPipelinesParams,
} from "./provider";
import type { HttpResponse } from "../ports";

const API = "https://api.bitbucket.org/2.0/repositories";
const WEB = "https://bitbucket.org";
const DEFAULT_DIFF_BYTES = 200_000;
const DEFAULT_LIMIT = 30;
const MAX_PAGELEN = 50;
const MAX_REDIRECTS = 3;

export const MERGE_POLL_INTERVAL_MS = 1000;
export const MERGE_POLL_TIMEOUT_MS = 30_000;

/** Injection points of the asynchronous merge (tests use a fake clock). */
export interface BitbucketOptions {
  /** Waits `ms`. Default: `window.setTimeout`. */
  sleep?: (ms: number) => Promise<void>;
  /** Clock in ms. Default: `Date.now`. */
  now?: () => number;
  /** Interval between the polls of a 202 merge. Default 1 s. */
  pollIntervalMs?: number;
  /** Time to wait for a 202 merge. Default 30 s. */
  pollTimeoutMs?: number;
}

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => window.setTimeout(resolve, ms));

type Json = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Mapping of the Bitbucket shapes
// ---------------------------------------------------------------------------

function prEstado(state: unknown): PrEstado {
  switch (typeof state === "string" ? state.toUpperCase() : "") {
    case "MERGED":
      return "mesclado";
    case "DECLINED":
    case "SUPERSEDED":
      return "fechado";
    default:
      return "aberto";
  }
}

function toPr(raw: unknown): PrInfo {
  const o = obj(raw);
  const source = obj(o.source);
  const dest = obj(o.destination);
  const info: PrInfo = {
    numero: num(o.id) ?? 0,
    titulo: str(o.title) ?? "",
    estado: prEstado(o.state),
    origem: str(obj(source.branch).name) ?? "",
    destino: str(obj(dest.branch).name) ?? "",
    url: str(obj(obj(o.links).html).href) ?? "",
    autor: str(obj(o.author).display_name) ?? "",
    criadoEm: str(o.created_on) ?? "",
  };
  const descricao = str(o.description);
  if (descricao !== undefined) info.descricao = descricao;
  const sha = str(obj(source.commit).hash);
  if (sha !== undefined) info.headSha = sha;
  return info;
}

function toCommit(raw: unknown): CommitInfo {
  const o = obj(raw);
  const author = obj(o.author);
  return {
    hash: str(o.hash) ?? "",
    mensagem: (str(o.message) ?? "").trim(),
    autor: str(obj(author.user).display_name) ?? str(author.raw) ?? "",
    data: str(o.date) ?? "",
  };
}

function toComentario(raw: unknown): ComentarioInfo {
  const o = obj(raw);
  const info: ComentarioInfo = {
    id: String(num(o.id) ?? str(o.id) ?? ""),
    autor: str(obj(o.user).display_name) ?? "",
    texto: str(obj(o.content).raw) ?? "",
    criadoEm: str(o.created_on) ?? "",
  };
  const url = str(obj(obj(o.links).html).href);
  if (url !== undefined) info.url = url;
  return info;
}

/** Maps the state of a pipeline or of a step (`state.name` and `state.result.name`/`state.stage.name`). */
export function pipelineEstado(rawState: unknown): PipelineEstado {
  const state = obj(rawState);
  const name = (str(state.name) ?? "").toUpperCase();
  const result = (str(obj(state.result).name) ?? "").toUpperCase();
  const stage = (str(obj(state.stage).name) ?? "").toUpperCase();
  const fromResult = (r: string): PipelineEstado | undefined => {
    if (r === "SUCCESSFUL") return "sucesso";
    if (r === "FAILED" || r === "ERROR") return "falha";
    if (r === "STOPPED" || r === "EXPIRED") return "parado";
    return undefined;
  };
  switch (name) {
    case "PENDING":
      return "pendente";
    case "IN_PROGRESS":
    case "RUNNING":
      return stage === "PAUSED" || stage === "HALTED" ? "parado" : "executando";
    case "PAUSED":
    case "HALTED":
      return "parado";
    case "COMPLETED":
      return fromResult(result) ?? "parado";
    case "SUCCESSFUL":
      return "sucesso";
    case "FAILED":
    case "ERROR":
      return "falha";
    case "STOPPED":
    case "EXPIRED":
      return "parado";
    default:
      return fromResult(result) ?? "pendente";
  }
}

/** Cuts `text` to `max` bytes of UTF-8 without leaving a broken character at the end. */
function cutBytes(text: string, max: number): { texto: string; truncado: boolean } {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= max) return { texto: text, truncado: false };
  const cut = new TextDecoder("utf-8").decode(bytes.subarray(0, Math.max(0, max))).replace(/�+$/, "");
  return { texto: cut, truncado: true };
}

/** `https` and the same host as `base`, or a `resposta_invalida`. Returns the absolute URL. */
function sameHttpsHost(base: string, link: string, what: string): string {
  let a: URL;
  let b: URL;
  try {
    a = new URL(base);
    b = new URL(link, base);
  } catch {
    throw new RemoteError("resposta_invalida", `O Bitbucket devolveu ${what} inválido.`);
  }
  if (b.protocol !== "https:" || b.host !== a.host) {
    throw new RemoteError("resposta_invalida", `O Bitbucket devolveu ${what} para outro host; a chamada foi interrompida.`);
  }
  return b.toString();
}

/** BQL string literal: the value between double quotes with `\` and `"` escaped. */
function bqlString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function query(params: Array<[string, string | number | undefined]>): string {
  const parts: string[] = [];
  for (const [k, v] of params) {
    if (v === undefined || v === "") continue;
    parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  }
  return parts.length === 0 ? "" : `?${parts.join("&")}`;
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

/** Provider with injectable clock (for the asynchronous merge). `createBitbucketProvider` is this with the real one. */
export function createBitbucketProviderWith(ctx: ProviderContext, options: BitbucketOptions = {}): GitProvider {
  const sleep = options.sleep ?? realSleep;
  const now = options.now ?? Date.now;
  const pollInterval = options.pollIntervalMs ?? MERGE_POLL_INTERVAL_MS;
  const pollTimeout = options.pollTimeoutMs ?? MERGE_POLL_TIMEOUT_MS;
  const base = `${API}/${encodeURIComponent(ctx.ref.owner)}/${encodeURIComponent(ctx.ref.slug)}`;
  const prBase = (numero: number): string => `${base}/pullrequests/${encodeURIComponent(String(numero))}`;

  const headers = (extra: Record<string, string> = {}): Record<string, string> => authHeaders(ctx, { Accept: "application/json", ...extra });
  const checked = (res: HttpResponse): HttpResponse => assertOk("bitbucket", res, ctx.redact);

  async function getJson(url: string): Promise<unknown> {
    return parseJson(checked(await ctx.http({ method: "GET", url, headers: headers() })));
  }

  /** GET that follows up to 3 redirects on the same https host (the diff answers 302). */
  async function getFollowing(url: string, extra: Record<string, string>): Promise<HttpResponse> {
    let current = url;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const res = await ctx.http({ method: "GET", url: current, headers: headers(extra) });
      const location = res.headers.location;
      if (res.status >= 300 && res.status < 400 && location !== undefined && location !== "") {
        current = sameHttpsHost(current, location, "um redirecionamento");
        continue;
      }
      return checked(res);
    }
    throw new RemoteError("resposta_invalida", "O Bitbucket redirecionou a chamada vezes demais.");
  }

  async function readPr(numero: number): Promise<PrInfo> {
    return toPr(await getJson(prBase(numero)));
  }

  async function criarPr(p: CriarPrParams): Promise<PrInfo> {
    const body: Record<string, unknown> = {
      title: p.titulo,
      description: p.descricao ?? "",
      source: { branch: { name: p.origem } },
      destination: { branch: { name: p.destino } },
      close_source_branch: false,
    };
    // Draft pull requests exist on Bitbucket Cloud (`draft` field of the pullrequest object).
    if (p.rascunho === true) body.draft = true;
    const res = checked(await ctx.http({ method: "POST", url: `${base}/pullrequests`, headers: headers(), body }));
    return toPr(parseJson(res));
  }

  async function listarPrs(p: ListarPrsParams): Promise<Lista<PrInfo>> {
    const limite = Math.max(1, p.limite ?? DEFAULT_LIMIT);
    // `fechado` is DECLINED and SUPERSEDED (the PR was replaced), the two states that toPr maps to it.
    const states =
      p.estado === "todos"
        ? ["OPEN", "MERGED", "DECLINED", "SUPERSEDED"]
        : p.estado === "aberto"
          ? ["OPEN"]
          : p.estado === "mesclado"
            ? ["MERGED"]
            : ["DECLINED", "SUPERSEDED"];
    const filters: string[] = [];
    if (p.origem !== undefined && p.origem !== "") filters.push(`source.branch.name=${bqlString(p.origem)}`);
    if (p.destino !== undefined && p.destino !== "") filters.push(`destination.branch.name=${bqlString(p.destino)}`);
    const parts = states.map((s) => `state=${s}`);
    parts.push(`pagelen=${Math.min(limite, MAX_PAGELEN)}`);
    if (filters.length > 0) parts.push(`q=${encodeURIComponent(filters.join(" AND "))}`);
    const out = await paginateBitbucket(ctx.http, `${base}/pullrequests?${parts.join("&")}`, {
      headers: headers(),
      maxItems: limite,
      ...(ctx.redact ? { redact: ctx.redact } : {}),
    });
    return { itens: out.itens.map(toPr), truncado: out.truncado };
  }

  async function obterPr(p: ObterPrParams): Promise<PrDetalhe> {
    const detalhe: PrDetalhe = { ...(await readPr(p.numero)) };
    const incluir = new Set(p.incluir ?? []);
    const redactOpt = ctx.redact ? { redact: ctx.redact } : {};
    if (incluir.has("commits")) {
      const out = await paginateBitbucket(ctx.http, `${prBase(p.numero)}/commits${query([["pagelen", MAX_PAGELEN]])}`, {
        headers: headers(),
        maxItems: 100,
        ...redactOpt,
      });
      detalhe.commits = out.itens.map(toCommit);
    }
    if (incluir.has("diff")) {
      const res = await getFollowing(`${prBase(p.numero)}/diff`, { Accept: "text/plain" });
      const cut = cutBytes(res.body, p.max_bytes_diff ?? DEFAULT_DIFF_BYTES);
      detalhe.diff = cut.texto;
      detalhe.diffTruncado = cut.truncado;
    }
    if (incluir.has("comentarios")) {
      detalhe.comentarios = (await listarComentarios({ numero: p.numero })).itens;
    }
    return detalhe;
  }

  async function comentarPr(p: ComentarPrParams): Promise<ComentarioInfo> {
    const res = checked(
      await ctx.http({ method: "POST", url: `${prBase(p.numero)}/comments`, headers: headers(), body: { content: { raw: p.texto } } }),
    );
    return toComentario(parseJson(res));
  }

  async function listarComentarios(p: ListarComentariosParams): Promise<Lista<ComentarioInfo>> {
    const limite = Math.max(1, p.limite ?? 100);
    const out = await paginateBitbucket<Json>(ctx.http, `${prBase(p.numero)}/comments${query([["pagelen", MAX_PAGELEN]])}`, {
      headers: headers(),
      ...(ctx.redact ? { redact: ctx.redact } : {}),
    });
    const vivos = out.itens.filter((c) => obj(c).deleted !== true).map(toComentario);
    return { itens: vivos.slice(0, limite), truncado: out.truncado || vivos.length > limite };
  }

  function mergeFromPr(numero: number, raw: unknown, fallbackUrl?: string): MergeResult {
    const pr = toPr(raw);
    const o = obj(raw);
    const estado = str(o.state) === undefined ? "mesclado" : pr.estado;
    const result: MergeResult = { numero: pr.numero || numero, mesclado: estado === "mesclado", estado };
    const commit = str(obj(o.merge_commit).hash);
    if (commit !== undefined) result.commit = commit;
    const url = pr.url !== "" ? pr.url : fallbackUrl;
    if (url !== undefined && url !== "") result.url = url;
    return result;
  }

  /** Follows the `Location` of a 202 merge until the task ends. */
  async function aguardarMerge(numero: number, location: string, startUrl: string): Promise<MergeResult> {
    const taskUrl = sameHttpsHost(startUrl, location, "o endereço da tarefa de merge");
    const inicio = now();
    for (;;) {
      if (now() - inicio >= pollTimeout) {
        throw new RemoteError(
          "merge_em_andamento",
          `O Bitbucket ainda não terminou o merge do PR #${numero} depois de ${Math.round(pollTimeout / 1000)} s. O merge segue em andamento no Bitbucket; ` +
            "isso não é uma falha definitiva. Confira o estado do PR em instantes antes de tentar de novo.",
          { status: 202, dica: `consulte o PR #${numero} com git_pr_obter` },
        );
      }
      const res = await getFollowing(taskUrl, {});
      const body = obj(parseJson(res));
      const task = (str(body.task_status) ?? "").toUpperCase();
      if (task === "SUCCESS" || (task === "" && typeof body.merge_result !== "object" && str(body.state) === "MERGED")) {
        const merged = body.merge_result;
        if (typeof merged === "object" && merged !== null) return mergeFromPr(numero, merged);
        return mergeFromPr(numero, await getJson(prBase(numero)));
      }
      if (task !== "" && task !== "PENDING") {
        const detalhe = providerMessage(res.body);
        const texto = detalhe === undefined ? "" : ` Detalhe do Bitbucket: ${ctx.redact ? ctx.redact(detalhe) : detalhe}`;
        throw new RemoteError("provedor_http_409", `O Bitbucket não conseguiu mesclar o PR #${numero} (tarefa ${task}).${texto}`, { status: 409 });
      }
      await sleep(pollInterval);
    }
  }

  async function mesclarPr(p: MesclarPrParams): Promise<MergeResult> {
    const strategy = p.estrategia === "squash" ? "squash" : p.estrategia === "fast_forward" ? "fast_forward" : "merge_commit";
    const body: Record<string, unknown> = { type: "pullrequest", merge_strategy: strategy, close_source_branch: false };
    if (p.mensagem !== undefined && p.mensagem !== "") body.message = p.mensagem;
    const url = `${prBase(p.numero)}/merge`;
    const res = await ctx.http({ method: "POST", url, headers: headers(), body });
    if (res.status === 202) {
      const location = res.headers.location;
      if (location === undefined || location === "") {
        throw new RemoteError("resposta_invalida", "O Bitbucket aceitou o merge (202) mas não informou onde acompanhar a tarefa.", { status: 202 });
      }
      return aguardarMerge(p.numero, location, url);
    }
    if (res.status === 555) {
      throw new RemoteError(
        "provedor_http_555",
        `O Bitbucket demorou demais para mesclar o PR #${p.numero} (555). O merge pode ter sido concluído ou ainda estar em andamento; confira o estado do PR antes de tentar de novo.`,
        { status: 555, dica: `consulte o PR #${p.numero} com git_pr_obter` },
      );
    }
    if (res.status === 409) {
      const detalhe = providerMessage(res.body);
      const texto = detalhe === undefined ? "" : ` Detalhe do Bitbucket: ${ctx.redact ? ctx.redact(detalhe) : detalhe}`;
      throw new RemoteError(
        "provedor_http_409",
        `O Bitbucket não pôde mesclar o PR #${p.numero} (409): há conflito, a branch de destino mudou ou o PR não está aberto.${texto}`,
        { status: 409, dica: "resolva o conflito ou atualize o PR e tente de novo" },
      );
    }
    checked(res);
    return mergeFromPr(p.numero, parseJson(res));
  }

  async function statusPipelines(p: StatusPipelinesParams): Promise<Lista<PipelineInfo>> {
    const limite = Math.max(1, p.limite ?? 5);
    let branch = p.branch;
    if (p.numero_pr !== undefined) branch = (await readPr(p.numero_pr)).origem || branch;
    const commit = p.commit;
    const filters: string[] = [];
    if (branch !== undefined && branch !== "") filters.push(`target.ref_name=${bqlString(branch)}`);
    if (commit !== undefined && commit !== "") filters.push(`target.commit.hash=${bqlString(commit)}`);
    const localFilter = filters.length > 0;
    const pagelen = localFilter ? Math.min(100, Math.max(limite, 20)) : Math.min(100, limite);
    const parts = ["sort=-created_on", `pagelen=${pagelen}`];
    if (localFilter) parts.push(`q=${encodeURIComponent(filters.join(" AND "))}`);
    const out = await paginateBitbucket<Json>(ctx.http, `${base}/pipelines/?${parts.join("&")}`, {
      headers: headers(),
      maxPages: localFilter ? 2 : 1,
      ...(ctx.redact ? { redact: ctx.redact } : {}),
    });

    // The API may ignore `q`: the filter is repeated here.
    const refOf = (target: Json): string | undefined => str(target.ref_name) ?? str(target.source);
    const keep = (pipeline: Json): boolean => {
      const target = obj(pipeline.target);
      if (branch !== undefined && branch !== "" && refOf(target) !== branch) return false;
      if (commit !== undefined && commit !== "") {
        const hash = str(obj(target.commit).hash);
        if (hash === undefined || !(hash.startsWith(commit) || commit.startsWith(hash))) return false;
      }
      return true;
    };
    const filtered = out.itens.filter(keep);
    const chosen = filtered.slice(0, limite);

    const itens = await Promise.all(
      chosen.map(async (pipeline): Promise<PipelineInfo> => {
        const target = obj(pipeline.target);
        const uuid = str(pipeline.uuid) ?? "";
        const steps = await paginateBitbucket<Json>(ctx.http, `${base}/pipelines/${encodeURIComponent(uuid)}/steps/`, {
          headers: headers(),
          maxPages: 2,
          ...(ctx.redact ? { redact: ctx.redact } : {}),
        });
        const stepInfos: PipelineStep[] = steps.itens.map((s) => ({ nome: str(obj(s).name) ?? "", estado: pipelineEstado(obj(s).state) }));
        const buildNumber = num(pipeline.build_number);
        return {
          id: uuid,
          estado: pipelineEstado(pipeline.state),
          branch: refOf(target) ?? "",
          commit: str(obj(target.commit).hash) ?? "",
          url:
            buildNumber === undefined
              ? ""
              : `${WEB}/${encodeURIComponent(ctx.ref.owner)}/${encodeURIComponent(ctx.ref.slug)}/pipelines/results/${buildNumber}`,
          criadoEm: str(pipeline.created_on) ?? "",
          steps: stepInfos,
        };
      }),
    );
    return { itens, truncado: out.truncado || filtered.length > limite };
  }

  return { id: "bitbucket", criarPr, listarPrs, obterPr, comentarPr, listarComentarios, mesclarPr, statusPipelines };
}

export const createBitbucketProvider: ProviderFactory = (ctx) => createBitbucketProviderWith(ctx);
