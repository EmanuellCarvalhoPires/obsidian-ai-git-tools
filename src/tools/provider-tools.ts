// The provider tools: pull requests and pipelines on GitHub or Bitbucket. The provider comes from
// the remote of the repository (`resolveRepo` -> `remoto.ref`), the secret from the settings; the
// HTTP calls go through the `secrets` service of Environment Keys (see src/core/providers). Without
// a secret for the provider the tool answers `secret_nao_configurada` before any network call, and
// the local git tools keep working (decision D6).
//
// `git_pr_merge` has no prompt and no approval hook (waived on purpose since 0.3.0): the agent
// confirms the merge with the user in the chat before calling it. What the tool adds is the check that
// `destino` and `titulo` (the values the user confirmed) are the ones of the real PR.
//
// This file is imported by git-tools.ts (GIT_TOOL_FACTORIES) and imports helpers from it; nothing
// here uses those helpers while the module loads, so the import cycle is harmless.
import { readFile, stat } from "node:fs/promises";
import { basename, extname, isAbsolute, resolve as resolvePath } from "node:path";
import { assertRefName, GuardError } from "../core/guards";
import { parseLsRemote } from "../core/git/branches";
import { currentBranch } from "../core/git/revision";
import { createBitbucketProvider } from "../core/providers/bitbucket";
import { foraDaLista, RemoteError, secretNaoConfigurada, toFail } from "../core/providers/errors";
import { createGithubProvider, criarRepoGithub } from "../core/providers/github";
import { createSecureHttp } from "../core/providers/http";
import type {
  EstrategiaMerge,
  GitProvider,
  PipelineInfo,
  PrDetalhe,
  PrEstado,
  PrIncluir,
  PrInfo,
  ProviderContext,
  ProviderFactory,
  ProviderId,
  ReleaseAtivo,
  RemoteRef,
} from "../core/providers/provider";
import { isInside, resolveRepo } from "../core/repo-resolver";
import { findSecret, redactWith } from "../core/providers/secrets";
import type { HubTool, HubToolResult } from "../ecosystem/types";
import { defineFreeTool, defineRepoTool, optBool, optInt, optString, optStringList, reqString } from "./git-tools";
import type { Args, GitToolDeps, RepoToolContext, ToolAnnotations } from "./git-tools";
import { fail, ok } from "./results";
import type { Dica, ErrorCode } from "./results";
import {
  GIT_PIPELINE_STATUS_SCHEMA,
  GIT_PR_COMENTAR_SCHEMA,
  GIT_PR_CRIAR_SCHEMA,
  GIT_PR_LISTAR_SCHEMA,
  GIT_PR_MERGE_SCHEMA,
  GIT_PR_OBTER_SCHEMA,
  GIT_RELEASE_CRIAR_SCHEMA,
  GIT_REPO_CRIAR_SCHEMA,
} from "./schemas";

// Literal (not spread from git-tools.ts) so that the module can load before git-tools.ts finishes.
const READ_REMOTE: ToolAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const WRITE_PROVIDER: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
const MERGE_ANNOTATIONS: ToolAnnotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };

const DEFAULT_PR_LIMIT = 20;
const MAX_PR_LIMIT = 100;
const DEFAULT_PIPELINE_LIMIT = 5;
const MAX_PIPELINE_LIMIT = 20;

const DICA_PUSH = "Envie a branch antes com git_push (definir_upstream=true) e chame git_pr_criar de novo.";

// ---------------------------------------------------------------------------
// Provider selection
// ---------------------------------------------------------------------------

/** What a provider tool uses once the repository, the provider and the secret are known. */
interface ProviderUse {
  provider: GitProvider;
  ref: RemoteRef;
  secretName: string;
  /** Name of the git remote the provider was read from (for `ls-remote`). */
  remoto: string;
}

const DEFAULT_FACTORIES: Record<ProviderId, ProviderFactory> = {
  github: createGithubProvider,
  bitbucket: createBitbucketProvider,
};

/**
 * Builds the provider of the repository, at every call (nothing is cached: the settings, the secret
 * and the service of Environment Keys can change while Obsidian runs).
 */
