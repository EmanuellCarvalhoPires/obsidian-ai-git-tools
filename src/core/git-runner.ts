// Runs git without a shell. Every argument reaches git as a literal string (execFile), the
// environment never prompts, and any credential in an error message is masked.
import { execFile } from "node:child_process";
import type { GitRunner } from "./ports";

const MAX_BUFFER = 32 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 60_000;
const NETWORK_TIMEOUT_MS = 300_000;
/** Subcommands that talk to the network and may take longer. */
const NETWORK_COMMANDS = new Set(["push", "pull", "fetch", "clone"]);

/** `https://user:token@host/x.git` becomes `https://***@host/x.git` (also `user@` without password). */
export function maskCredentials(text: string): string {
  return text.replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@'"<>]+@/gi, "$1***@");
}

/** Failure of a git call. All text fields are already masked. */
export class GitError extends Error {
  /** Exit code of git, or a text code such as "timeout", "ENOENT" or "ERR_CHILD_PROCESS_STDIO_MAXBUFFER". */
  readonly codigo: number | string;
  readonly stderr: string;
  readonly stdout: string;
  readonly args: string[];

  constructor(codigo: number | string, stderr: string, args: string[], stdout = "") {
    const maskedArgs = args.map(maskCredentials);
    const maskedErr = maskCredentials(stderr);
    super(`git ${maskedArgs.join(" ")} falhou (${String(codigo)}): ${maskedErr}`.trim());
    this.name = "GitError";
    this.codigo = codigo;
    this.stderr = maskedErr;
    this.stdout = maskCredentials(stdout);
    this.args = maskedArgs;
  }
}

/** First argument that is the subcommand (skips global options such as `-c name=value`). */
function subcommandOf(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? "";
    if (a === "-c" || a === "-C") {
      i++;
      continue;
    }
    if (a.startsWith("-")) continue;
    return a;
  }
  return undefined;
}

export function timeoutFor(args: string[]): number {
  const cmd = subcommandOf(args);
  return cmd !== undefined && NETWORK_COMMANDS.has(cmd) ? NETWORK_TIMEOUT_MS : DEFAULT_TIMEOUT_MS;
}

export function createNodeGit(): GitRunner {
  return (cwd, args, opts) =>
    new Promise<string>((resolve, reject) => {
      const child = execFile(
        "git",
        ["-c", "core.quotepath=off", "-c", "color.ui=false", ...args],
        {
          cwd,
          maxBuffer: MAX_BUFFER,
          windowsHide: true,
          encoding: "utf8",
          timeout: opts?.timeoutMs ?? timeoutFor(args),
          env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never", LC_ALL: "C.UTF-8" },
        },
        (err, stdout, stderr) => {
          if (!err) {
            resolve(stdout);
            return;
          }
          const e = err as NodeJS.ErrnoException & { killed?: boolean; code?: number | string | null };
          const codigo: number | string = e.killed === true ? "timeout" : (e.code ?? "desconhecido");
          const detail = stderr.trim() !== "" ? stderr : e.message;
          reject(new GitError(codigo, detail.trim(), args, stdout));
        },
      );
      // Always close stdin so that git never waits for input that will not come.
      child.stdin?.on("error", () => undefined);
      child.stdin?.end(opts?.input);
    });
}
