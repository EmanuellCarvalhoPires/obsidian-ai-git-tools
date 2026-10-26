import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { GitError, createNodeGit, maskCredentials, timeoutFor } from "../../src/core/git-runner";
import { cleanupTemp, makeRepo, makeTempDir, sh, writeFile } from "../helpers/git-repos";

afterAll(cleanupTemp);

const git = createNodeGit();

async function failure(p: Promise<unknown>): Promise<GitError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(GitError);
    return e as GitError;
  }
  throw new Error("expected the call to fail");
}

describe("createNodeGit", () => {
  it("runs git and returns stdout", async () => {
    const repo = makeRepo();
    const out = await git(repo, ["log", "-1", "--format=%s"]);
    expect(out.trim()).toBe("commit inicial");
  });

  it("passes an argument with shell syntax as a literal string (no shell)", async () => {
    const repo = makeRepo();
    const sentinel = join(repo, "pwned.txt");
    const message = `x; echo pwned > "${sentinel}" && echo $(whoami) | calc & rm -rf /`;
    await git(repo, ["commit", "--allow-empty", "-m", message]);
    const subject = await git(repo, ["log", "-1", "--format=%s"]);
    expect(subject.trim()).toBe(message);
    expect(existsSync(sentinel)).toBe(false);

    const err = await failure(git(repo, ["rev-parse", "--verify", "; rm -rf /"]));
    expect(err.args).toContain("; rm -rf /");
  });

  it("sends the input through stdin", async () => {
    const repo = makeRepo();
    const hash = await git(repo, ["hash-object", "--stdin"], { input: "abc" });
    expect(hash.trim()).toBe("f2ba8f84ab5c1bce84a7b441cb1959cfc7093b7f");
  });

  it("does not wait for stdin when there is no input", async () => {
    const repo = makeRepo();
    const out = await git(repo, ["hash-object", "--stdin"]);
    expect(out.trim()).toBe("e69de29bb2d1d6434b8b29ae775ad8c2e48c5391");
  });

  it("returns paths with non-ASCII names unquoted (core.quotepath=off)", async () => {
    const repo = makeRepo();
    writeFile(repo, "ação.txt", "x");
    sh(repo, "add", "ação.txt");
    const out = await git(repo, ["ls-files"]);
    expect(out).toContain("ação.txt");
  });

  it("turns a non-zero exit into a GitError with code, stderr and args", async () => {
    const repo = makeRepo();
    const err = await failure(git(repo, ["rev-parse", "--verify", "nao-existe"]));
    expect(err.codigo).toBe(128);
    expect(err.stderr.length).toBeGreaterThan(0);
    expect(err.args).toEqual(["rev-parse", "--verify", "nao-existe"]);
  });

  it("keeps stdout of a failed call (exit 1 with output)", async () => {
    const repo = makeRepo();
    writeFile(repo, "README.md", "mudou\n");
    const err = await failure(git(repo, ["diff", "--exit-code"]));
    expect(err.codigo).toBe(1);
    expect(err.stdout).toContain("mudou");
  });

  it("masks credentials in the error message, stderr and args", async () => {
    const repo = makeRepo();
    sh(repo, "remote", "add", "origin", "https://u:segredo@example.com/x.git");
    const err = await failure(git(repo, ["remote", "add", "origin", "https://u:segredo@example.com/x.git"]));
    const all = JSON.stringify({ m: err.message, s: err.stderr, a: err.args });
    expect(all).not.toContain("segredo");
    expect(err.args).toContain("https://***@example.com/x.git");
    expect(err.message).toContain("https://***@example.com/x.git");
  });

  it("fails with the code timeout when the call takes longer than allowed", async () => {
    const repo = makeRepo();
    const err = await failure(git(repo, ["-c", "alias.espera=!sleep 5", "espera"], { timeoutMs: 200 }));
    expect(err.codigo).toBe("timeout");
  });

  it("does not hang on a missing repository (never prompts)", async () => {
    const dir = makeTempDir();
    const err = await failure(git(dir, ["status"]));
    expect(err.stderr.toLowerCase()).toContain("not a git repository");
  });
});

describe("maskCredentials", () => {
  it("masks user and password in a URL", () => {
    expect(maskCredentials("fatal: could not read https://u:segredo@host/x.git")).toBe("fatal: could not read https://***@host/x.git");
  });
  it("masks a user without password", () => {
    expect(maskCredentials("https://usuario@bitbucket.org/ws/r.git")).toBe("https://***@bitbucket.org/ws/r.git");
  });
  it("masks tokens used as user and several URLs in a row", () => {
    expect(maskCredentials("'https://tok@a.com/x' and 'http://u:p@b.com/y'")).toBe("'https://***@a.com/x' and 'http://***@b.com/y'");
  });
  it("leaves URLs without credentials and scp-like remotes alone", () => {
    expect(maskCredentials("https://github.com/o/r.git git@github.com:o/r.git")).toBe("https://github.com/o/r.git git@github.com:o/r.git");
  });
});

describe("timeoutFor", () => {
  it("gives 300 s to network subcommands and 60 s to the others", () => {
    for (const cmd of ["push", "pull", "fetch", "clone"]) expect(timeoutFor([cmd, "origin"])).toBe(300_000);
    expect(timeoutFor(["status"])).toBe(60_000);
    expect(timeoutFor(["log", "-1"])).toBe(60_000);
  });
  it("skips global options before the subcommand", () => {
    expect(timeoutFor(["-c", "x=y", "push"])).toBe(300_000);
    expect(timeoutFor(["-C", "dir", "status"])).toBe(60_000);
  });
});