async function useProvider(ctx: RepoToolContext): Promise<ProviderUse> {
  const { deps, repo } = ctx;
  const ref = repo.remoto?.ref;
  if (!repo.remoto || !ref) {
    const where = repo.remoto ? ` O remoto ${repo.remoto.nome} (${repo.remoto.url}) não é do GitHub nem do Bitbucket.` : " O repositório não tem remoto configurado.";
    throw new RemoteError(
      "argumento_invalido",
      `Não dá para falar com um provedor: as tools de PR e de pipeline só funcionam em repositórios do GitHub ou do Bitbucket.${where}`,
      { dica: "Confira os remotos com git_status (remoto=true)." },
    );
  }
  const settings = deps.settings();
  const secretName = (ref.provider === "github" ? settings.secretGithub : settings.secretBitbucket).trim();
  if (secretName === "") throw secretNaoConfigurada(ref.provider);

  const getSecrets = deps.getSecrets ?? (() => undefined);
  const secretInfo = await findSecret(getSecrets, secretName);
  const redact = deps.redact ?? ((text: string): string => redactWith(getSecrets, text));
  const pctx: ProviderContext = {
    http: deps.http ?? createSecureHttp(getSecrets),
    ref,
    secretName,
    redact,
    ...(secretInfo ? { secretInfo } : {}),
  };
  const factory = deps.providerFactories?.[ref.provider] ?? DEFAULT_FACTORIES[ref.provider];
  return { provider: factory(pctx), ref, secretName, remoto: repo.remoto.nome };
}

/**
 * A provider failure as the failure of a tool. A 404 or 405 on an endpoint may mean that the
 * operation is not one the provider layer covers, so those errors also carry the hint of the
 * contract (Bitbucket: search_vault_tools; GitHub: http_request).
 */
function remoteFail(err: RemoteError, redact: ((text: string) => string) | undefined, use: ProviderUse | undefined): HubToolResult {
  const res = toFail(err, redact);
  if (use === undefined || (err.status !== 404 && err.status !== 405)) return res;
  const fora = foraDaLista(use.ref.provider, use.secretName);
  const base: Record<string, unknown> = typeof fora === "string" ? { usar: fora } : fora;
  const dica: Dica = typeof err.dica === "string" ? { ...base, conferir: err.dica } : { ...base, ...(err.dica ?? {}) };
  return { ...res, structuredContent: { ...res.structuredContent, dica } };
}

/** Resolves the provider and runs `fn`; a RemoteError becomes the failure of the tool. */
async function withProvider(ctx: RepoToolContext, fn: (use: ProviderUse) => Promise<HubToolResult>): Promise<HubToolResult> {
  let use: ProviderUse | undefined;
  try {
    use = await useProvider(ctx);
    return await fn(use);
  } catch (err) {
    if (err instanceof RemoteError) return remoteFail(err, ctx.deps.redact, use);
    throw err;
  }
}

/** What the creation of a repository needs: there is no remote yet, so no RemoteRef, only the GitHub secret. */
async function githubContext(deps: GitToolDeps): Promise<Pick<ProviderContext, "http" | "secretName" | "secretInfo" | "redact">> {
  const secretName = deps.settings().secretGithub.trim();
  if (secretName === "") throw secretNaoConfigurada("github");
  const getSecrets = deps.getSecrets ?? (() => undefined);
  const secretInfo = await findSecret(getSecrets, secretName);
  return {
    http: deps.http ?? createSecureHttp(getSecrets),
    secretName,
    redact: deps.redact ?? ((text: string) => redactWith(getSecrets, text)),
    ...(secretInfo ? { secretInfo } : {}),
  };
}

const MAX_ASSET_BYTES = 10 * 1024 * 1024;
const CONTENT_TYPES: Record<string, string> = {
  ".js": "application/javascript",
  ".json": "application/json",
  ".css": "text/css",
  ".md": "text/markdown",
  ".txt": "text/plain",
  ".html": "text/html",
  ".svg": "image/svg+xml",
};

/** Reads the files to attach: relative to the repository, inside it, text only and not too big. */
async function readAtivos(root: string, arquivos: string[]): Promise<ReleaseAtivo[]> {
  const ativos: ReleaseAtivo[] = [];
  for (const rel of arquivos) {
    if (rel.trim() === "" || isAbsolute(rel) || rel.split(/[\\/]/).some((seg) => seg === "..")) {
      throw new GuardError(`Arquivo inválido em "arquivos": ${rel} (use caminho relativo à raiz do repositório, sem "..").`);
    }
    const full = resolvePath(root, rel);
    if (!isInside(root, full)) throw new GuardError(`O arquivo ${rel} fica fora do repositório.`);
    let size: number;
    try {
      size = (await stat(full)).size;
    } catch {
      throw new GuardError(`O arquivo ${rel} não existe no repositório (rode o build antes, se ele é gerado).`);
    }
    if (size > MAX_ASSET_BYTES) throw new GuardError(`O arquivo ${rel} passa de ${MAX_ASSET_BYTES / (1024 * 1024)} MB.`);
    const conteudo = await readFile(full, "utf8");
    if (conteudo.includes("\u0000")) throw new GuardError(`O arquivo ${rel} não é de texto: só dá para anexar arquivos de texto.`);
    ativos.push({ nome: basename(full), conteudo, contentType: CONTENT_TYPES[extname(full).toLowerCase()] ?? "application/octet-stream" });
  }
  return ativos;
}

