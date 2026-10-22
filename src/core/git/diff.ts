// git_diff: differences of the working tree, of the stage or between two references.
import { GuardError, assertPathspec, rejectForbiddenFlags } from "../guards";
import type { GitRunner } from "../ports";
import { assertRevision } from "./revision";

export { assertRevision } from "./revision";

export const DIFF_DEFAULT_MAX_BYTES = 200_000;
export const DIFF_HARD_MAX_BYTES = 5_000_000;

export type DiffTarget = "worktree" | "staged" | "refs";

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
}

/** Cuts text to at most `maxBytes` bytes of UTF-8 without leaving half a character at the end. */
export function cutBytes(text: string, maxBytes: number): { text: string; truncado: boolean; bytesTotal: number } {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= maxBytes) return { text, truncado: false, bytesTotal: buf.length };
  let cut = buf.subarray(0, maxBytes).toString("utf8");
  if (cut.endsWith("�")) cut = cut.slice(0, -1);
  return { text: cut, truncado: true, bytesTotal: buf.length };
}

export async function gitDiff(git: GitRunner, root: string, args: DiffArgs): Promise<DiffResult> {
  const maxBytes = args.maxBytes ?? DIFF_DEFAULT_MAX_BYTES;
  if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > DIFF_HARD_MAX_BYTES) {
    throw new GuardError(`max_bytes tem de ficar entre 1 e ${DIFF_HARD_MAX_BYTES}.`);
  }
  const argv: string[] = ["diff", "--no-color", "--no-ext-diff"];
  if (args.contexto !== undefined) {
    if (!Number.isInteger(args.contexto) || args.contexto < 0 || args.contexto > 1000) throw new GuardError("contexto tem de ficar entre 0 e 1000.");
    argv.push(`-U${args.contexto}`);
  }
  if (args.stat === true) argv.push("--stat");

  const result: Pick<DiffResult, "alvo" | "base" | "head"> = { alvo: args.alvo };
  if (args.alvo === "worktree") {
    // nothing else: the working tree against the stage
  } else if (args.alvo === "staged") {
    argv.push("--cached");
  } else if (args.alvo === "refs") {
    if (args.base === undefined) throw new GuardError("alvo=refs exige a referência base.");
    const base = assertRevision(args.base);
    const head = assertRevision(args.head ?? "HEAD");
    argv.push(`${base}..${head}`);
    result.base = base;
    result.head = head;
  } else {
    throw new GuardError(`alvo inválido: ${String(args.alvo)} (use worktree, staged ou refs).`);
  }
  if (args.alvo !== "refs" && (args.base !== undefined || args.head !== undefined)) {
    throw new GuardError("base e head só valem com alvo=refs.");
  }
  rejectForbiddenFlags(argv);
  if (args.caminhos !== undefined && args.caminhos.length > 0) argv.push("--", ...assertPathspec(args.caminhos));

  const out = await git(root, argv);
  const cut = cutBytes(out, maxBytes);
  return {
    ...result,
    diff: cut.text,
    truncado: cut.truncado,
    bytes: Buffer.byteLength(cut.text, "utf8"),
    bytesTotal: cut.bytesTotal,
    vazio: out.trim() === "",
  };
}
