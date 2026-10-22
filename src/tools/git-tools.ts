// The git tools as HubTools. Each handler resolves the repository, validates the arguments, runs
// the pure function of src/core/git and formats the answer with ok/fail.
//
// How the next tasks add tools: write the schema in schemas.ts, the pure function in
// src/core/git, then declare the tool with `defineRepoTool` (or `defineFreeTool` when there is no
// `repo`, e.g. git_clone) inside a factory and append that factory to GIT_TOOL_FACTORIES.
import { GuardError } from "../core/guards";
import { gitAdd } from "../core/git/add";
import { gitBlame } from "../core/git/blame";
import { gitBranches } from "../core/git/branches";
import type { BranchInfo } from "../core/git/branches";
import { gitCheckout } from "../core/git/checkout";
import { cloneAllowedRoots, gitClone } from "../core/git/clone";
import { gitCommit } from "../core/git/commit";
import { gitDiff } from "../core/git/diff";
import { gitFetch } from "../core/git/fetch";
import { gitLog } from "../core/git/log";
import type { CommitInfo } from "../core/git/log";
import { gitMerge } from "../core/git/merge";
import { gitPull, PullNotFastForwardError } from "../core/git/pull";
import { gitPush, PushRejectedError } from "../core/git/push";
import { gitRemoteInfo } from "../core/git/remote-info";
import { gitRevert, RevertMergeError } from "../core/git/revert";
import { gitStash } from "../core/git/stash";
import { gitStatus } from "../core/git/status";
import type { StatusEntry } from "../core/git/status";
import { gitTag } from "../core/git/tag";
import type { HistoryService } from "../core/history/history-service";
import type { ToolRecorder } from "../core/history/recorder";
import type { RemoteSync } from "../core/history/remote-sync";
import type { GitRunner, ProjectLookup, SecureHttp } from "../core/ports";
import type { ProviderFactory, ProviderId } from "../core/providers/provider";
import type { SecretsGetter } from "../core/providers/secrets";
import { resolveRepo } from "../core/repo-resolver";
import type { ResolvedRepo } from "../core/repo-resolver";
import type { HubTool, HubToolResult } from "../ecosystem/types";
import type { Settings } from "../types";
import { buildHistoryTools } from "./history-tools";
import { buildProviderTools } from "./provider-tools";
import { fail, fromError, ok } from "./results";
import type { Dica, ErrorCode } from "./results";
import {
  GIT_ADD_SCHEMA,
  GIT_BLAME_SCHEMA,
  GIT_BRANCHES_SCHEMA,
  GIT_CHECKOUT_SCHEMA,
  GIT_CLONE_SCHEMA,
  GIT_COMMIT_SCHEMA,
  GIT_DIFF_SCHEMA,
  GIT_FETCH_SCHEMA,
  GIT_LOG_SCHEMA,
  GIT_MERGE_SCHEMA,
  GIT_PULL_SCHEMA,
  GIT_PUSH_SCHEMA,
  GIT_REMOTE_INFO_SCHEMA,
  GIT_REVERT_SCHEMA,
  GIT_STASH_SCHEMA,
  GIT_STATUS_SCHEMA,
  GIT_TAG_SCHEMA,
} from "./schemas";
import type { JsonSchema } from "./schemas";

export type Args = Record<string, unknown>;

/** What the tools need from the plugin. Built once in main.ts. */
export interface GitToolDeps {
  git: GitRunner;
  projects: ProjectLookup;
  /** Extra absolute folders the tools may use (read at call time, the setting may change). */
  allowedFolders: () => string[];
  allowAnyFolder?: () => boolean;
  settings: () => Settings;
  /** Environment Keys `redact`: removes known secret values from error text. */
  redact?: (text: string) => string;
  /** Replaces the github.com/bitbucket.org URL check of git_clone. Only tests set it (to clone a local bare repository). */
  validateCloneUrl?: (url: string) => string;
  /** The `secrets` service of Environment Keys, looked up at every call. The provider tools need it (and `http`). */
  getSecrets?: SecretsGetter;
  /** Authenticated HTTP of the provider layer. Default: `createSecureHttp(getSecrets)`. Tests inject a fake. */
  http?: SecureHttp;
  /** Replaces the GitHub or Bitbucket provider implementation. Only tests set it (e.g. a Bitbucket with a fake clock). */
  providerFactories?: Partial<Record<ProviderId, ProviderFactory>>;
  /** Documents what the tools did as event notes in the project (Fase 5). Without it the tools only act. */
  recorder?: ToolRecorder;
  /** Event notes, graph and changelog of the projects. The documentation tools (git_graph, git_changelog, git_sync, git_registrar_evento) exist only with it. */
  history?: HistoryService;
  /** The projects of the vault (the ProjectTracker) that the documentation tools resolve `projeto` with. Default: `projects`. */
  tracker?: ProjectLookup;
  /** Reads the remote (PRs and deploys) for git_sync with `remoto`. Without it that option only warns. */
  remoteSync?: Pick<RemoteSync, "syncProject">;
}

// ---------------------------------------------------------------------------
// Argument helpers (shared with the next tasks)
// ---------------------------------------------------------------------------

export function optString(args: Args, key: string): string | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") throw new GuardError(`"${key}" tem de ser texto.`);
  return v.trim() === "" ? undefined : v;
}

export function reqString(args: Args, key: string): string {
  const v = optString(args, key);
  if (v === undefined) throw new GuardError(`"${key}" é obrigatório.`);
  return v;
}

export function optBool(args: Args, key: string): boolean | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "boolean") throw new GuardError(`"${key}" tem de ser verdadeiro ou falso.`);
  return v;
}