async function anexarArquivos(ctx: RepoToolContext, tag: string, ativos: ReleaseAtivo[]): Promise<HubToolResult> {
  return withProvider(ctx, async (use) => {
    if (!use.provider.anexarRelease) {
      return fail("argumento_invalido", "Só o GitHub tem releases pela API. No Bitbucket a versão é a tag.", "Use a tag e os arquivos pela página do Bitbucket ou pelo fluxo da branch.");
    }
    const rel = await use.provider.anexarRelease({ tag, ativos });
    return ok(`${rel.ativos.length} arquivo(s) anexado(s) à release ${rel.tag}: ${rel.ativos.join(", ")}${rel.url !== "" ? `\n${rel.url}` : ""}`, {
      repo: ctx.repo.root,
      provedor: use.ref.provider,
      id: rel.id,
      tag: rel.tag,
      url: rel.url,
      arquivos: rel.ativos,
    });
  });
}

const REMOTE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

// ---------------------------------------------------------------------------
// Arguments and text
// ---------------------------------------------------------------------------

function reqInt(args: Args, key: string): number {
  const v = optInt(args, key);
  if (v === undefined) throw new GuardError(`"${key}" é obrigatório.`);
  return v;
}

function intInRange(args: Args, key: string, fallback: number, min: number, max: number): number {
  const v = optInt(args, key) ?? fallback;
  if (v < min || v > max) throw new GuardError(`"${key}" tem de estar entre ${min} e ${max}.`);
  return v;
}

function reqNumero(args: Args): number {
  const n = reqInt(args, "numero");
  if (n < 1) throw new GuardError('"numero" tem de ser maior que zero.');
  return n;
}

const ESTADOS: ReadonlyArray<PrEstado | "todos"> = ["aberto", "mesclado", "fechado", "todos"];
const ESTRATEGIAS: ReadonlyArray<EstrategiaMerge> = ["merge", "squash", "fast_forward"];
const INCLUIR: ReadonlyArray<PrIncluir> = ["commits", "diff", "comentarios"];

function prData(pr: PrInfo, resumido = false): Record<string, unknown> {
  return {
    numero: pr.numero,
    titulo: pr.titulo,
    estado: pr.estado,
    origem: pr.origem,
    destino: pr.destino,
    url: pr.url,
    autor: pr.autor,
    criado_em: pr.criadoEm,
    ...(!resumido && pr.descricao !== undefined ? { descricao: pr.descricao } : {}),
    ...(!resumido && pr.headSha !== undefined ? { head_sha: pr.headSha } : {}),
  };
}

function prLine(pr: PrInfo): string {
  const autor = pr.autor !== "" ? ` por ${pr.autor}` : "";
  return `#${pr.numero} [${pr.estado}] ${pr.titulo} (${pr.origem} -> ${pr.destino})${autor}${pr.url !== "" ? ` ${pr.url}` : ""}`;
}

function pipelineData(p: PipelineInfo): Record<string, unknown> {
  return {
    id: p.id,
    estado: p.estado,
    branch: p.branch,
    commit: p.commit,
    url: p.url,
    criado_em: p.criadoEm,
    steps: p.steps.map((s) => ({ nome: s.nome, estado: s.estado })),
  };
}

function pipelineLines(p: PipelineInfo): string[] {
  const head = `${p.estado} ${p.branch !== "" ? p.branch : "(sem branch)"} ${p.commit.slice(0, 7)}${p.url !== "" ? ` ${p.url}` : ""}`;
  return [head, ...p.steps.map((s) => `    ${s.estado} ${s.nome}`)];
}

/**
 * Warnings about the destination of a PR against the gitflow hierarchy: feature, bugfix and chore
 * go to develop; develop goes to main; hotfix goes to main or develop. Other branch names have no
 * rule. It only warns: a repository without `develop` (or without gitflow) is a valid case.
 */
