// Small helpers shared by the git functions: revision validation, remote names, current branch.
import { GitError } from "../git-runner";
import { GuardError, assertRefNameSyntax } from "../guards";
import type { GitRunner } from "../ports";

/**
 * Validates a revision expression typed by a user: a branch, tag or hash, optionally followed by
 * `~N` and `^N` steps (`HEAD~2`, `main^`). Anything git would read as an option or as a special
 * syntax (`:path`, `@{...}`, `..`) is refused. Shared by the log, blame, branches and checkout
 * functions (diff.ts re-exports it).
 */
export function assertRevision(rev: string): string {
  if (typeof rev !== "string" || rev.trim() === "") throw new GuardError("Referência vazia.");
  const base = rev.replace(/(?:[~^]\d*)+$/, "");
  if (base === "") throw new GuardError(`Referência inválida: ${rev}`);
  assertRefNameSyntax(base);
  return rev;
}

const REMOTE_NAME = /^[A-Za-z0-9._][A-Za-z0-9._-]*$/;

/** Static check of a remote name: a simple name, never an URL, a path or an option. */
export function assertRemoteSyntax(name: string): string {
  if (typeof name !== "string" || name === "") throw new GuardError("Nome de remoto vazio.");
  if (name.length > 100 || !REMOTE_NAME.test(name)) throw new GuardError(`Nome de remoto inválido: ${name} (use só o nome, como origin).`);
  return name;
}

/** Names of the remotes of the repository (`git remote`). */
export async function listRemotes(git: GitRunner, root: string): Promise<string[]> {
  return (await git(root, ["remote"]))
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== "");
}

/** Validates the remote name and checks that the repository has a remote with that name. */
export async function assertRemoteName(git: GitRunner, root: string, name: string): Promise<string> {
  assertRemoteSyntax(name);
  const remotes = await listRemotes(git, root);
  if (!remotes.includes(name)) {
    throw new GuardError(`O repositório não tem o remoto "${name}".${remotes.length > 0 ? ` Remotos existentes: ${remotes.join(", ")}.` : " Nenhum remoto configurado."}`);
  }
  return name;
}

/** Current branch, or undefined with a detached HEAD. */
export async function currentBranch(git: GitRunner, root: string): Promise<string | undefined> {
  try {
    const name = (await git(root, ["symbolic-ref", "--short", "-q", "HEAD"])).trim();
    return name === "" ? undefined : name;
  } catch (err) {
    // `symbolic-ref -q` exits with 1 when HEAD is not a symbolic ref
    if (err instanceof GitError && err.codigo === 1) return undefined;
    throw err;
  }
}

/** Hash of HEAD, or undefined in a repository without commits. */
export async function headHash(git: GitRunner, root: string): Promise<string | undefined> {
  try {
    return (await git(root, ["rev-parse", "--verify", "-q", "HEAD"])).trim() || undefined;
  } catch (err) {
    if (err instanceof GitError && err.codigo === 1) return undefined;
    throw err;
  }
}

/** True when `ref` (a full name such as refs/heads/x) exists. */
export async function refExists(git: GitRunner, root: string, ref: string): Promise<boolean> {
  try {
    await git(root, ["show-ref", "--verify", "--quiet", ref]);
    return true;
  } catch (err) {
    if (err instanceof GitError && err.codigo === 1) return false;
    throw err;
  }
}
