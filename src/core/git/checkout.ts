// git_checkout: `git switch <branch>` or `git switch -c <branch> <base>`. Never forces and never
// discards local changes (no -f, no --discard-changes): if the switch would lose work, git refuses.
import { GuardError, assertRefName, rejectForbiddenFlags } from "../guards";
import type { GitRunner } from "../ports";
import { assertRevision, currentBranch, headHash } from "./revision";

export interface CheckoutArgs {
  branch: string;
  criar?: boolean;
  base?: string;
}

export interface CheckoutResult {
  branch: string;
  /** Branch before the switch; undefined when HEAD was detached. */
  anterior: string | undefined;
  hash: string | undefined;
  criada: boolean;
  /** What the new branch was cut from (only when criada). */
  base: string | undefined;
  avisos: string[];
}

export async function gitCheckout(git: GitRunner, root: string, args: CheckoutArgs): Promise<CheckoutResult> {
  const branch = args.branch;
  const criar = args.criar === true;
  // static checks first, so that a refused argument never reaches git
  if (typeof branch !== "string") throw new GuardError("branch é obrigatória.");
  if (args.base !== undefined && !criar) throw new GuardError("base só vale com criar=true.");
  const base = args.base !== undefined ? assertRevision(args.base) : undefined;
  await assertRefName(branch, { git, cwd: root });

  const anterior = await currentBranch(git, root);
  const avisos: string[] = [];
  const argv = criar ? ["switch", "-c", branch, base ?? "HEAD"] : ["switch", branch];
  rejectForbiddenFlags(argv);
  if (criar && base === undefined) {
    avisos.push(`Sem base: a branch "${branch}" foi criada a partir do HEAD atual${anterior !== undefined ? ` (${anterior})` : " (HEAD solto)"}.`);
  }
  await git(root, argv);
  return { branch, anterior, hash: await headHash(git, root), criada: criar, base: criar ? (base ?? "HEAD") : undefined, avisos };
}
