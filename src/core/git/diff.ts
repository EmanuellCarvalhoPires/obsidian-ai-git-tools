// git_diff: differences of the working tree, of the stage or between two references.
import { GuardError, assertPathspec, rejectForbiddenFlags } from "../guards";
import type { GitRunner } from "../ports";
import { assertRevision } from "./revision";

export { assertRevision } from "./revision";

export const DIFF_DEFAULT_MAX_BYTES = 200_000;
export const DIFF_HARD_MAX_BYTES = 5_000_000;
export const GIT_DIFF_DEFAULT_MAX_BYTES = 40_000;

export type DiffTarget = "worktree" | "staged" | "refs";

export interface DiffOmitido {
  caminho: string;
  adicionadas: number | null;
  removidas: number | null;
}

export interface DiffArgs {
  alvo: DiffTarget;
  base?: string;
  head?: string;
  caminhos?: string[];
  stat?: boolean;
  contexto?: number;
  maxBytes?: number;
}

export interface DiffResult {
  alvo: DiffTarget;
  base?: string;
  head?: string;
  /** Diff text, cut at max_bytes. */
  diff: string;
  truncado: boolean;
  /** Bytes returned. */
  bytes: number;
  /** Bytes the full diff has. */
  bytesTotal: number;
  vazio: boolean;
  omitidos: DiffOmitido[];
}

/** Cuts text to at most `maxBytes` bytes of UTF-8 without leaving half a character at the end. */
export function cutBytes(text: string, maxBytes: number): { text: string; truncado: boolean; bytesTotal: number } {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= maxBytes) return { text, truncado: false, bytesTotal: buf.length };
  let cut = buf.subarray(0, maxBytes).toString("utf8");
  if (cut.endsWith("\uFFFD")) cut = cut.slice(0, -1);
  return { text: cut, truncado: true, bytesTotal: buf.length };
}

async function omittedFiles(
  git: GitRunner,
  root: string,
  targetArgs: string[],
  pathTail: string[],
  shown: string,
): Promise<DiffOmitido[]> {
  try {
    const out = await git(root, [
      "diff",
      "--no-color",
      "--no-ext-diff",
      "--no-renames",
      "--numstat",
      ...targetArgs,
      ...pathTail,
    ]);
    const shownPaths = new Set<string>();
    const headerRe = /^diff --git a\/(.+?) b\/(.+)\r?\n/gm;
    let match: RegExpExecArray | null;
    while ((match = headerRe.exec(shown)) !== null) {
      shownPaths.add(match[1]);
      shownPaths.add(match[2]);
    }
    const omitidos: DiffOmitido[] = [];
    for (const rawLine of out.split(/\r?\n/)) {
      if (rawLine.trim() === "") continue;
      const firstTab = rawLine.indexOf("\t");
      if (firstTab === -1) continue;
      const secondTab = rawLine.indexOf("\t", firstTab + 1);
      if (secondTab === -1) continue;
      const addsStr = rawLine.slice(0, firstTab);
      const delsStr = rawLine.slice(firstTab + 1, secondTab);
      const caminho = rawLine.slice(secondTab + 1);
      if (!shownPaths.has(caminho)) {
        omitidos.push({
          caminho,
          adicionadas: addsStr === "-" ? null : Number(addsStr),
          removidas: delsStr === "-" ? null : Number(delsStr),
        });
      }
    }
    return omitidos;
  } catch {
    return [];
  }
}

export async function gitDiff(git: GitRunner, root: string, args: DiffArgs): Promise<DiffResult> {
  const maxBytes = args.maxBytes ?? GIT_DIFF_DEFAULT_MAX_BYTES;
  if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > DIFF_HARD_MAX_BYTES) {
    throw new GuardError(`max_bytes tem de ficar entre 1 e ${DIFF_HARD_MAX_BYTES}.`);
  }

  const targetArgs: string[] = [];
  const result: Pick<DiffResult, "alvo" | "base" | "head"> = { alvo: args.alvo };
  if (args.alvo === "worktree") {
    // nothing else: the working tree against the stage
  } else if (args.alvo === "staged") {
    targetArgs.push("--cached");
  } else if (args.alvo === "refs") {
    if (args.base === undefined) throw new GuardError("alvo=refs exige a referência base.");
    const base = assertRevision(args.base);
    const head = assertRevision(args.head ?? "HEAD");
    targetArgs.push(`${base}..${head}`);
    result.base = base;
    result.head = head;
  } else {
    throw new GuardError(`alvo inválido: ${String(args.alvo)} (use worktree, staged ou refs).`);
  }
  if (args.alvo !== "refs" && (args.base !== undefined || args.head !== undefined)) {
    throw new GuardError("base e head só valem com alvo=refs.");
  }

  const argv: string[] = ["diff", "--no-color", "--no-ext-diff"];
  if (args.contexto !== undefined) {
    if (!Number.isInteger(args.contexto) || args.contexto < 0 || args.contexto > 1000) throw new GuardError("contexto tem de ficar entre 0 e 1000.");
    argv.push(`-U${args.contexto}`);
  }
  if (args.stat === true) argv.push("--stat");
  argv.push(...targetArgs);

  rejectForbiddenFlags(argv);

  const pathTail = args.caminhos !== undefined && args.caminhos.length > 0 ? ["--", ...assertPathspec(args.caminhos)] : [];
  argv.push(...pathTail);

  const out = await git(root, argv);
  const limpo = args.stat === true ? out : out.replace(/^index [0-9a-f]{4,}\.\.[0-9a-f]{4,}(?: \d{6})?\r?\n/gm, "");
  const cut = cutBytes(limpo, maxBytes);
  const omitidos = cut.truncado && args.stat !== true ? await omittedFiles(git, root, targetArgs, pathTail, cut.text) : [];

  return {
    ...result,
    diff: cut.text,
    truncado: cut.truncado,
    bytes: Buffer.byteLength(cut.text, "utf8"),
    bytesTotal: cut.bytesTotal,
    vazio: out.trim() === "",
    omitidos,
  };
}