export function gitflowAvisos(origem: string, destino: string): string[] {
  let esperado: string[] | undefined;
  if (/^(feature|bugfix|chore)\//.test(origem)) esperado = ["develop"];
  else if (origem === "develop") esperado = ["main"];
  else if (/^hotfix\//.test(origem)) esperado = ["main", "develop"];
  if (esperado === undefined || esperado.includes(destino)) return [];
  return [
    `Pelo gitflow, "${origem}" costuma ir para ${esperado.join(" ou ")}, não para "${destino}". O PR foi aberto assim mesmo; se o repositório não segue o gitflow (por exemplo, não tem develop), ignore este aviso.`,
  ];
}

/** Failure that also carries data at the top level of structuredContent. */
function failWith(codigo: ErrorCode, mensagem: string, dica: Dica | undefined, dados: Record<string, unknown>): HubToolResult {
  const res = fail(codigo, mensagem, dica);
  return { ...res, structuredContent: { ...res.structuredContent, ...dados } };
}

// ---------------------------------------------------------------------------
// The tools
// ---------------------------------------------------------------------------

export function buildProviderTools(deps: GitToolDeps): HubTool[] {
  return [
    defineRepoTool(deps, {
      name: "git_pr_criar",
      title: "Abrir pull request",
      description:
        "Abre um pull request no GitHub ou no Bitbucket (escolhido pelo remoto do repositório) da branch origem para a branch destino. Confere com git ls-remote que a origem já está no remoto (se não estiver, recusa e manda usar git_push com definir_upstream). Avisa, sem bloquear, quando o destino foge da hierarquia do gitflow (feature, bugfix e chore para develop; develop para main; hotfix para main ou develop). No Bitbucket a branch de origem nunca é apagada no merge. Precisa de uma secret do provedor configurada.",
      inputSchema: GIT_PR_CRIAR_SCHEMA,
      annotations: WRITE_PROVIDER,
      async run(ctx, args) {
        const { git, repo } = ctx;
        const origem = reqString(args, "origem").trim();
        const destino = reqString(args, "destino").trim();
        const titulo = reqString(args, "titulo").trim();
        const descricao = optString(args, "descricao");
        const rascunho = args.rascunho === true;
        if (args.rascunho !== undefined && args.rascunho !== null && typeof args.rascunho !== "boolean") throw new GuardError('"rascunho" tem de ser verdadeiro ou falso.');
        await assertRefName(origem, { git, cwd: repo.root });
        await assertRefName(destino, { git, cwd: repo.root });
        if (origem === destino) throw new GuardError("A origem e o destino do PR são a mesma branch.");

        return withProvider(ctx, async (use) => {
          const avisos: string[] = [];
          // The provider would also refuse, but its message does not say what to do next.
          let noRemoto: boolean | undefined;
          try {
            const heads = parseLsRemote(await git(repo.root, ["ls-remote", "--heads", use.remoto, `refs/heads/${origem}`], { timeoutMs: 30_000 }));
            noRemoto = heads.some((h) => h.nome === origem);
          } catch (err) {
            const motivo = err instanceof Error ? err.message : String(err);
            avisos.push(`Não foi possível confirmar no remoto ${use.remoto} que a branch ${origem} existe: ${deps.redact ? deps.redact(motivo) : motivo}`);
          }
          if (noRemoto === false) {
            return fail("argumento_invalido", `A branch de origem "${origem}" não existe no remoto ${use.remoto}: o PR não foi aberto.`, DICA_PUSH);
          }
          avisos.push(...gitflowAvisos(origem, destino));

          const pr = await use.provider.criarPr({
            origem,
            destino,
            titulo,
            ...(descricao !== undefined ? { descricao } : {}),
            ...(rascunho ? { rascunho: true } : {}),
          });
          const texto = `PR #${pr.numero} aberto (${pr.origem} -> ${pr.destino})${rascunho ? " como rascunho" : ""}: ${pr.titulo}${pr.url !== "" ? `\n${pr.url}` : ""}`;
          return ok(
            [texto, ...avisos].join("\n"),
            { repo: repo.root, provedor: use.ref.provider, ...prData(pr), rascunho },
            { avisos },
          );
        });
      },
    }),

    defineRepoTool(deps, {
      name: "git_pr_listar",
      title: "Listar pull requests",
      description:
        "Lista os pull requests do repositório no GitHub ou no Bitbucket, com filtro por estado (aberto, mesclado, fechado, todos; padrão aberto), branch de origem e de destino. Padrão 20 PRs, máximo 100; diz quando há mais. A lista não traz a descrição dos PRs; use git_pr_obter para ler um. Só lê. Precisa de uma secret do provedor configurada.",
      inputSchema: GIT_PR_LISTAR_SCHEMA,
      annotations: READ_REMOTE,
      async run(ctx, args) {
        const estado = (optString(args, "estado") ?? "aberto") as PrEstado | "todos";
        if (!ESTADOS.includes(estado)) throw new GuardError(`estado inválido: ${estado} (use aberto, mesclado, fechado ou todos).`);
        const limite = intInRange(args, "limite", DEFAULT_PR_LIMIT, 1, MAX_PR_LIMIT);
        const origem = optString(args, "origem");
        const destino = optString(args, "destino");
        return withProvider(ctx, async (use) => {
          const res = await use.provider.listarPrs({
            estado,
            limite,
            ...(origem !== undefined ? { origem } : {}),
            ...(destino !== undefined ? { destino } : {}),
          });
          const texto =
            res.itens.length === 0
              ? `Nenhum PR ${estado === "todos" ? "" : `${estado} `}encontrado.`
              : [`${res.itens.length} PR(s) (${estado})${res.truncado ? `, limite de ${limite}: pode haver mais` : ""}:`, ...res.itens.map(prLine)].join("\n");
          return ok(texto, {
            repo: ctx.repo.root,
            provedor: use.ref.provider,
            estado,
            prs: res.itens.map((p) => prData(p, true)),
            total: res.itens.length,
            truncado: res.truncado,
          });
        });
      },
    }),

    defineRepoTool(deps, {
      name: "git_pr_obter",
      title: "Ver um pull request",
      description:
        "Mostra um pull request (título, estado, origem, destino, autor, URL, descrição) e, com incluir, os commits, o diff (cortado em max_bytes_diff, padrão 200000) e os comentários. Só lê. Precisa de uma secret do provedor configurada.",
      inputSchema: GIT_PR_OBTER_SCHEMA,
      annotations: READ_REMOTE,
      async run(ctx, args) {
        const numero = reqNumero(args);
        const incluirArg = optStringList(args, "incluir");
        const incluir: PrIncluir[] = [];
        for (const item of incluirArg ?? []) {
          if (!INCLUIR.includes(item as PrIncluir)) throw new GuardError(`incluir inválido: ${item} (use commits, diff ou comentarios).`);
          if (!incluir.includes(item as PrIncluir)) incluir.push(item as PrIncluir);
        }
        const maxBytes = optInt(args, "max_bytes_diff");
        if (maxBytes !== undefined && maxBytes < 1) throw new GuardError('"max_bytes_diff" tem de ser maior que zero.');
        return withProvider(ctx, async (use) => {
          const pr: PrDetalhe = await use.provider.obterPr({ numero, incluir, ...(maxBytes !== undefined ? { max_bytes_diff: maxBytes } : {}) });
          const linhas = [prLine(pr)];
          if (pr.descricao !== undefined && pr.descricao.trim() !== "") linhas.push("", pr.descricao.trim());
          if (pr.commits) {
            linhas.push("", `Commits (${pr.commits.length}):`, ...pr.commits.map((c) => `  ${c.hash.slice(0, 7)} ${c.autor}: ${c.mensagem.split("\n")[0] ?? ""}`));
          }
          if (pr.comentarios) {
            linhas.push("", `Comentários (${pr.comentarios.length}):`, ...pr.comentarios.map((c) => `  ${c.autor}: ${c.texto.trim().split("\n")[0] ?? ""}`));
          }
          if (pr.diff !== undefined) {
            linhas.push("", pr.diff === "" ? "Diff vazio." : `Diff${pr.diffTruncado ? " (truncado)" : ""}:`, ...(pr.diff === "" ? [] : [pr.diff]));
          }
          return ok(linhas.join("\n"), {
            repo: ctx.repo.root,
            provedor: use.ref.provider,
            ...prData(pr),
            ...(pr.commits ? { commits: pr.commits } : {}),
            ...(pr.comentarios
              ? { comentarios: pr.comentarios.map((c) => ({ id: c.id, autor: c.autor, texto: c.texto, criado_em: c.criadoEm, ...(c.url !== undefined ? { url: c.url } : {}) })) }
              : {}),
            ...(pr.diff !== undefined ? { diff: pr.diff, diff_truncado: pr.diffTruncado === true } : {}),
          });
        });
      },
    }),

    defineRepoTool(deps, {
      name: "git_pr_comentar",
      title: "Comentar um pull request",
      description:
        "Publica um comentário (Markdown) em um pull request. Escreve no provedor, mas não altera código nem o estado do PR. Precisa de uma secret do provedor configurada.",
      inputSchema: GIT_PR_COMENTAR_SCHEMA,
      annotations: WRITE_PROVIDER,
      async run(ctx, args) {
        const numero = reqNumero(args);
        const texto = reqString(args, "texto");
        return withProvider(ctx, async (use) => {
          const c = await use.provider.comentarPr({ numero, texto });
          return ok(
            `Comentário publicado no PR #${numero}${c.url !== undefined ? `: ${c.url}` : "."}`,
            {
              repo: ctx.repo.root,
              provedor: use.ref.provider,
              numero,
              comentario: { id: c.id, autor: c.autor, criado_em: c.criadoEm, ...(c.url !== undefined ? { url: c.url } : {}) },
            },
          );
        });
      },
    }),

    defineRepoTool(deps, {
      name: "git_pr_merge",
      title: "Mesclar pull request",
      description:
        "Mescla um pull request aberto. Não há hook de aprovação: o merge roda assim que a tool é chamada. Antes de chamar, pergunte ao usuário no chat ('Posso fazer o merge do PR #N para a branch XYZ?') e só chame depois de um sim explícito àquele PR. Informe numero, destino e titulo exatamente como estão no PR: a tool lê o PR, exige que esteja aberto e compara destino e titulo com os reais; se divergirem, recusa com aprovacao_divergente e nada é mesclado. A branch de origem nunca é apagada. estrategia: merge, squash ou fast_forward (só no Bitbucket). No Bitbucket o merge pode ser assíncrono: a tool espera até 30 s e, se ainda não terminou, avisa com merge_em_andamento. Precisa de uma secret do provedor configurada.",
      inputSchema: GIT_PR_MERGE_SCHEMA,
      annotations: MERGE_ANNOTATIONS,
      async run(ctx, args) {
        const numero = reqNumero(args);
        const destino = reqString(args, "destino").trim();
        const titulo = reqString(args, "titulo").trim();
        const estrategia = reqString(args, "estrategia") as EstrategiaMerge;
        if (!ESTRATEGIAS.includes(estrategia)) throw new GuardError(`estrategia inválida: ${estrategia} (use merge, squash ou fast_forward).`);
        const mensagem = optString(args, "mensagem");
        return withProvider(ctx, async (use) => {
          const pr = await use.provider.obterPr({ numero });
          if (pr.estado !== "aberto") {
            return fail("argumento_invalido", `O PR #${numero} está ${pr.estado}: só um PR aberto pode ser mesclado. Nada foi mesclado.`, `Confira o PR com git_pr_obter (número ${numero}).`);
          }
          const diverge: string[] = [];
          if (destino !== pr.destino.trim()) diverge.push(`o destino real é "${pr.destino}" (informado "${destino}")`);
          if (titulo !== pr.titulo.trim()) diverge.push(`o título real é "${pr.titulo}" (informado "${titulo}")`);
          if (diverge.length > 0) {
            return failWith(
              "aprovacao_divergente",
              `O PR #${numero} não é o que foi aprovado: ${diverge.join("; ")}. Nada foi mesclado.`,
              "Leia o PR com git_pr_obter, confirme com o usuário e chame git_pr_merge de novo com o destino e o título reais.",
              { numero, destino_informado: destino, destino_real: pr.destino, titulo_informado: titulo, titulo_real: pr.titulo },
            );
          }
          const res = await use.provider.mesclarPr({
            numero,
            estrategia,
            titulo: pr.titulo,
            ...(mensagem !== undefined ? { mensagem } : {}),
            ...(pr.headSha !== undefined ? { sha: pr.headSha } : {}),
          });
          if (!res.mesclado) {
            return fail("resposta_invalida", `O ${use.ref.provider === "github" ? "GitHub" : "Bitbucket"} não confirmou o merge do PR #${numero} (estado ${res.estado}).`, `Confira o PR com git_pr_obter (número ${numero}).`);
          }
          const url = res.url ?? pr.url;
          return ok(
            `PR #${numero} mesclado em ${pr.destino} (${estrategia})${res.commit !== undefined ? `: ${res.commit.slice(0, 7)}` : ""}. A branch ${pr.origem} foi mantida.`,
            { repo: ctx.repo.root, provedor: use.ref.provider, numero, mesclado: true, commit: res.commit ?? null, url, destino: pr.destino, origem: pr.origem, titulo: pr.titulo },
          );
        });
      },
    }),

    defineRepoTool(deps, {
      name: "git_pipeline_status",
      title: "Estado dos pipelines",
      description:
        "Mostra os pipelines mais recentes (Bitbucket Pipelines ou GitHub Actions) com estado normalizado (pendente, executando, sucesso, falha, parado), os steps e o link. Filtra por branch, commit ou PR; sem filtro usa a branch atual. Padrão 5, máximo 20. O log dos steps não é lido. Só lê. Precisa de uma secret do provedor configurada.",
      inputSchema: GIT_PIPELINE_STATUS_SCHEMA,
      annotations: READ_REMOTE,
      async run(ctx, args) {
        const limite = intInRange(args, "limite", DEFAULT_PIPELINE_LIMIT, 1, MAX_PIPELINE_LIMIT);
        const commit = optString(args, "commit");
        const numeroPr = optInt(args, "numero_pr");
        if (numeroPr !== undefined && numeroPr < 1) throw new GuardError('"numero_pr" tem de ser maior que zero.');
        let branch = optString(args, "branch");
        if (branch === undefined && commit === undefined && numeroPr === undefined) {
          branch = await currentBranch(ctx.git, ctx.repo.root);
          if (branch === undefined) throw new GuardError("O repositório está com o HEAD solto: informe branch, commit ou numero_pr.");
        }
        return withProvider(ctx, async (use) => {
          const res = await use.provider.statusPipelines({
            limite,
            ...(branch !== undefined ? { branch } : {}),
            ...(commit !== undefined ? { commit } : {}),
            ...(numeroPr !== undefined ? { numero_pr: numeroPr } : {}),
          });
          const texto =
            res.itens.length === 0
              ? "Nenhum pipeline encontrado."
              : [`${res.itens.length} pipeline(s)${res.truncado ? `, limite de ${limite}: pode haver mais` : ""}:`, ...res.itens.flatMap(pipelineLines)].join("\n");
          return ok(texto, {
            repo: ctx.repo.root,
            provedor: use.ref.provider,
            ...(branch !== undefined ? { branch } : {}),
            pipelines: res.itens.map(pipelineData),
            total: res.itens.length,
            truncado: res.truncado,
          });
        });
      },
    }),

    defineFreeTool(deps, {
      name: "git_repo_criar",
      title: "Criar repositório no GitHub",
      description:
        "Cria um repositório novo (vazio) no GitHub, do usuário da secret ou de uma organização (dono). Publica algo na internet: confirme com o usuário o nome, o dono e se é privado ou público (privado é obrigatório, sem padrão) ANTES de chamar. Se repo for informado (projeto ou caminho de um clone local), adiciona o remoto novo a ele (git remote add, padrão origin); não envia nada: o envio do código é git_push. Recusa-se a trocar um remoto que já existe. Só GitHub; no Bitbucket crie o repositório pela página do provedor. Precisa de uma secret do GitHub configurada, com permissão de criar repositórios.",
      inputSchema: GIT_REPO_CRIAR_SCHEMA,
      annotations: WRITE_PROVIDER,
      async run({ deps: d, git }, args) {
        const nome = reqString(args, "nome").trim();
        const privado = optBool(args, "privado");
        if (privado === undefined) throw new GuardError('"privado" é obrigatório (true ou false): decida com o usuário.');
        const descricao = optString(args, "descricao");
        const dono = optString(args, "dono")?.trim();
        const repoInput = optString(args, "repo");
        const nomeRemoto = (optString(args, "nome_remoto") ?? "origin").trim();
        if (!REMOTE_NAME.test(nomeRemoto)) throw new GuardError(`nome_remoto inválido: ${nomeRemoto}.`);
        if (args.nome_remoto !== undefined && repoInput === undefined) throw new GuardError('"nome_remoto" só vale junto com "repo".');
        // Resolved before the network call, so that a wrong path does not leave a repository behind.
        const local =
          repoInput === undefined
            ? undefined
            : await resolveRepo(repoInput, { git, projects: d.projects, allowedFolders: d.allowedFolders, allowAnyFolder: d.allowAnyFolder, remoteCache: d.remoteCache });
        let jaTem = false;
        if (local) {
          const remotos = (await git(local.root, ["remote"])).split(/\r?\n/).map((s) => s.trim());
          jaTem = remotos.includes(nomeRemoto);
          if (jaTem) {
            return fail("argumento_invalido", `O repositório local já tem o remoto "${nomeRemoto}": nada foi criado no GitHub.`, "Use outro nome_remoto ou confira com git_status (remoto=true).");
          }
        }

        let criado: Awaited<ReturnType<typeof criarRepoGithub>>;
        try {
          criado = await criarRepoGithub(await githubContext(d), { nome, privado, ...(descricao !== undefined ? { descricao } : {}), ...(dono !== undefined ? { dono } : {}) });
        } catch (err) {
          if (err instanceof RemoteError) return remoteFail(err, d.redact, undefined);
          throw err;
        }

        const avisos: string[] = [];
        let remotoAdicionado = false;
        if (local) {
          try {
            await git(local.root, ["remote", "add", nomeRemoto, criado.cloneUrl]);
            d.remoteCache?.forget(local.root);
            remotoAdicionado = true;
          } catch (err) {
            const motivo = err instanceof Error ? err.message : String(err);
            avisos.push(`O repositório foi criado, mas o remoto ${nomeRemoto} não foi adicionado ao clone local: ${d.redact ? d.redact(motivo) : motivo}`);
          }
        }
        const partes = [`Repositório ${criado.dono}/${criado.slug} criado no GitHub (${criado.privado ? "privado" : "público"}): ${criado.url}`];
        if (remotoAdicionado) partes.push(`Remoto ${nomeRemoto} adicionado a ${local?.root ?? ""}. Envie o código com git_push (definir_upstream=true).`);
        return ok([...partes, ...avisos].join("\n"), {
          provedor: "github",
          dono: criado.dono,
          slug: criado.slug,
          repo: `${criado.dono}/${criado.slug}`,
          privado: criado.privado,
          url: criado.url,
          clone_url: criado.cloneUrl,
          branch_padrao: criado.branchPadrao,
          ...(local ? { repo_local: local.root, remoto: nomeRemoto, remoto_adicionado: remotoAdicionado } : {}),
        }, { avisos });
      },
    }),

    defineRepoTool(deps, {
      name: "git_release_criar",
      title: "Publicar release no GitHub",
      description:
        "Publica uma release no GitHub para a tag informada. Se a tag ainda não existe no remoto, o GitHub a cria em alvo (padrão: a branch padrão), então envie antes o commit com git_push. Sem notas, o GitHub gera as notas dos PRs (gerar_notas). Em arquivos, anexa arquivos de texto do clone (para um plugin do Obsidian: main.js, manifest.json e styles.css, depois do build); o token precisa permitir o host uploads.github.com. Com anexar_apenas=true não cria nada: só anexa os arquivos a uma release que já existe (para quando a release foi criada sem arquivos). Recusa uma tag que já tem release. Publica algo visível ao público: confirme com o usuário a versão e o repositório ANTES de chamar. Só GitHub; no Bitbucket use git_tag e git_push. Precisa de uma secret do GitHub com permissão de escrita em conteúdo.",
      inputSchema: GIT_RELEASE_CRIAR_SCHEMA,
      annotations: WRITE_PROVIDER,
      async run(ctx, args) {
        const tag = reqString(args, "tag").trim();
        await assertRefName(tag, { git: ctx.git, cwd: ctx.repo.root });
        if (optBool(args, "anexar_apenas") === true) {
          const extras = ["titulo", "notas", "alvo", "gerar_notas", "rascunho", "prerelease"].filter((k) => args[k] !== undefined && args[k] !== null);
          if (extras.length > 0) throw new GuardError(`Com anexar_apenas=true não use ${extras.join(", ")}: a release já existe e só ganha arquivos.`);
          const ativosExistentes = await readAtivos(ctx.repo.root, optStringList(args, "arquivos") ?? []);
          if (ativosExistentes.length === 0) throw new GuardError('"arquivos" tem de ter pelo menos um arquivo com anexar_apenas=true.');
          return anexarArquivos(ctx, tag, ativosExistentes);
        }
        const titulo = optString(args, "titulo");
        const notas = optString(args, "notas");
        const alvo = optString(args, "alvo");
        if (alvo !== undefined) await assertRefName(alvo, { git: ctx.git, cwd: ctx.repo.root });
        const gerarNotas = optBool(args, "gerar_notas") ?? true;
        const rascunho = optBool(args, "rascunho") ?? false;
        const prerelease = optBool(args, "prerelease") ?? false;
        const ativos = await readAtivos(ctx.repo.root, optStringList(args, "arquivos") ?? []);
        return withProvider(ctx, async (use) => {
          if (!use.provider.criarRelease) {
            return fail("argumento_invalido", "Só o GitHub tem releases pela API. No Bitbucket a versão é a tag.", "Crie a tag com git_tag e envie com git_push (tag).");
          }
          const rel = await use.provider.criarRelease({
            tag,
            gerarNotas,
            rascunho,
            prerelease,
            ativos,
            ...(titulo !== undefined ? { titulo } : {}),
            ...(notas !== undefined ? { notas } : {}),
            ...(alvo !== undefined ? { alvo } : {}),
          });
          const anexos = rel.ativos.length === 0 ? "" : ` com ${rel.ativos.length} arquivo(s): ${rel.ativos.join(", ")}`;
          return ok(`Release ${rel.tag} ${rel.rascunho ? "criada como rascunho" : "publicada"}${anexos}${rel.url !== "" ? `\n${rel.url}` : ""}`, {
            repo: ctx.repo.root,
            provedor: use.ref.provider,
            id: rel.id,
            tag: rel.tag,
            titulo: rel.titulo,
            url: rel.url,
            rascunho: rel.rascunho,
            prerelease: rel.prerelease,
            arquivos: rel.ativos,
          });
        });
      },
    }),
  ];
}