export function optInt(args: Args, key: string): number | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "number" || !Number.isInteger(v)) throw new GuardError(`"${key}" tem de ser um número inteiro.`);
  return v;
}

export function optStringList(args: Args, key: string): string[] | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) throw new GuardError(`"${key}" tem de ser uma lista de textos.`);
  return v as string[];
}

/** Refuses arguments that the schema does not declare (the schema has additionalProperties: false). */
export function assertKnownArgs(args: Args, schema: JsonSchema): void {
  const known = Object.keys((schema.properties as Record<string, unknown> | undefined) ?? {});
  const extra = Object.keys(args).filter((k) => !known.includes(k));
  if (extra.length > 0) throw new GuardError(`Argumento desconhecido: ${extra.join(", ")}.`);
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export type ToolAnnotations = NonNullable<HubTool["annotations"]>;

/**
 * Annotations of the read tools. `git_branches` with `remotas` runs `ls-remote` and
 * `git_remote_info` only reads local config; `openWorldHint` stays false for both because the
 * only network access is a read-only listing of the repository's own remote.
 */
export const READ_ONLY: ToolAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

/** Write tools that only touch the local repository: not read-only, never destructive. */
export const WRITE_LOCAL: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
/** Write tools that talk to the remote (fetch, push, pull). */
export const WRITE_REMOTE: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };

interface ToolMeta {
  name: string;
  title: string;
  description: string;
  inputSchema: JsonSchema;
  annotations: ToolAnnotations;
}

export interface RepoToolContext {
  deps: GitToolDeps;
  git: GitRunner;
  repo: ResolvedRepo;
}

export interface RepoToolSpec extends ToolMeta {
  run(ctx: RepoToolContext, args: Args): Promise<HubToolResult>;
}

/** Tool with a `repo` argument: resolves it (repo_nao_permitido when not allowed) and runs. */
export function defineRepoTool(deps: GitToolDeps, spec: RepoToolSpec): HubTool {
  return {
    name: spec.name,
    title: spec.title,
    description: spec.description,
    inputSchema: spec.inputSchema,
    annotations: spec.annotations,
    handler: async (args) => {
      try {
        assertKnownArgs(args, spec.inputSchema);
        const repo = await resolveRepo(reqString(args, "repo"), {
          git: deps.git,
          projects: deps.projects,
          allowedFolders: deps.allowedFolders,
          allowAnyFolder: deps.allowAnyFolder,
        });
        const result = await spec.run({ deps, git: deps.git, repo }, args);
        return await documented(deps, spec.name, repo, result);
      } catch (err) {
        return fromError(err, deps.redact);
      }
    },
  };
}

/**
 * Lets the recorder write the event note of a successful call and adds the path (`nota`) and the
 * warnings (`avisos`) to the answer. Whatever happens in the recorder, the answer of the tool stays
 * a success: a note that could not be written is only a warning.
 */
async function documented(deps: GitToolDeps, name: string, repo: ResolvedRepo, result: HubToolResult): Promise<HubToolResult> {
  if (!deps.recorder || result.isError === true) return result;
  let outcome: Awaited<ReturnType<ToolRecorder["afterTool"]>>;
  try {
    outcome = await deps.recorder.afterTool(name, repo, result);
  } catch (err) {
    outcome = { avisos: [`A nota do evento não foi gravada: ${err instanceof Error ? err.message : String(err)}`] };
  }
  if (outcome.nota === undefined && outcome.avisos.length === 0) return result;
  const structured: Record<string, unknown> = { ...result.structuredContent };
  const avisos = [...(Array.isArray(structured.avisos) ? (structured.avisos as string[]) : []), ...outcome.avisos];
  if (outcome.nota !== undefined) structured.nota = outcome.nota;
  if (outcome.notas !== undefined) structured.notas = outcome.notas;
  if (avisos.length > 0) structured.avisos = avisos;
  const extra = [...(outcome.nota !== undefined ? [`Nota do evento: ${outcome.nota}`] : []), ...outcome.avisos];
  const content = extra.length === 0 ? result.content : [...result.content, { type: "text" as const, text: extra.join("\n") }];
  return { ...result, content, structuredContent: structured };
}

export interface FreeToolContext {
  deps: GitToolDeps;
  git: GitRunner;
}

export interface FreeToolSpec extends ToolMeta {
  run(ctx: FreeToolContext, args: Args): Promise<HubToolResult>;
}

