// git_stash: salvar (`stash push [-u] [-m msg]`), listar, mostrar (`stash show -p`), aplicar e pop.
// There is no drop and no clear: any other action is refused. The stash reference is always built
// here as `stash@{N}` from an integer, never from text typed by the user.
import { GitError } from "../git-runner";
import { GuardError, rejectForbiddenFlags } from "../guards";
import type { GitRunner } from "../ports";
import { DIFF_DEFAULT_MAX_BYTES, cutBytes } from "./diff";
import { conflictedFiles } from "./merge";

export const STASH_ACTIONS = ["salvar", "listar", "mostrar", "aplicar", "pop"] as const;
export type StashAction = (typeof STASH_ACTIONS)[number];

export interface StashArgs {
  acao: string;
  mensagem?: string;
  incluirNaoRastreados?: boolean;
  /** 0 = the newest stash. Only for mostrar, aplicar and pop. */
  indice?: number;
}

export interface StashEntry {
  indice: number;
  ref: string;
  hash: string;
  /** Reflog subject, e.g. "On main: minha mensagem". */
  descricao: string;
  data: string;
}

export type StashResult =
  | { acao: "salvar"; salvo: boolean; entrada?: StashEntry; total: number }
  | { acao: "listar"; entradas: StashEntry[]; total: number }
  | { acao: "mostrar"; indice: number; ref: string; diff: string; truncado: boolean; bytes: number; bytesTotal: number; vazio: boolean }
  | { acao: "aplicar" | "pop"; indice: number; ref: string; estado: "aplicado" | "conflito"; arquivos: string[]; mantido: boolean; total: number };

const SEP_FIELD = "\x1f";
const SEP_RECORD = "\x1e";

export async function listStashes(git: GitRunner, root: string): Promise<StashEntry[]> {
  const out = await git(root, ["stash", "list", "--no-color", "--format=%gd%x1f%H%x1f%gs%x1f%aI%x1e"]);
  const entries: StashEntry[] = [];
  for (const rec of out.split(SEP_RECORD)) {
    const text = rec.replace(/^\r?\n/, "");
    if (text.trim() === "") continue;
    const [ref = "", hash = "", descricao = "", data = ""] = text.split(SEP_FIELD);
    const m = /^stash@\{(\d+)\}$/.exec(ref.trim());
    if (!m) continue;
    entries.push({ indice: Number(m[1]), ref: ref.trim(), hash, descricao, data });
  }
  return entries;
}

function stashRef(indice: number): string {
  return `stash@{${indice}}`;
}

export async function gitStash(git: GitRunner, root: string, args: StashArgs): Promise<StashResult> {
  const acao = args.acao;
  if (!(STASH_ACTIONS as readonly string[]).includes(acao)) {
    throw new GuardError(`Ação inválida: ${String(acao)} (use ${STASH_ACTIONS.join(", ")}; drop e clear não existem).`);
  }
  const action = acao as StashAction;
  if (action !== "salvar" && (args.mensagem !== undefined || args.incluirNaoRastreados !== undefined)) {
    throw new GuardError("mensagem e incluir_nao_rastreados só valem com acao=salvar.");
  }
  if ((action === "salvar" || action === "listar") && args.indice !== undefined) {
    throw new GuardError("indice só vale com mostrar, aplicar e pop.");
  }
  if (args.indice !== undefined && (!Number.isInteger(args.indice) || args.indice < 0)) {
    throw new GuardError("indice tem de ser um inteiro maior ou igual a 0.");
  }

  if (action === "salvar") {
    if (args.mensagem !== undefined && (typeof args.mensagem !== "string" || args.mensagem.trim() === "" || args.mensagem.includes("\0"))) {
      throw new GuardError("mensagem inválida.");
    }
    const antes = (await listStashes(git, root)).length;
    const argv = ["stash", "push"];
    if (args.incluirNaoRastreados === true) argv.push("-u");
    rejectForbiddenFlags(argv);
    // the message is its own argument right after -m
    if (args.mensagem !== undefined) argv.push("-m", args.mensagem.replace(/\r\n/g, "\n").trim());
    await git(root, argv);
    const depois = await listStashes(git, root);
    // "No local changes to save" exits with 0 and creates nothing
    if (depois.length === antes) return { acao: "salvar", salvo: false, total: depois.length };
    return { acao: "salvar", salvo: true, entrada: depois[0], total: depois.length };
  }

  const entradas = await listStashes(git, root);
  if (action === "listar") return { acao: "listar", entradas, total: entradas.length };

  const indice = args.indice ?? 0;
  if (indice >= entradas.length) {
    throw new GuardError(entradas.length === 0 ? "Não há nenhum stash." : `Não existe o stash ${indice}: há ${entradas.length} (índices de 0 a ${entradas.length - 1}).`);
  }
  const ref = stashRef(indice);

  if (action === "mostrar") {
    const argv = ["stash", "show", "-p", "--no-color", "--no-ext-diff", ref];
    rejectForbiddenFlags(argv);
    const out = await git(root, argv);
    const cut = cutBytes(out, DIFF_DEFAULT_MAX_BYTES);
    return {
      acao: "mostrar",
      indice,
      ref,
      diff: cut.text,
      truncado: cut.truncado,
      bytes: Buffer.byteLength(cut.text, "utf8"),
      bytesTotal: cut.bytesTotal,
      vazio: out.trim() === "",
    };
  }

  const argv = ["stash", action === "pop" ? "pop" : "apply", ref];
  rejectForbiddenFlags(argv);
  try {
    await git(root, argv);
  } catch (err) {
    if (err instanceof GitError) {
      const arquivos = await conflictedFiles(git, root);
      // with a conflict neither apply nor pop drops the stash
      if (arquivos.length > 0) return { acao: action, indice, ref, estado: "conflito", arquivos, mantido: true, total: (await listStashes(git, root)).length };
    }
    throw err;
  }
  const restantes = (await listStashes(git, root)).length;
  return { acao: action, indice, ref, estado: "aplicado", arquivos: [], mantido: restantes === entradas.length, total: restantes };
}
