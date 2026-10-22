// git_status: `git status --porcelain=v2 --branch -z` and its parser.
import type { GitRunner } from "../ports";

export interface StatusEntry {
  /** Path relative to the repository root. */
  caminho: string;
  /** Status letter of git: M, A, D, R, C or T. */
  status: string;
  /** Status in Portuguese. */
  rotulo: string;
  /** Original path of a renamed or copied file. */
  origem?: string;
}

export interface StatusResult {
  /** Current branch; undefined with a detached HEAD. */
  branch: string | undefined;
  /** Commit of HEAD; undefined in a repository without commits. */
  oid: string | undefined;
  upstream: string | undefined;
  ahead: number;
  behind: number;
  staged: StatusEntry[];
  unstaged: StatusEntry[];
  untracked: string[];
  conflitos: string[];
  limpo: boolean;
}

const LABELS: Record<string, string> = {
  M: "modificado",
  A: "adicionado",
  D: "removido",
  R: "renomeado",
  C: "copiado",
  T: "tipo alterado",
};

function entry(code: string, caminho: string, origem?: string): StatusEntry {
  const e: StatusEntry = { caminho, status: code, rotulo: LABELS[code] ?? code };
  if (origem !== undefined) e.origem = origem;
  return e;
}

/** Splits a record of the porcelain v2 format into `n` space separated fields; the rest is the path. */
function fields(line: string, n: number): { head: string[]; path: string } {
  const head: string[] = [];
  let rest = line;
  for (let i = 0; i < n; i++) {
    const at = rest.indexOf(" ");
    if (at < 0) return { head, path: rest };
    head.push(rest.slice(0, at));
    rest = rest.slice(at + 1);
  }
  return { head, path: rest };
}

function addXY(result: StatusResult, xy: string, path: string, orig?: string): void {
  const x = xy[0] ?? ".";
  const y = xy[1] ?? ".";
  if (x !== ".") result.staged.push(entry(x, path, orig));
  if (y !== ".") result.unstaged.push(entry(y, path, orig));
}

/** Parses the output of `git status --porcelain=v2 --branch -z`. */
export function parseStatus(raw: string): StatusResult {
  const result: StatusResult = {
    branch: undefined,
    oid: undefined,
    upstream: undefined,
    ahead: 0,
    behind: 0,
    staged: [],
    unstaged: [],
    untracked: [],
    conflitos: [],
    limpo: true,
  };
  const records = raw.split("\0");
  for (let i = 0; i < records.length; i++) {
    const rec = records[i] ?? "";
    if (rec === "") continue;
    if (rec.startsWith("# ")) {
      const [key, ...rest] = rec.slice(2).split(" ");
      const value = rest.join(" ");
      if (key === "branch.oid") result.oid = value === "(initial)" ? undefined : value;
      else if (key === "branch.head") result.branch = value === "(detached)" ? undefined : value;
      else if (key === "branch.upstream") result.upstream = value;
      else if (key === "branch.ab") {
        const m = /^\+(\d+) -(\d+)$/.exec(value);
        if (m) {
          result.ahead = Number(m[1]);
          result.behind = Number(m[2]);
        }
      }
      continue;
    }
    const kind = rec[0];
    if (kind === "1") {
      // 1 XY sub mH mI mW hH hI path
      const { head, path } = fields(rec, 8);
      addXY(result, head[1] ?? "..", path);
    } else if (kind === "2") {
      // 2 XY sub mH mI mW hH hI Xscore path <NUL> origPath
      const { head, path } = fields(rec, 9);
      const orig = records[++i] ?? "";
      addXY(result, head[1] ?? "..", path, orig);
    } else if (kind === "u") {
      // u XY sub m1 m2 m3 mW h1 h2 h3 path
      const { path } = fields(rec, 10);
      result.conflitos.push(path);
    } else if (kind === "?") {
      result.untracked.push(rec.slice(2));
    }
  }
  result.limpo = result.staged.length + result.unstaged.length + result.untracked.length + result.conflitos.length === 0;
  return result;
}

export async function gitStatus(git: GitRunner, root: string): Promise<StatusResult> {
  return parseStatus(await git(root, ["status", "--porcelain=v2", "--branch", "-z"]));
}