/** Tool without `repo` (git_clone): the handler checks its own arguments. */
export function defineFreeTool(deps: GitToolDeps, spec: FreeToolSpec): HubTool {
  return {
    name: spec.name,
    title: spec.title,
    description: spec.description,
    inputSchema: spec.inputSchema,
    annotations: spec.annotations,
    handler: async (args) => {
      try {
        assertKnownArgs(args, spec.inputSchema);
        return await spec.run({ deps, git: deps.git }, args);
      } catch (err) {
        return fromError(err, deps.redact);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

function entriesText(label: string, list: StatusEntry[]): string[] {
  if (list.length === 0) return [];
  return [`${label} (${list.length}):`, ...list.map((e) => `  ${e.status} ${e.origem !== undefined ? `${e.origem} -> ` : ""}${e.caminho}`)];
}

function commitLine(c: CommitInfo): string {
  return `${c.hashCurto} ${c.data.slice(0, 10)} ${c.autor}: ${c.assunto}`;
}

function branchLine(b: BranchInfo): string {
  const track = b.upstream !== undefined ? ` -> ${b.upstream}${b.upstream_sumiu ? " (sumiu do remoto)" : ` (+${b.ahead}/-${b.behind})`}` : "";
  return `${b.atual ? "* " : "  "}${b.nome} ${b.hash.slice(0, 7)}${track}`;
}

// ---------------------------------------------------------------------------
// The read tools
// ---------------------------------------------------------------------------

export function buildReadTools(deps: GitToolDeps): HubTool[] {
  return [
    defineRepoTool(deps, {
      name: "git_status",
      title: "Estado do repositório",
      description:
        "Mostra a branch atual, o upstream, quantos commits o local está à frente e atrás, e os arquivos no stage, fora do stage, não rastreados e em conflito. Só lê.",
      inputSchema: GIT_STATUS_SCHEMA,
      annotations: READ_ONLY,
      async run({ git, repo }) {
        const st = await gitStatus(git, repo.root);
        const head = st.branch ?? "(HEAD solto)";
        const track = st.upstream !== undefined ? ` -> ${st.upstream} (${st.ahead} à frente, ${st.behind} atrás)` : " (sem upstream)";
        const lines = [`Branch ${head}${track}.`];
        if (st.limpo) lines.push("Árvore de trabalho limpa.");
        else {
          lines.push(
            ...entriesText("No stage", st.staged),
            ...entriesText("Fora do stage", st.unstaged),
            ...(st.untracked.length > 0 ? [`Não rastreados (${st.untracked.length}):`, ...st.untracked.map((p) => `  ${p}`)] : []),
            ...(st.conflitos.length > 0 ? [`Em conflito (${st.conflitos.length}):`, ...st.conflitos.map((p) => `  ${p}`)] : []),
          );
        }
        return ok(lines.join("\n"), {
          repo: repo.root,
          ...(repo.projeto !== undefined ? { projeto: repo.projeto } : {}),
          branch: st.branch ?? null,
          oid: st.oid ?? null,
          upstream: st.upstream ?? null,
          ahead: st.ahead,
          behind: st.behind,
          staged: st.staged,
          unstaged: st.unstaged,
          untracked: st.untracked,
          conflitos: st.conflitos,
          limpo: st.limpo,
        });
      },
    }),

    defineRepoTool(deps, {
      name: "git_diff",
      title: "Diferenças",
      description:
        "Mostra as diferenças da árvore de trabalho (worktree), do stage (staged) ou entre duas referências (refs). Não inclui arquivos ainda não rastreados. O texto é cortado em max_bytes e marcado como truncado. Só lê.",
      inputSchema: GIT_DIFF_SCHEMA,
      annotations: READ_ONLY,
      async run({ git, repo }, args) {
        const alvo = reqString(args, "alvo");
        if (alvo !== "worktree" && alvo !== "staged" && alvo !== "refs") {
          throw new GuardError(`alvo inválido: ${alvo} (use worktree, staged ou refs).`);
        }
        const res = await gitDiff(git, repo.root, {
          alvo,
          base: optString(args, "base"),
          head: optString(args, "head"),
          caminhos: optStringList(args, "caminhos"),
          stat: optBool(args, "stat"),
          contexto: optInt(args, "contexto"),
          maxBytes: optInt(args, "max_bytes"),
        });
        const where = res.alvo === "refs" ? `${res.base ?? ""}..${res.head ?? ""}` : res.alvo;
        const summary = res.vazio
          ? `Sem diferenças (${where}).`
          : `Diff (${where}): ${res.bytes} bytes${res.truncado ? ` de ${res.bytesTotal}, truncado em max_bytes` : ""}.`;
        return ok(res.vazio ? summary : `${summary}\n\n${res.diff}`, {
          repo: repo.root,
          alvo: res.alvo,
          ...(res.base !== undefined ? { base: res.base } : {}),
          ...(res.head !== undefined ? { head: res.head } : {}),
          diff: res.diff,
          truncado: res.truncado,
          bytes: res.bytes,
          bytes_total: res.bytesTotal,
          vazio: res.vazio,
        });
      },
    }),

    defineRepoTool(deps, {
      name: "git_log",
      title: "Histórico de commits",
      description:
        "Lista commits (hash, autor, data, assunto, pais) com filtros por referência, intervalo, datas, autor e caminho. Com hash devolve o commit completo, com o corpo da mensagem e as estatísticas de arquivos. Só lê.",
      inputSchema: GIT_LOG_SCHEMA,
      annotations: READ_ONLY,
      async run({ git, repo }, args) {
        const res = await gitLog(git, repo.root, {
          ref: optString(args, "ref"),
          limite: optInt(args, "limite"),
          desde: optString(args, "desde"),
          ate: optString(args, "ate"),
          autor: optString(args, "autor"),
          caminho: optString(args, "caminho"),
          intervalo: optString(args, "intervalo"),
          hash: optString(args, "hash"),
        });
        const commits = res.commits.map((c) => ({
          hash: c.hash,
          hash_curto: c.hashCurto,
          autor: c.autor,
          email: c.email,
          data: c.data,
          assunto: c.assunto,
          pais: c.pais,
          ...(c.corpo !== undefined ? { corpo: c.corpo } : {}),
        }));
        const first = res.commits[0];
        let text: string;
        if (res.estatistica !== undefined && first) {
          text = [commitLine(first), ...(first.corpo ? ["", first.corpo] : []), "", res.estatistica].join("\n");
        } else if (res.commits.length === 0) text = "Nenhum commit encontrado.";
        else {
          text = `${res.commits.length} commit(s)${res.podeHaverMais ? ` (limite de ${res.limite}; pode haver mais)` : ""}:\n${res.commits.map(commitLine).join("\n")}`;
        }
        return ok(text, {
          repo: repo.root,
          commits,
          total: commits.length,
          limite: res.limite,
          pode_haver_mais: res.podeHaverMais,
          ...(res.estatistica !== undefined ? { estatistica: res.estatistica } : {}),
        });
      },
    }),

    defineRepoTool(deps, {
      name: "git_blame",
      title: "Autoria das linhas",
      description:
        "Mostra, para cada linha de um arquivo (ou de um intervalo de linhas), o commit, o autor e a data da última alteração. Limitado a 2000 linhas. Só lê.",
      inputSchema: GIT_BLAME_SCHEMA,
      annotations: READ_ONLY,
      async run({ git, repo }, args) {
        const res = await gitBlame(git, repo.root, {
          caminho: reqString(args, "caminho"),
          linhaInicio: optInt(args, "linha_inicio"),
          linhaFim: optInt(args, "linha_fim"),
          ref: optString(args, "ref"),
        });
        const text =
          res.linhas.length === 0
            ? `Nenhuma linha em ${res.caminho}.`
            : [
                `${res.linhas.length} linha(s) de ${res.caminho}${res.truncado ? " (truncado em 2000)" : ""}:`,
                ...res.linhas.map((l) => `${String(l.linha).padStart(4)} ${l.hash.slice(0, 7)} ${l.autor} ${l.data.slice(0, 10)}: ${l.conteudo}`),
              ].join("\n");
        return ok(text, { repo: repo.root, caminho: res.caminho, linhas: res.linhas, truncado: res.truncado });
      },
    }),

    defineRepoTool(deps, {
      name: "git_branches",
      title: "Branches",
      description:
        "Lista as branches locais com upstream, commits à frente e atrás e último commit. Com remotas=true inclui as branches de acompanhamento remoto e consulta o remoto (ls-remote); se a consulta falhar, avisa e continua. Com mescladas_em lista só as já mescladas na referência. Só lê.",
      inputSchema: GIT_BRANCHES_SCHEMA,
      annotations: READ_ONLY,
      async run({ git, repo }, args) {
        const res = await gitBranches(git, repo.root, { remotas: optBool(args, "remotas"), mescladasEm: optString(args, "mescladas_em") });
        const avisos: string[] = [];
        if (res.remotoVivo && !res.remotoVivo.ok) avisos.push(`Não foi possível consultar o remoto${res.remotoVivo.remoto !== "" ? ` ${res.remotoVivo.remoto}` : ""}: ${res.remotoVivo.erro ?? "erro desconhecido"}`);
        const lines = [`${res.locais.length} branch(es) local(is); atual: ${res.atual ?? "(HEAD solto)"}.`, ...res.locais.map(branchLine)];
        if (res.remotas) lines.push(`${res.remotas.length} branch(es) remota(s) conhecida(s):`, ...res.remotas.map(branchLine));
        if (res.remotoVivo?.ok) lines.push(`No remoto ${res.remotoVivo.remoto}: ${res.remotoVivo.branches.map((b) => b.nome).join(", ") || "nenhuma branch"}.`);
        return ok(
          lines.join("\n"),
          {
            repo: repo.root,
            atual: res.atual ?? null,
            locais: res.locais,
            ...(res.remotas ? { remotas: res.remotas } : {}),
            ...(res.remotoVivo ? { remoto_vivo: res.remotoVivo } : {}),
          },
          { avisos },
        );
      },
    }),

    defineRepoTool(deps, {
      name: "git_remote_info",
      title: "Remotos do repositório",
      description:
        "Mostra os remotos (URLs sem credenciais), o provedor (GitHub ou Bitbucket), o dono ou workspace, o slug, a branch padrão e se há secret configurada para o provedor (só sim ou não, nunca o valor). Só lê.",
      inputSchema: GIT_REMOTE_INFO_SCHEMA,
      annotations: READ_ONLY,
      async run({ deps: d, git, repo }) {
        const s = d.settings();
        const info = await gitRemoteInfo(git, repo.root, {
          secrets: { github: s.secretGithub.trim() !== "", bitbucket: s.secretBitbucket.trim() !== "" },
        });
        if (info.principal === undefined) {
          return ok("O repositório não tem remoto configurado.", { repo: repo.root, remotos: [], principal: null, provedor: null, dono: null, slug: null, branch_padrao: null, secret_configurada: false });
        }
        const where = info.provedor !== undefined ? `${info.provedor} ${info.dono ?? ""}/${info.slug ?? ""}` : "provedor não reconhecido";
        const text = [
          `Remoto principal: ${info.principal} (${where}).`,
          `Branch padrão: ${info.branchPadrao ?? "desconhecida"}.`,
          info.provedor !== undefined ? `Secret do ${info.provedor}: ${info.secretConfigurada ? "configurada" : "não configurada"}.` : "",
          ...info.remotos.map((r) => `  ${r.nome}: ${r.url_fetch}`),
        ]
          .filter((l) => l !== "")
          .join("\n");
        return ok(text, {
          repo: repo.root,
          remotos: info.remotos,
          principal: info.principal,
          provedor: info.provedor ?? null,
          dono: info.dono ?? null,
          slug: info.slug ?? null,
          branch_padrao: info.branchPadrao ?? null,
          secret_configurada: info.secretConfigurada,
        });
      },
    }),
  ];
}

// ---------------------------------------------------------------------------
// The local write tools: fetch, checkout, add, commit, push, pull
// ---------------------------------------------------------------------------

/** A failure that also carries data at the top level of structuredContent (e.g. the conflict list). */
function failWith(codigo: ErrorCode, mensagem: string, dica: Dica | undefined, dados: Record<string, unknown>): HubToolResult {
  const res = fail(codigo, mensagem, dica);
  return { ...res, structuredContent: { ...res.structuredContent, ...dados } };
}

function clean(deps: GitToolDeps, text: string): string {
  return deps.redact ? deps.redact(text) : text;
}

function list(label: string, items: string[]): string[] {
  return items.length > 0 ? [`${label} (${items.length}):`, ...items.map((i) => `  ${i}`)] : [];
}

export function buildWriteTools(deps: GitToolDeps): HubTool[] {
  return [
    defineRepoTool(deps, {
      name: "git_fetch",
      title: "Buscar do remoto",
      description:
        "Traz do remoto (padrão origin) as branches e as tags novas, sem alterar a branch atual nem os arquivos (git fetch --tags, sem --prune). Informa o que chegou de novo.",
      inputSchema: GIT_FETCH_SCHEMA,
      annotations: { ...WRITE_REMOTE, idempotentHint: true },
      async run({ git, repo }, args) {
        const res = await gitFetch(git, repo.root, { remoto: optString(args, "remoto") });
        const lines = [`Fetch de ${res.remoto} concluído.`];
        if (res.novas.length === 0 && res.atualizadas.length === 0) lines.push("Nada novo no remoto.");
        lines.push(...list("Novas", res.novas), ...list("Atualizadas", res.atualizadas));
        return ok(lines.join("\n"), { repo: repo.root, remoto: res.remoto, novas: res.novas, atualizadas: res.atualizadas });
      },
    }),

    defineRepoTool(deps, {
      name: "git_checkout",
      title: "Trocar ou criar branch",
      description:
        "Troca de branch (git switch) ou cria uma nova com criar=true (git switch -c), a partir de base ou, sem base, do HEAD atual (com aviso). Nunca força a troca nem descarta alterações: se houver risco de perder trabalho, o git recusa.",
      inputSchema: GIT_CHECKOUT_SCHEMA,
      annotations: WRITE_LOCAL,
      async run({ git, repo }, args) {
        const res = await gitCheckout(git, repo.root, {
          branch: reqString(args, "branch"),
          criar: optBool(args, "criar"),
          base: optString(args, "base"),
        });
        const text = res.criada
          ? `Branch ${res.branch} criada a partir de ${res.base ?? "HEAD"} e ativada.`
          : `Agora na branch ${res.branch}${res.anterior !== undefined ? ` (antes: ${res.anterior})` : ""}.`;
        return ok(
          [text, ...res.avisos].join("\n"),
          { repo: repo.root, branch: res.branch, anterior: res.anterior ?? null, hash: res.hash ?? null, criada: res.criada, base: res.base ?? null },
          { avisos: res.avisos },
        );
      },
    }),

    defineRepoTool(deps, {
      name: "git_add",
      title: "Colocar no stage",
      description:
        "Coloca arquivos no stage: informe caminhos (git add -- <caminhos>) OU todos=true (git add -A), nunca os dois. Recusa arquivos sensíveis (.env, chaves privadas, .deploy-target, data.json) e lista quais são; com confirmar_sensivel=true eles são aceitos. Devolve o que ficou no stage.",
      inputSchema: GIT_ADD_SCHEMA,
      annotations: { ...WRITE_LOCAL, idempotentHint: true },
      async run({ deps: d, git, repo }, args) {
        const res = await gitAdd(git, repo.root, {
          caminhos: optStringList(args, "caminhos"),
          todos: optBool(args, "todos"),
          confirmarSensivel: optBool(args, "confirmar_sensivel"),
        });
        if (res.recusado) {
          const msg = [
            "Nada foi para o stage: há arquivos sensíveis (podem conter segredos).",
            ...res.sensiveis.map((f) => `  ${f}`),
            "Se for mesmo intencional, chame de novo com confirmar_sensivel=true. Caso contrário, informe só os outros caminhos (ou ponha o arquivo no .gitignore).",
          ].join("\n");
          return failWith("argumento_invalido", clean(d, msg), "Use confirmar_sensivel=true, ou informe caminhos sem os arquivos sensíveis.", { arquivos_sensiveis: res.sensiveis });
        }
        const lines = [
          res.adicionados.length > 0 ? `${res.adicionados.length} arquivo(s) novo(s) no stage.` : "Nada novo foi para o stage.",
          ...entriesText("No stage", res.staged),
        ];
        const avisos = [...res.avisos];
        if (res.sensiveisConfirmados.length > 0) avisos.push(`Arquivos sensíveis adicionados com confirmação: ${res.sensiveisConfirmados.join(", ")}.`);
        return ok(
          lines.join("\n"),
          { repo: repo.root, adicionados: res.adicionados, staged: res.staged, sensiveis_confirmados: res.sensiveisConfirmados },
          { avisos },
        );
      },
    }),

    defineRepoTool(deps, {
      name: "git_commit",
      title: "Criar commit",
      description:
        "Cria um commit com o que está no stage. A mensagem (e a descrição opcional, depois de uma linha em branco) vai pelo stdin. Nunca usa --amend nem --no-verify: se um hook de pre-commit falhar, o erro é devolvido. Sem nada no stage, recusa com nada_a_commitar (a menos que permitir_vazio=true).",
      inputSchema: GIT_COMMIT_SCHEMA,
      annotations: WRITE_LOCAL,
      async run({ git, repo }, args) {
        const res = await gitCommit(git, repo.root, {
          mensagem: reqString(args, "mensagem"),
          descricao: optString(args, "descricao"),
          permitirVazio: optBool(args, "permitir_vazio"),
        });
        if (!res.criado) {
          return fail("nada_a_commitar", "Não há nada no stage para commitar.", "Use git_add antes, ou permitir_vazio=true para um commit vazio.");
        }
        const text = [`Commit ${res.hash.slice(0, 7)} criado${res.branch !== undefined ? ` em ${res.branch}` : ""}: ${res.titulo}`, res.estatistica]
          .filter((l) => l !== "")
          .join("\n");
        return ok(text, {
          repo: repo.root,
          hash: res.hash,
          hash_curto: res.hash.slice(0, 7),
          branch: res.branch ?? null,
          titulo: res.titulo,
          mensagem: res.mensagem,
          arquivos: res.arquivos,
          estatistica: res.estatistica,
        });
      },
    }),

    defineRepoTool(deps, {
      name: "git_push",
      title: "Enviar para o remoto",
      description:
        "Envia a branch atual (ou a informada) para o remoto (padrão origin), com definir_upstream=true para ligá-la ao remoto, ou envia uma tag com tag. Nunca força, nunca apaga: se o remoto estiver à frente, devolve git_falhou com a dica de usar git_pull. Informa o hash da ponta e se a branch é nova no remoto.",
      inputSchema: GIT_PUSH_SCHEMA,
      annotations: { ...WRITE_REMOTE, idempotentHint: true },
      async run({ deps: d, git, repo }, args) {
        try {
          const res = await gitPush(git, repo.root, {
            remoto: optString(args, "remoto"),
            branch: optString(args, "branch"),
            definirUpstream: optBool(args, "definir_upstream"),
            tag: optString(args, "tag"),
          });
          const what = res.tag !== undefined ? `Tag ${res.tag}` : `Branch ${res.branch ?? ""}`;
          const state = res.emDia ? "já estava em dia no remoto" : res.branchNova ? "enviada (branch nova no remoto)" : res.tagNova ? "enviada (tag nova no remoto)" : "enviada";
          const lines = [`${what} ${state} em ${res.remoto} (${res.hash.slice(0, 7)}).`];
          if (res.upstreamDefinido) lines.push(`Upstream definido: ${res.remoto}/${res.branch ?? ""}.`);
          return ok(lines.join("\n"), {
            repo: repo.root,
            remoto: res.remoto,
            branch: res.branch ?? null,
            tag: res.tag ?? null,
            hash: res.hash,
            branch_nova: res.branchNova,
            tag_nova: res.tagNova,
            em_dia: res.emDia,
            upstream_definido: res.upstreamDefinido,
          });
        } catch (err) {
          if (err instanceof PushRejectedError) return fail("git_falhou", clean(d, err.message), err.dica);
          throw err;
        }
      },
    }),

    defineRepoTool(deps, {
      name: "git_pull",
      title: "Trazer do remoto",
      description:
        "Traz e integra as novidades do remoto na branch atual. modo ff-only (padrão) só avança quando não há divergência; modo merge junta as histórias e, se houver conflito, devolve a lista de arquivos (código conflito) e deixa o merge em andamento. Rebase não existe.",
      inputSchema: GIT_PULL_SCHEMA,
      annotations: { ...WRITE_REMOTE, idempotentHint: true },
      async run({ deps: d, git, repo }, args) {
        const modo = optString(args, "modo");
        if (modo !== undefined && modo !== "ff-only" && modo !== "merge") throw new GuardError(`modo inválido: ${modo} (use ff-only ou merge).`);
        try {
          const res = await gitPull(git, repo.root, { remoto: optString(args, "remoto"), branch: optString(args, "branch"), modo });
          if (res.conflito) {
            const msg = [
              `O merge teve conflito em ${res.arquivos.length} arquivo(s):`,
              ...res.arquivos.map((f) => `  ${f}`),
              "O merge continua em andamento: resolva os arquivos, coloque-os no stage (git_add) e conclua com git_commit.",
            ].join("\n");
            return failWith("conflito", clean(d, msg), "Resolva os conflitos nos arquivos listados, depois git_add e git_commit.", {
              repo: repo.root,
              conflitos: res.arquivos,
              modo: res.modo,
            });
          }
          const text = res.atualizado
            ? `Pull (${res.modo}) trouxe ${res.commitsNovos} commit(s): ${(res.antes ?? "").slice(0, 7)} -> ${(res.depois ?? "").slice(0, 7)}.`
            : "Já estava em dia: nada a trazer.";
          return ok(text, {
            repo: repo.root,
            modo: res.modo,
            remoto: res.remoto ?? null,
            branch: res.branch ?? null,
            antes: res.antes ?? null,
            depois: res.depois ?? null,
            atualizado: res.atualizado,
            commits_novos: res.commitsNovos,
          });
        } catch (err) {
          if (err instanceof PullNotFastForwardError) return fail("git_falhou", clean(d, err.message), err.dica);
          throw err;
        }
      },
    }),
  ];
}

// ---------------------------------------------------------------------------
// The history tools: merge, revert, stash, tag
// ---------------------------------------------------------------------------

export function buildHistoryWriteTools(deps: GitToolDeps): HubTool[] {
  return [
    defineRepoTool(deps, {
      name: "git_merge",
      title: "Mesclar branch",
      description:
        "Mescla a origem (branch, tag ou hash) na branch atual (git merge --no-edit). sem_ff=true sempre cria o commit de merge. Em conflito devolve a lista de arquivos (código conflito) e deixa o merge em andamento: resolva, git_add e git_commit. abortar=true desfaz um merge em andamento (só quando há um) e não pode ser usado com origem.",
      inputSchema: GIT_MERGE_SCHEMA,
      annotations: WRITE_LOCAL,
      async run({ deps: d, git, repo }, args) {
        const res = await gitMerge(git, repo.root, {
          origem: optString(args, "origem"),
          mensagem: optString(args, "mensagem"),
          semFf: optBool(args, "sem_ff"),
          abortar: optBool(args, "abortar"),
        });
        if (res.estado === "abortado") {
          return ok(`Merge abortado${res.branch !== undefined ? ` em ${res.branch}` : ""}: a branch voltou ao estado de antes do merge.`, {
            repo: repo.root,
            abortado: true,
            branch: res.branch ?? null,
            hash: res.hash ?? null,
          });
        }
        if (res.estado === "conflito") {
          const msg = [
            `O merge de ${res.origem} teve conflito em ${res.arquivos.length} arquivo(s):`,
            ...res.arquivos.map((f) => `  ${f}`),
            "O merge continua em andamento: resolva os arquivos, coloque-os no stage (git_add) e conclua com git_commit, ou desfaça com git_merge abortar=true.",
          ].join("\n");
          return failWith("conflito", clean(d, msg), "Resolva os conflitos nos arquivos listados, depois git_add e git_commit; ou git_merge com abortar=true.", {
            repo: repo.root,
            conflitos: res.arquivos,
            origem: res.origem,
          });
        }
        const text = res.jaAtualizado
          ? `Já estava em dia: ${res.origem} já faz parte da branch.`
          : `${res.fastForward ? "Avanço simples (fast-forward)" : "Merge"} de ${res.origem}${res.branch !== undefined ? ` em ${res.branch}` : ""}: ${res.hashCurto}.`;
        return ok(text, {
          repo: repo.root,
          hash: res.hash,
          hash_curto: res.hashCurto,
          branch: res.branch ?? null,
          fast_forward: res.fastForward,
          origem: res.origem,
          ja_atualizado: res.jaAtualizado,
        });
      },
    }),

    defineRepoTool(deps, {
      name: "git_revert",
      title: "Reverter commit",
      description:
        "Cria um commit novo que desfaz o commit informado (git revert --no-edit); o histórico não é reescrito. Para reverter um merge informe merge_pai (-m N). Em conflito devolve a lista de arquivos (código conflito) e deixa o revert em andamento. abortar=true desfaz um revert em andamento (só quando há um).",
      inputSchema: GIT_REVERT_SCHEMA,
      annotations: WRITE_LOCAL,
      async run({ deps: d, git, repo }, args) {
        try {
          const res = await gitRevert(git, repo.root, {
            commit: optString(args, "commit"),
            mergePai: optInt(args, "merge_pai"),
            abortar: optBool(args, "abortar"),
          });
          if (res.estado === "abortado") {
            return ok(`Revert abortado${res.branch !== undefined ? ` em ${res.branch}` : ""}.`, {
              repo: repo.root,
              abortado: true,
              branch: res.branch ?? null,
              hash: res.hash ?? null,
            });
          }
          if (res.estado === "conflito") {
            const msg = [
              `O revert de ${res.commit} teve conflito em ${res.arquivos.length} arquivo(s):`,
              ...res.arquivos.map((f) => `  ${f}`),
              "O revert continua em andamento: resolva os arquivos, coloque-os no stage (git_add) e conclua com git_commit, ou desfaça com git_revert abortar=true.",
            ].join("\n");
            return failWith("conflito", clean(d, msg), "Resolva os conflitos nos arquivos listados, depois git_add e git_commit; ou git_revert com abortar=true.", {
              repo: repo.root,
              conflitos: res.arquivos,
              commit: res.commit,
            });
          }
          return ok(`Commit ${res.hashCurto} criado${res.branch !== undefined ? ` em ${res.branch}` : ""}, revertendo ${res.commit}: ${res.titulo}`, {
            repo: repo.root,
            hash: res.hash,
            hash_curto: res.hashCurto,
            branch: res.branch ?? null,
            revertido: res.commit,
            titulo: res.titulo,
          });
        } catch (err) {
          if (err instanceof RevertMergeError) return fail("git_falhou", clean(d, err.message), err.dica);
          throw err;
        }
      },
    }),

    defineRepoTool(deps, {
      name: "git_stash",
      title: "Guardar alterações (stash)",
      description:
        "Guarda e recupera alterações sem commitar. acao salvar (mensagem, incluir_nao_rastreados), listar, mostrar (diff de um stash, cortado como o git_diff), aplicar (reaplica e mantém) e pop (reaplica e remove). indice 0 é o mais recente. Não existe apagar nem limpar. Conflito ao aplicar devolve a lista de arquivos (código conflito) e o stash é mantido.",
      inputSchema: GIT_STASH_SCHEMA,
      annotations: WRITE_LOCAL,
      async run({ deps: d, git, repo }, args) {
        const res = await gitStash(git, repo.root, {
          acao: reqString(args, "acao"),
          mensagem: optString(args, "mensagem"),
          incluirNaoRastreados: optBool(args, "incluir_nao_rastreados"),
          indice: optInt(args, "indice"),
        });
        if (res.acao === "salvar") {
          if (!res.salvo) return ok("Nada a guardar: não há alterações locais.", { repo: repo.root, acao: "salvar", salvo: false, total: res.total });
          const e = res.entrada;
          return ok(`Alterações guardadas em ${e?.ref ?? "stash@{0}"}${e ? `: ${e.descricao}` : ""}.`, {
            repo: repo.root,
            acao: "salvar",
            salvo: true,
            indice: e?.indice ?? 0,
            ref: e?.ref ?? "stash@{0}",
            hash: e?.hash ?? null,
            descricao: e?.descricao ?? null,
            total: res.total,
          });
        }
        if (res.acao === "listar") {
          const text = res.total === 0 ? "Nenhum stash." : [`${res.total} stash(es):`, ...res.entradas.map((e) => `  ${e.ref} ${e.data.slice(0, 10)} ${e.descricao}`)].join("\n");
          return ok(text, { repo: repo.root, acao: "listar", stashes: res.entradas, total: res.total });
        }
        if (res.acao === "mostrar") {
          const head = res.vazio ? `O stash ${res.ref} não tem diferenças.` : `Diff de ${res.ref}: ${res.bytes} bytes${res.truncado ? ` de ${res.bytesTotal}, truncado` : ""}.`;
          return ok(res.vazio ? head : `${head}\n\n${res.diff}`, {
            repo: repo.root,
            acao: "mostrar",
            indice: res.indice,
            ref: res.ref,
            diff: res.diff,
            truncado: res.truncado,
            bytes: res.bytes,
            bytes_total: res.bytesTotal,
            vazio: res.vazio,
          });
        }
        if (res.estado === "conflito") {
          const msg = [
            `${res.acao === "pop" ? "O pop" : "A aplicação"} de ${res.ref} teve conflito em ${res.arquivos.length} arquivo(s):`,
            ...res.arquivos.map((f) => `  ${f}`),
            "O stash foi mantido. Resolva os arquivos e coloque-os no stage (git_add).",
          ].join("\n");
          return failWith("conflito", clean(d, msg), "Resolva os conflitos nos arquivos listados e use git_add. O stash continua guardado.", {
            repo: repo.root,
            acao: res.acao,
            ref: res.ref,
            conflitos: res.arquivos,
            stash_mantido: true,
          });
        }
        return ok(`${res.ref} ${res.acao === "pop" ? "aplicado e removido" : "aplicado (mantido na lista)"}. Restam ${res.total} stash(es).`, {
          repo: repo.root,
          acao: res.acao,
          indice: res.indice,
          ref: res.ref,
          mantido: res.mantido,
          total: res.total,
        });
      },
    }),

    defineRepoTool(deps, {
      name: "git_tag",
      title: "Listar ou criar tags",
      description:
        "acao listar mostra as tags (mais novas primeiro, nome, commit, data e assunto; até 200). acao criar cria uma tag anotada (git tag -a) com nome e mensagem, em commit ou, sem ele, no HEAD. Recusa uma tag que já existe. Não existe apagar tag. Para enviar a tag ao remoto use git_push com tag.",
      inputSchema: GIT_TAG_SCHEMA,
      annotations: WRITE_LOCAL,
      async run({ git, repo }, args) {
        const res = await gitTag(git, repo.root, {
          acao: reqString(args, "acao"),
          nome: optString(args, "nome"),
          commit: optString(args, "commit"),
          mensagem: optString(args, "mensagem"),
        });
        if (res.acao === "listar") {
          const text =
            res.tags.length === 0
              ? "Nenhuma tag."
              : [`${res.total} tag(s)${res.truncado ? ` (mostrando ${res.tags.length})` : ""}:`, ...res.tags.map((t) => `  ${t.nome} ${t.hash.slice(0, 7)} ${t.data.slice(0, 10)} ${t.assunto}`)].join("\n");
          return ok(text, { repo: repo.root, acao: "listar", tags: res.tags, total: res.total, truncado: res.truncado });
        }
        return ok(`Tag ${res.nome} criada em ${res.hash.slice(0, 7)}.`, { repo: repo.root, acao: "criar", nome: res.nome, hash: res.hash, mensagem: res.mensagem });
      },
    }),
  ];
}

// ---------------------------------------------------------------------------
// git_clone: the only tool without `repo`
// ---------------------------------------------------------------------------

export function buildCloneTool(deps: GitToolDeps): HubTool[] {
  return [
    defineFreeTool(deps, {
      name: "git_clone",
      title: "Clonar repositório",
      description:
        "Clona um repositório do GitHub ou do Bitbucket (https ou ssh git@, sem senha na URL) para uma pasta nova. O destino é um caminho absoluto que não existe e fica dentro da pasta dos clones dos projetos ou de uma pasta permitida. branch e profundidade são opcionais. Pode demorar (até 5 minutos).",
      inputSchema: GIT_CLONE_SCHEMA,
      annotations: WRITE_REMOTE,
      async run({ deps: d, git }, args) {
        const res = await gitClone(
          git,
          { url: reqString(args, "url"), destino: reqString(args, "destino"), branch: optString(args, "branch"), profundidade: optInt(args, "profundidade") },
          {
            allowedRoots: await cloneAllowedRoots(d.projects, d.allowedFolders(), d.allowAnyFolder?.() ?? false, reqString(args, "destino")),
            ...(d.validateCloneUrl ? { validateUrl: d.validateCloneUrl } : {}),
          },
        );
        const detail = [res.branch !== undefined ? `branch ${res.branch}` : "", res.hash !== undefined ? res.hash.slice(0, 7) : ""].filter((t) => t !== "").join(", ");
        return ok(`Repositório clonado em ${res.destino}${detail !== "" ? ` (${detail})` : ""}.`, {
          destino: res.destino,
          url: res.url,
          branch: res.branch ?? null,
          hash: res.hash ?? null,
          profundidade: res.profundidade ?? null,
        });
      },
    }),
  ];
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export type GitToolFactory = (deps: GitToolDeps) => HubTool[];

/** Every factory contributes a group of tools. The next tasks append theirs here. */
export const GIT_TOOL_FACTORIES: GitToolFactory[] = [
  buildReadTools,
  buildWriteTools,
  buildHistoryWriteTools,
  buildCloneTool,
  // Lazy on purpose: provider-tools.ts imports this module, so it is only read when the tools are built.
  (deps) => buildProviderTools(deps),
  (deps) => buildHistoryTools(deps),
];

export function buildGitTools(deps: GitToolDeps): HubTool[] {
  return GIT_TOOL_FACTORIES.flatMap((factory) => factory(deps));
}
