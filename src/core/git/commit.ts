// git_commit: `git commit -F -` (the message goes through stdin, never through the command line).
// Never --amend, never --no-verify: a failing pre-commit hook is reported, not skipped.
import { GitError } from "../git-runner";
import { GuardError, rejectForbiddenFlags } from "../guards";
import type { GitRunner } from "../ports";
import { currentBranch } from "./revision";

export interface CommitArgs {
  mensagem: string;
  descricao?: string;
  permitirVazio?: boolean;
}

export type CommitResult =
  | { criado: false; motivo: "nada_a_commitar" }
  | {
      criado: true;
      hash: string;
      branch: string | undefined;
      titulo: string;
      /** Full message as written in the commit. */
      mensagem: string;
      arquivos: string[];
      /** `git show --stat` of the commit. */
      estatistica: string;
    };

/** Title, blank line and description. The message itself may already have several lines. */
export function buildMessage(mensagem: string, descricao?: string): string {
  if (typeof mensagem !== "string" || mensagem.trim() === "") throw new GuardError("A mensagem do commit é obrigatória.");
  if (mensagem.includes("\0") || (descricao ?? "").includes("\0")) throw new GuardError("A mensagem não pode ter caractere nulo.");
  const head = mensagem.replace(/\r\n/g, "\n").trim();
  const desc = (descricao ?? "").replace(/\r\n/g, "\n").trim();
  return desc === "" ? `${head}\n` : `${head}\n\n${desc}\n`;
}

/** True when the stage has nothing to commit (`diff --cached --quiet` exits 0). */
async function stageIsEmpty(git: GitRunner, root: string): Promise<boolean> {
  try {
    await git(root, ["diff", "--cached", "--quiet"]);
    return true;
  } catch (err) {
    if (err instanceof GitError && err.codigo === 1) return false; // there are differences
    throw err;
  }
}

async function mergeInProgress(git: GitRunner, root: string): Promise<boolean> {
  try {
    await git(root, ["rev-parse", "-q", "--verify", "MERGE_HEAD"]);
    return true;
  } catch (err) {
    if (err instanceof GitError && err.codigo === 1) return false;
    throw err;
  }
}

export async function gitCommit(git: GitRunner, root: string, args: CommitArgs): Promise<CommitResult> {
  const message = buildMessage(args.mensagem, args.descricao);
  const allowEmpty = args.permitirVazio === true;

  // A merge being concluded may have an empty stage compared to HEAD: that commit is legitimate.
  if (!allowEmpty && (await stageIsEmpty(git, root)) && !(await mergeInProgress(git, root))) {
    return { criado: false, motivo: "nada_a_commitar" };
  }

  const argv = ["commit", "-F", "-", "--cleanup=whitespace"];
  if (allowEmpty) argv.push("--allow-empty");
  rejectForbiddenFlags(argv);
  try {
    await git(root, argv, { input: message });
  } catch (err) {
    if (err instanceof GitError) {
      // hooks (pre-commit, commit-msg) usually explain themselves on stdout or stderr
      const detail = [err.stderr, err.stdout].filter((t) => t.trim() !== "").join("\n");
      throw new GitError(err.codigo, detail, err.args, err.stdout);
    }
    throw err;
  }

  const hash = (await git(root, ["rev-parse", "HEAD"])).trim();
  const estatistica = (await git(root, ["show", "--stat=200", "--format=", hash])).trim();
  const arquivos = (await git(root, ["show", "--name-only", "--format=", "-z", hash])).split("\0").filter((p) => p !== "");
  return {
    criado: true,
    hash,
    branch: await currentBranch(git, root),
    titulo: message.split("\n")[0] ?? "",
    mensagem: message.trimEnd(),
    arquivos,
    estatistica,
  };
}
