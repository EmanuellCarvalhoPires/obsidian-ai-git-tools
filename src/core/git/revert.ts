// git_revert: `git revert --no-edit [-m N] <commit>`. A conflict leaves the revert in progress and
// is reported with the list of files. `abortar` runs `git revert --abort` and only when a revert
// is in progress (REVERT_HEAD exists).
import { GitError } from "../git-runner";
import { GuardError, rejectForbiddenFlags } from "../guards";
import type { GitRunner } from "../ports";
import { conflictedFiles, hasSpecialHead } from "./merge";
import { assertRevision, currentBranch, headHash } from "./revision";

export interface RevertArgs {
  commit?: string;
  /** Mainline parent when the commit is a merge (`-m N`), integer >= 1. */
  mergePai?: number;
  abortar?: boolean;
}

export type RevertResult =
  | { estado: "abortado"; branch: string | undefined; hash: string | undefined }
  | { estado: "conflito"; commit: string; arquivos: string[] }
  | { estado: "revertido"; commit: string; branch: string | undefined; hash: string; hashCurto: string; titulo: string };

/** Revert of a merge commit without `-m`: git refuses and the tool explains how to choose the parent. */
export class RevertMergeError extends GitError {
  readonly dica = "O commit é um merge: informe merge_pai (1 é o lado da branch em que o merge foi feito, 2 é o da branch mesclada).";
  constructor(source: GitError) {
    super(source.codigo, source.stderr, source.args, source.stdout);
    this.name = "RevertMergeError";
  }
}

export async function gitRevert(git: GitRunner, root: string, args: RevertArgs): Promise<RevertResult> {
  if (args.abortar === true) {
    if (args.commit !== undefined || args.mergePai !== undefined) throw new GuardError("abortar não pode ser usado junto com commit ou merge_pai.");
    if (!(await hasSpecialHead(git, root, "REVERT_HEAD"))) {
      throw new GuardError("Não há revert em andamento para abortar (REVERT_HEAD não existe).");
    }
    const argv = ["revert", "--abort"];
    rejectForbiddenFlags(argv);
    await git(root, argv);
    return { estado: "abortado", branch: await currentBranch(git, root), hash: await headHash(git, root) };
  }

  if (typeof args.commit !== "string" || args.commit.trim() === "") throw new GuardError('"commit" é obrigatório (ou use abortar=true).');
  const commit = assertRevision(args.commit);
  if (args.mergePai !== undefined && (!Number.isInteger(args.mergePai) || args.mergePai < 1)) {
    throw new GuardError("merge_pai tem de ser um inteiro maior ou igual a 1.");
  }
  if (await hasSpecialHead(git, root, "REVERT_HEAD")) {
    throw new GuardError("Já existe um revert em andamento: resolva os conflitos e conclua com git_commit, ou use abortar=true.");
  }

  const argv = ["revert", "--no-edit"];
  if (args.mergePai !== undefined) argv.push("-m", String(args.mergePai));
  argv.push(commit);
  rejectForbiddenFlags(argv);
  try {
    await git(root, argv);
  } catch (err) {
    if (err instanceof GitError) {
      const arquivos = await conflictedFiles(git, root);
      if (arquivos.length > 0 || (await hasSpecialHead(git, root, "REVERT_HEAD"))) return { estado: "conflito", commit, arquivos };
      if (/is a merge but no -m option/i.test(`${err.stderr}\n${err.stdout}`)) throw new RevertMergeError(err);
    }
    throw err;
  }

  const hash = (await headHash(git, root)) ?? "";
  const titulo = (await git(root, ["log", "-1", "--format=%s", hash])).trim();
  return { estado: "revertido", commit, branch: await currentBranch(git, root), hash, hashCurto: hash.slice(0, 7), titulo };
}
