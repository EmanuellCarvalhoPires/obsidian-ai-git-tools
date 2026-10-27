// git_log: history of commits, or the full data of one commit.
import { GitError } from "../git-runner";
import { GuardError, assertPathspec, rejectForbiddenFlags } from "../guards";
import type { GitRunner } from "../ports";
import { assertRevision } from "./diff";

export const LOG_DEFAULT_LIMIT = 10;
export const LOG_MAX_LIMIT = 200;

const FIELD = "\x1f";
const RECORD = "\x1e";
const LOG_FORMAT = "%H%x1f%an%x1f%ae%x1f%aI%x1f%s%x1f%P%x1e";
/** Same fields plus the body of the message, for one commit. */
const SHOW_FORMAT = "%H%x1f%an%x1f%ae%x1f%aI%x1f%s%x1f%P%x1f%b%x1e";

export interface CommitInfo {
  hash: string;
  hashCurto: string;
  autor: string;
  email: string;
  /** Author date, ISO 8601. */
  data: string;
  /** First line of the message. */
  assunto: string;
  pais: string[];
  /** Rest of the message; only with `hash`. */
  corpo?: string;
}

export interface LogArgs {
  ref?: string;
  limite?: number;
  desde?: string;
  ate?: string;
  autor?: string;
  caminho?: string;
  intervalo?: string;
  hash?: string;
}

export interface LogResult {
  commits: CommitInfo[];
  limite: number;
  /** True when the limit was reached and the history may have more commits. */
  podeHaverMais: boolean;
  /** Output of `--stat` of a single commit (only with `hash`). */
  estatistica?: string;
}

function parseRecord(chunk: string): CommitInfo | undefined {
  const parts = chunk.replace(/^\r?\n/, "").split(FIELD);
  const hash = parts[0] ?? "";
  if (!/^[0-9a-f]{7,64}$/i.test(hash)) return undefined;
  const info: CommitInfo = {
    hash,
    hashCurto: hash.slice(0, 7),
    autor: parts[1] ?? "",
    email: parts[2] ?? "",
    data: parts[3] ?? "",
    assunto: parts[4] ?? "",
    pais: (parts[5] ?? "").split(" ").filter((p) => p !== ""),
  };
  if (parts.length > 6) info.corpo = parts.slice(6).join(FIELD).trim();
  return info;
}

/** Parses the output of `git log --format=<LOG_FORMAT>`. */
export function parseLog(raw: string): CommitInfo[] {
  const out: CommitInfo[] = [];
  for (const chunk of raw.split(RECORD)) {
    if (chunk.trim() === "") continue;
    const info = parseRecord(chunk);
    if (info) out.push(info);
  }
  return out;
}

/** `a..b`, `a...b`, `..b`, `a..`: every side that is present has to be a valid revision. */
function checkRange(range: string): string {
  // A ref name cannot contain "..", so the first one is the separator.
  const at = range.indexOf("..");
  if (at < 0) throw new GuardError(`Intervalo inválido (use a..b ou a...b): ${range}`);
  const left = range.slice(0, at);
  let right = range.slice(at + 2);
  if (right.startsWith(".")) right = right.slice(1);
  if (left === "" && right === "") throw new GuardError(`Intervalo inválido: ${range}`);
  for (const side of [left, right]) if (side !== "") assertRevision(side);
  return range;
}

export async function gitLog(git: GitRunner, root: string, args: LogArgs): Promise<LogResult> {
  if (args.hash !== undefined) return showCommit(git, root, args.hash);

  const limite = args.limite ?? LOG_DEFAULT_LIMIT;
  if (!Number.isInteger(limite) || limite < 1 || limite > LOG_MAX_LIMIT) throw new GuardError(`limite tem de ficar entre 1 e ${LOG_MAX_LIMIT}.`);
  if (args.ref !== undefined && args.intervalo !== undefined) throw new GuardError("Use ref ou intervalo, não os dois.");

  const argv: string[] = ["log", `--format=${LOG_FORMAT}`, `--max-count=${limite}`];
  if (args.desde !== undefined) argv.push(`--since=${args.desde}`);
  if (args.ate !== undefined) argv.push(`--until=${args.ate}`);
  if (args.autor !== undefined) argv.push(`--author=${args.autor}`);
  if (args.intervalo !== undefined) argv.push(checkRange(args.intervalo));
  else if (args.ref !== undefined) argv.push(assertRevision(args.ref));
  rejectForbiddenFlags(argv);
  if (args.caminho !== undefined) argv.push("--", ...assertPathspec([args.caminho]));

  let raw: string;
  try {
    raw = await git(root, argv);
  } catch (err) {
    // A repository without commits has an empty history, not an error.
    if (err instanceof GitError && /does not have any commits yet/i.test(err.stderr)) {
      return { commits: [], limite, podeHaverMais: false };
    }
    throw err;
  }
  const commits = parseLog(raw);
  return { commits, limite, podeHaverMais: commits.length >= limite };
}

async function showCommit(git: GitRunner, root: string, hash: string): Promise<LogResult> {
  const rev = assertRevision(hash);
  const argv = ["show", "--stat", `--format=${SHOW_FORMAT}`, rev, "--"];
  rejectForbiddenFlags(argv);
  const raw = await git(root, argv);
  const at = raw.indexOf(RECORD);
  const info = at >= 0 ? parseRecord(raw.slice(0, at)) : undefined;
  if (!info) throw new GuardError(`Commit não encontrado: ${hash}`);
  return { commits: [info], limite: 1, podeHaverMais: false, estatistica: raw.slice(at + 1).trim() };
}
