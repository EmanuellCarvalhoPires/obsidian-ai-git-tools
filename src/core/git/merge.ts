// git_merge: `git merge --no-edit [--no-ff] [-m msg] <origem>`. A conflict leaves the merge in
// progress and is reported with the list of conflicting files. `abortar` runs `git merge --abort`
// and only when a merge is really in progress (MERGE_HEAD exists).
import { GitError } from "../git-runner";
import { GuardError, rejectForbiddenFlags } from "../guards";
import type { GitRunner } from "../ports";
import { assertRevision, currentBranch, headHash } from "./revision";

export interface MergeArgs {
  /** Branch, tag or hash to merge into the current branch. Not allowed with `abortar`. */
  origem?: string;
  mensagem?: string;
  /** Always create a merge commit (`--no-ff`). */
  semFf?: boolean;
  /** Undo the merge in progress (`merge --abort`). */
  abortar?: boolean;
}

export type MergeResult =
  | { estado: "abortado"; branch: string | undefined; hash: string | undefined }
  | { estado: "conflito"; origem: string; arquivos: string[] }
  | {
      estado: "mesclado";
      origem: string;
      branch: string | undefined;
      hash: string;
      hashCurto: string;
      antes: string | undefined;
      fastForward: boolean;
      /** HEAD did not move: the origin was already part of the branch. */
      jaAtualizado: boolean;
    };

/** True when the special ref (MERGE_HEAD, REVERT_HEAD) exists, i.e. that operation is in progress. */
export async function hasSpecialHead(git: GitRunner, root: string, name: "MERGE_HEAD" | "REVERT_HEAD"): Promise<boolean> {
  try {
    await git(root, ["rev-parse", "-q", "--verify", name]);
    return true;
  } catch (err) {
    if (err instanceof GitError && err.codigo === 1) return false;
    throw err;
  }
}

/** Files with unresolved conflicts (`diff --name-only --diff-filter=U`). */
export async function conflictedFiles(git: GitRunner, root: string): Promise<string[]> {
  try {
    return (await git(root, ["diff", "--name-only", "--diff-filter=U"])).split(/\r?\n/).filter((l) => l.trim() !== "");
  } catch {
    return [];
  }
}

/** Number of parents of HEAD (2 or more means a merge commit). */
async function headParents(git: GitRunner, root: string): Promise<number> {
  const line = (await git(root, ["rev-list", "--parents", "-n", "1", "HEAD"])).trim();
  return Math.max(0, line.split(/\s+/).length - 1);
}

export async function gitMerge(git: GitRunner, root: string, args: MergeArgs): Promise<MergeResult> {
  const abortar = args.abortar === true;
  if (abortar) {
    if (args.origem !== undefined || args.mensagem !== undefined || args.semFf !== undefined) {
      throw new GuardError("abortar não pode ser usado junto com origem, mensagem ou sem_ff.");
    }
    if (!(await hasSpecialHead(git, root, "MERGE_HEAD"))) {
      throw new GuardError("Não há merge em andamento para abortar (MERGE_HEAD não existe).");
    }
    const argv = ["merge", "--abort"];
    rejectForbiddenFlags(argv);
    await git(root, argv);
    return { estado: "abortado", branch: await currentBranch(git, root), hash: await headHash(git, root) };
  }

  if (typeof args.origem !== "string" || args.origem.trim() === "") throw new GuardError('"origem" é obrigatória (ou use abortar=true).');
  const origem = assertRevision(args.origem);
  if (args.mensagem !== undefined && (typeof args.mensagem !== "string" || args.mensagem.trim() === "" || args.mensagem.includes("\0"))) {
    throw new GuardError("mensagem inválida.");
  }
  if (await hasSpecialHead(git, root, "MERGE_HEAD")) {
    throw new GuardError("Já existe um merge em andamento: resolva os conflitos e conclua com git_commit, ou use abortar=true.");
  }

  const argv = ["merge", "--no-edit"];
  if (args.semFf === true) argv.push("--no-ff");
  rejectForbiddenFlags(argv);
  // the message is its own argument right after -m, never glued to the flag
  if (args.mensagem !== undefined) argv.push("-m", args.mensagem.replace(/\r\n/g, "\n").trim());
  argv.push(origem);

  const antes = await headHash(git, root);
  try {
    await git(root, argv);
  } catch (err) {
    if (err instanceof GitError) {
      const arquivos = await conflictedFiles(git, root);
      if (arquivos.length > 0 || (await hasSpecialHead(git, root, "MERGE_HEAD"))) {
        return { estado: "conflito", origem, arquivos };
      }
    }
    throw err;
  }

  const hash = (await headHash(git, root)) ?? "";
  const jaAtualizado = hash === antes;
  const fastForward = !jaAtualizado && (await headParents(git, root)) < 2;
  return { estado: "mesclado", origem, branch: await currentBranch(git, root), hash, hashCurto: hash.slice(0, 7), antes, fastForward, jaAtualizado };
}
