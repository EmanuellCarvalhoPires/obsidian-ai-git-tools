// git_push: `git push [-u] <remote> refs/heads/<branch>` or `git push <remote> refs/tags/<tag>`.
// Never forces and never deletes: the refspec has no `+`, no empty side and no `:`. A rejection
// because the remote is ahead (non-fast-forward) is reported with the hint to use git_pull.
import { GitError } from "../git-runner";
import { GuardError, assertRefName, assertRefNameSyntax, assertRefspec, rejectForbiddenFlags } from "../guards";
import type { GitRunner } from "../ports";
import { assertRemoteName, currentBranch, refExists } from "./revision";

export interface PushArgs {
  /** Defaults to origin. */
  remoto?: string;
  /** Defaults to the current branch. Not together with `tag`. */
  branch?: string;
  definirUpstream?: boolean;
  /** Pushes this tag instead of a branch. */
  tag?: string;
}

export interface PushResult {
  remoto: string;
  /** Branch that was pushed; undefined when a tag was. */
  branch: string | undefined;
  tag: string | undefined;
  /** Commit at the tip of the pushed branch (or the commit of the tag). */
  hash: string;
  /** True when the branch did not exist on the remote (`[new branch]`). */
  branchNova: boolean;
  /** True when the tag did not exist on the remote. */
  tagNova: boolean;
  /** Nothing to send: the remote already had everything. */
  emDia: boolean;
  upstreamDefinido: boolean;
  /** Lines of `git push --porcelain`, for the record. */
  resumo: string[];
}

/** The remote refused because it is ahead (non-fast-forward). Other refusals (hooks, permissions) stay plain GitError. */
export class PushRejectedError extends GitError {
  readonly dica = "O remoto tem commits que a branch local não tem. Use git_pull (modo ff-only ou merge), resolva o que for preciso e tente o push de novo. O push nunca é forçado.";
  constructor(source: GitError) {
    super(source.codigo, source.stderr, source.args, source.stdout);
    this.name = "PushRejectedError";
  }
}

const REJECTED = /non-fast-forward|fetch first|tip of your current branch is behind/i;

/** One line of `--porcelain`: `<flag>\t<from>:<to>\t<summary>`. Flags: ` ` ok, `*` new, `=` up to date, `!` rejected, `-` deleted. */
function porcelainLines(out: string): { flag: string; ref: string; resumo: string }[] {
  const lines: { flag: string; ref: string; resumo: string }[] = [];
  for (const line of out.split(/\r?\n/)) {
    if (line.startsWith("To ") || line === "Done" || line.trim() === "") continue;
    const parts = line.split("\t");
    if (parts.length < 2) continue;
    lines.push({ flag: parts[0] ?? " ", ref: parts[1] ?? "", resumo: parts.slice(2).join("\t") });
  }
  return lines;
}

export async function gitPush(git: GitRunner, root: string, args: PushArgs = {}): Promise<PushResult> {
  const tag = args.tag;
  if (tag !== undefined && args.branch !== undefined) throw new GuardError("Informe branch OU tag, não os dois.");
  if (tag !== undefined && args.definirUpstream === true) throw new GuardError("definir_upstream não vale para tag.");

  let refspec: string;
  let branch: string | undefined;
  let hashRef: string;
  if (tag !== undefined) {
    // syntax before any git call; `+x` and `:x` are refused by assertRefspec first
    assertRefspec(tag);
    assertRefNameSyntax(tag);
    refspec = `refs/tags/${tag}`;
    assertRefspec(refspec);
    hashRef = `${refspec}^{commit}`;
  } else if (args.branch !== undefined) {
    assertRefspec(args.branch);
    assertRefNameSyntax(args.branch);
    branch = args.branch;
    refspec = `refs/heads/${branch}`;
    assertRefspec(refspec);
    hashRef = refspec;
  } else {
    // current branch: the name comes from git, still validated
    branch = await currentBranch(git, root);
    if (branch === undefined) throw new GuardError("HEAD solto (sem branch atual): informe a branch a enviar.");
    assertRefspec(branch);
    refspec = `refs/heads/${branch}`;
    assertRefspec(refspec);
    hashRef = refspec;
  }

  const remoto = await assertRemoteName(git, root, args.remoto ?? "origin");
  if (tag !== undefined) {
    try {
      await git(root, ["check-ref-format", refspec]);
    } catch {
      throw new GuardError(`Nome de tag recusado pelo git: ${tag}`);
    }
    if (!(await refExists(git, root, refspec))) throw new GuardError(`A tag "${tag}" não existe no repositório local.`);
  } else if (branch !== undefined) {
    await assertRefName(branch, { git, cwd: root });
    if (!(await refExists(git, root, refspec))) throw new GuardError(`A branch "${branch}" não existe no repositório local.`);
  }

  const argv = ["push", "--porcelain"];
  const upstream = args.definirUpstream === true && tag === undefined;
  if (upstream) argv.push("-u");
  argv.push(remoto, refspec);
  rejectForbiddenFlags(argv);

  let out: string;
  try {
    out = await git(root, argv);
  } catch (err) {
    if (err instanceof GitError && REJECTED.test(`${err.stderr}\n${err.stdout}`)) throw new PushRejectedError(err);
    throw err;
  }

  const hash = (await git(root, ["rev-parse", hashRef])).trim();
  const lines = porcelainLines(out);
  const mine = lines.filter((l) => l.ref.startsWith(`${refspec}:`));
  const isNew = mine.some((l) => l.flag === "*");
  const upToDate = mine.length > 0 && mine.every((l) => l.flag === "=");
  return {
    remoto,
    branch,
    tag,
    hash,
    branchNova: tag === undefined && isNew,
    tagNova: tag !== undefined && isNew,
    emDia: upToDate,
    upstreamDefinido: upstream,
    resumo: lines.map((l) => `${l.flag}\t${l.ref}\t${l.resumo}`.trimEnd()),
  };
}
