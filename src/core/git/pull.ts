// git_pull: `git pull --ff-only` or `git pull --no-rebase --no-edit` (modo merge). Rebase does not
// exist here. In merge mode a conflict leaves the merge in progress and is reported with the list
// of conflicting files.
import { GitError } from "../git-runner";
import { GuardError, assertRefName, assertRefspec, rejectForbiddenFlags } from "../guards";
import type { GitRunner } from "../ports";
import { assertRemoteName, currentBranch, headHash } from "./revision";

export type PullMode = "ff-only" | "merge";

export interface PullArgs {
  remoto?: string;
  branch?: string;
  /** Defaults to ff-only. */
  modo?: PullMode;
}

export type PullResult =
  | {
      conflito: false;
      remoto: string | undefined;
      branch: string | undefined;
      modo: PullMode;
      antes: string | undefined;
      depois: string | undefined;
      /** HEAD moved (new commits arrived). */
      atualizado: boolean;
      commitsNovos: number;
    }
  | {
      conflito: true;
      modo: PullMode;
      /** Files with unresolved conflicts. The merge stays in progress. */
      arquivos: string[];
    };

/** The branches diverged and `--ff-only` cannot join them. */
export class PullNotFastForwardError extends GitError {
  readonly dica = 'As histórias divergiram e o avanço simples (ff-only) não é possível. Use git_pull com modo "merge" para juntar as duas.';
  constructor(source: GitError) {
    super(source.codigo, source.stderr, source.args, source.stdout);
    this.name = "PullNotFastForwardError";
  }
}

const NOT_FF = /not possible to fast-forward|can't be fast-forwarded|cannot fast-forward|diverging branches/i;

async function conflictedFiles(git: GitRunner, root: string): Promise<string[]> {
  try {
    return (await git(root, ["diff", "--name-only", "--diff-filter=U"])).split(/\r?\n/).filter((l) => l.trim() !== "");
  } catch {
    return [];
  }
}

export async function gitPull(git: GitRunner, root: string, args: PullArgs = {}): Promise<PullResult> {
  const modo = args.modo ?? "ff-only";
  if (modo !== "ff-only" && modo !== "merge") throw new GuardError(`modo inválido: ${String(modo)} (use ff-only ou merge; rebase não existe).`);

  let remoto = args.remoto;
  if (remoto === undefined && args.branch !== undefined) remoto = "origin";
  if (remoto !== undefined) remoto = await assertRemoteName(git, root, remoto);
  if (args.branch !== undefined) {
    assertRefspec(args.branch); // refuses "+x" (forced) and ":x"
    await assertRefName(args.branch, { git, cwd: root });
  }

  const argv = modo === "ff-only" ? ["pull", "--ff-only"] : ["pull", "--no-rebase", "--no-edit"];
  if (remoto !== undefined) argv.push(remoto);
  if (args.branch !== undefined) argv.push(args.branch);
  rejectForbiddenFlags(argv);

  const antes = await headHash(git, root);
  try {
    await git(root, argv);
  } catch (err) {
    if (err instanceof GitError) {
      if (modo === "merge") {
        const arquivos = await conflictedFiles(git, root);
        if (arquivos.length > 0) return { conflito: true, modo, arquivos };
      }
      if (NOT_FF.test(`${err.stderr}\n${err.stdout}`)) throw new PullNotFastForwardError(err);
    }
    throw err;
  }

  const depois = await headHash(git, root);
  let commitsNovos = 0;
  if (depois !== undefined && depois !== antes) {
    try {
      commitsNovos = Number((await git(root, ["rev-list", "--count", antes !== undefined ? `${antes}..${depois}` : depois])).trim()) || 0;
    } catch {
      commitsNovos = 0;
    }
  }
  return {
    conflito: false,
    remoto,
    branch: args.branch ?? (await currentBranch(git, root)),
    modo,
    antes,
    depois,
    atualizado: depois !== antes,
    commitsNovos,
  };
}
