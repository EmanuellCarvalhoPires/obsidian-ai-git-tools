// git_branches: local branches (and the remote ones) with upstream, ahead/behind and last commit.
import { GitError } from "../git-runner";
import { rejectForbiddenFlags } from "../guards";
import type { GitRunner } from "../ports";
import { assertRevision } from "./diff";

const FIELD = "\x1f";
const RECORD = "\x1e";
// for-each-ref reads %xx as the character with that hexadecimal code.
const FORMAT = "%(refname)%1f%(refname:short)%1f%(objectname)%1f%(upstream:short)%1f%(upstream:track)%1f%(HEAD)%1f%(committerdate:iso-strict)%1f%(contents:subject)%1e";

export interface BranchInfo {
  /** Short name (`main`, `origin/main`). */
  nome: string;
  hash: string;
  upstream: string | undefined;
  ahead: number;
  behind: number;
  /** The upstream branch no longer exists on the remote. */
  upstream_sumiu: boolean;
  /** True for the branch checked out now. */
  atual: boolean;
  /** Date of the last commit, ISO 8601. */
  data: string;
  assunto: string;
}

export interface RemoteHeads {
  remoto: string;
  /** False when the `ls-remote` call failed (no network, no permission); the tool still answers. */
  ok: boolean;
  erro?: string;
  branches: { nome: string; hash: string }[];
}

export interface BranchesArgs {
  remotas?: boolean;
  mescladasEm?: string;
}

export interface BranchesResult {
  atual: string | undefined;
  locais: BranchInfo[];
  /** Remote tracking branches (only with `remotas`). */
  remotas?: BranchInfo[];
  /** Live read of the remote (only with `remotas`). */
  remotoVivo?: RemoteHeads;
}

/** Parses the output of `git for-each-ref --format=<FORMAT>`. Entries `<remote>/HEAD` are skipped. */
export function parseBranches(raw: string): BranchInfo[] {
  const out: BranchInfo[] = [];
  for (const chunk of raw.split(RECORD)) {
    const text = chunk.replace(/^\r?\n/, "");
    if (text.trim() === "") continue;
    const p = text.split(FIELD);
    const refname = p[0] ?? "";
    if (refname.endsWith("/HEAD")) continue;
    const track = p[4] ?? "";
    const ahead = /ahead (\d+)/.exec(track);
    const behind = /behind (\d+)/.exec(track);
    const upstream = p[3] ?? "";
    out.push({
      nome: p[1] ?? "",
      hash: p[2] ?? "",
      upstream: upstream === "" ? undefined : upstream,
      ahead: ahead ? Number(ahead[1]) : 0,
      behind: behind ? Number(behind[1]) : 0,
      upstream_sumiu: /gone/.test(track),
      atual: (p[5] ?? "").trim() === "*",
      data: p[6] ?? "",
      assunto: p[7] ?? "",
    });
  }
  return out;
}

/** Parses `git ls-remote --heads`: `<hash>\trefs/heads/<name>`. */
export function parseLsRemote(raw: string): { nome: string; hash: string }[] {
  const out: { nome: string; hash: string }[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const m = /^([0-9a-f]{40,64})\trefs\/heads\/(.+)$/.exec(line.trim());
    if (m) out.push({ hash: m[1] ?? "", nome: m[2] ?? "" });
  }
  return out;
}

async function remoteName(git: GitRunner, root: string): Promise<string | undefined> {
  const names = (await git(root, ["remote"])).split(/\r?\n/).map((s) => s.trim()).filter((s) => s !== "");
  return names.includes("origin") ? "origin" : names[0];
}

export async function gitBranches(git: GitRunner, root: string, args: BranchesArgs): Promise<BranchesResult> {
  const merged = args.mescladasEm !== undefined ? [`--merged=${assertRevision(args.mescladasEm)}`] : [];
  const base = ["for-each-ref", `--format=${FORMAT}`, "--sort=-committerdate", ...merged];
  rejectForbiddenFlags(base);

  const locais = parseBranches(await git(root, [...base, "refs/heads"]));
  const result: BranchesResult = { atual: locais.find((b) => b.atual)?.nome, locais };
  if (args.remotas !== true) return result;

  result.remotas = parseBranches(await git(root, [...base, "refs/remotes"]));
  const remoto = await remoteName(git, root).catch(() => undefined);
  if (remoto === undefined || remoto.startsWith("-")) {
    result.remotoVivo = { remoto: "", ok: false, erro: "O repositório não tem remoto configurado.", branches: [] };
    return result;
  }
  try {
    const heads = parseLsRemote(await git(root, ["ls-remote", "--heads", remoto], { timeoutMs: 30_000 }));
    result.remotoVivo = { remoto, ok: true, branches: heads };
  } catch (err) {
    const erro = err instanceof GitError ? err.stderr || err.message : err instanceof Error ? err.message : String(err);
    result.remotoVivo = { remoto, ok: false, erro, branches: [] };
  }
  return result;
}
