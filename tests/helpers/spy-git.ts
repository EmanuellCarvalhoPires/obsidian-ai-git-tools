// A GitRunner that records every call, to prove that a refused argument never reaches git.
import { createNodeGit } from "../../src/core/git-runner";
import type { GitRunner } from "../../src/core/ports";

export interface SpyGit {
  git: GitRunner;
  /** Argument vectors of every call so far. */
  calls: string[][];
  /** Calls whose subcommand is one of `names`. */
  callsTo(...names: string[]): string[][];
  reset(): void;
}

export function spyGit(): SpyGit {
  const real = createNodeGit();
  const calls: string[][] = [];
  return {
    calls,
    git: (cwd, args, opts) => {
      calls.push(args);
      return real(cwd, args, opts);
    },
    callsTo: (...names) => calls.filter((a) => names.includes(a[0] ?? "")),
    reset: () => {
      calls.length = 0;
    },
  };
}

/** Subcommands that change a repository or talk to a remote. */
export const MUTATING = ["add", "commit", "push", "pull", "fetch", "switch", "checkout", "merge", "reset"];

/** A second clone of `remote` with the identity configured, to put commits on the remote. */
export function configureClone(sh: (cwd: string, ...args: string[]) => string, dir: string): void {
  sh(dir, "config", "user.name", "Outro");
  sh(dir, "config", "user.email", "outro@example.com");
  sh(dir, "config", "commit.gpgsign", "false");
  sh(dir, "config", "core.autocrlf", "false");
}
