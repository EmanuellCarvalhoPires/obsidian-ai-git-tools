// git_add: `git add -- <paths>` or `git add -A`. Refuses sensitive files (.env, private keys,
// .deploy-target...) unless the caller confirms. The check looks at what would really enter the
// stage (so `todos` and directories are covered), not only at the paths that were typed.
import { GuardError, assertPathspec, isSensitivePath, rejectForbiddenFlags } from "../guards";
import type { GitRunner } from "../ports";
import { gitStatus } from "./status";
import type { StatusEntry } from "./status";

export interface AddArgs {
  caminhos?: string[];
  todos?: boolean;
  confirmarSensivel?: boolean;
}

export type AddResult =
  | {
      recusado: true;
      /** Sensitive files that would enter the stage. Nothing was added. */
      sensiveis: string[];
    }
  | {
      recusado: false;
      /** Files that were not in the stage before and are now. */
      adicionados: string[];
      /** Everything in the stage after the call. */
      staged: StatusEntry[];
      /** Sensitive files that were added because of `confirmar_sensivel`. */
      sensiveisConfirmados: string[];
      avisos: string[];
    };

/** Paths that `git add` would put in the stage: untracked files and changes of the working tree. */
export async function pathsToStage(git: GitRunner, root: string, pathspec?: string[]): Promise<string[]> {
  const argv = ["status", "--porcelain=v1", "-z", "-uall"];
  if (pathspec !== undefined) argv.push("--", ...pathspec);
  const records = (await git(root, argv)).split("\0");
  const found: string[] = [];
  for (let i = 0; i < records.length; i++) {
    const rec = records[i] ?? "";
    if (rec.length < 4) continue;
    const x = rec[0] ?? " ";
    const y = rec[1] ?? " ";
    const path = rec.slice(3);
    if (x === "R" || x === "C") i++; // the next record is the original path
    if (x === "U" || y === "U" || (x === "A" && y === "A") || (x === "D" && y === "D")) continue; // conflicts are not added by this tool
    const untracked = x === "?" && y === "?";
    // a deleted file leaves the repository: not a risk
    if (untracked || (y !== " " && y !== "D")) found.push(path);
  }
  return found;
}

export async function gitAdd(git: GitRunner, root: string, args: AddArgs): Promise<AddResult> {
  const todos = args.todos === true;
  if (todos && args.caminhos !== undefined) throw new GuardError("Informe caminhos OU todos=true, não os dois.");
  if (!todos && args.caminhos === undefined) throw new GuardError("Informe caminhos ou todos=true.");
  const pathspec = todos ? undefined : assertPathspec(args.caminhos ?? []);

  const [incoming, statusBefore] = await Promise.all([pathsToStage(git, root, pathspec), gitStatus(git, root)]);
  const sensiveis = [...new Set([...incoming, ...(pathspec ?? [])].filter(isSensitivePath))];
  const confirmed = args.confirmarSensivel === true;
  if (sensiveis.length > 0 && !confirmed) return { recusado: true, sensiveis };

  const before = new Set(statusBefore.staged.map((e) => e.caminho));
  const argv = todos ? ["add", "-A"] : ["add", "--", ...(pathspec ?? [])];
  rejectForbiddenFlags(argv);
  await git(root, argv);

  const staged = (await gitStatus(git, root)).staged;
  const adicionados = staged.map((e) => e.caminho).filter((p) => !before.has(p));
  const avisos: string[] = [];
  if (adicionados.length === 0) avisos.push("Nada novo foi para o stage (os arquivos já estavam no stage ou não têm alterações).");
  return { recusado: false, adicionados, staged, sensiveisConfirmados: confirmed ? sensiveis : [], avisos };
}
