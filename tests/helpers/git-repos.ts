// Real git repositories in temporary folders, for the tests of the git layer.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const created: string[] = [];

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: "Teste",
  GIT_AUTHOR_EMAIL: "teste@example.com",
  GIT_COMMITTER_NAME: "Teste",
  GIT_COMMITTER_EMAIL: "teste@example.com",
  GIT_TERMINAL_PROMPT: "0",
  LC_ALL: "C.UTF-8",
};

/** Runs git synchronously (test setup only) and returns stdout. */
export function sh(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "core.quotepath=off", ...args], { cwd, env: GIT_ENV, encoding: "utf8", windowsHide: true });
}

/** New empty temporary folder with its real path (the 8.3 short names of Windows expanded). */
export function makeTempDir(prefix = "aigt-"): string {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
  created.push(dir);
  return dir;
}

export function writeFile(root: string, rel: string, content: string): string {
  const full = join(root, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content, "utf8");
  return full;
}

/** Repository on `main` with one commit. */
export function makeRepo(parent?: string, name = "repo"): string {
  const base = parent ?? makeTempDir();
  const dir = join(base, name);
  mkdirSync(dir, { recursive: true });
  sh(dir, "init", "-b", "main");
  sh(dir, "config", "user.name", "Teste");
  sh(dir, "config", "user.email", "teste@example.com");
  sh(dir, "config", "commit.gpgsign", "false");
  sh(dir, "config", "core.autocrlf", "false");
  writeFile(dir, "README.md", "# teste\n");
  sh(dir, "add", "README.md");
  sh(dir, "commit", "-m", "commit inicial");
  return dir;
}

/** Bare repository usable as a remote. */
export function makeBareRemote(parent?: string, name = "remoto.git"): string {
  const base = parent ?? makeTempDir();
  const dir = join(base, name);
  mkdirSync(dir, { recursive: true });
  sh(dir, "init", "--bare", "-b", "main");
  return dir;
}

/** Repository with a bare remote `origin`, already pushed with upstream. */
export function makeRepoWithRemote(): { base: string; repo: string; remote: string } {
  const base = makeTempDir();
  const remote = makeBareRemote(base);
  const repo = makeRepo(base);
  sh(repo, "remote", "add", "origin", remote);
  sh(repo, "push", "-u", "origin", "main");
  return { base, repo, remote };
}

/** True when this machine lets the test create a directory link (a junction on Windows). */
export function canLinkDirs(): boolean {
  const dir = makeTempDir("aigt-link-");
  try {
    mkdirSync(join(dir, "alvo"));
    symlinkSync(join(dir, "alvo"), join(dir, "link"), process.platform === "win32" ? "junction" : "dir");
    return true;
  } catch {
    return false;
  }
}

export function linkDir(target: string, link: string): void {
  symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
}

/** Removes every temporary folder created so far. Call in `afterAll`. */
export function cleanupTemp(): void {
  for (const dir of created.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      // a locked file on Windows must not fail the suite
    }
  }
}
