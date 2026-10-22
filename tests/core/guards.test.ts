import { afterAll, describe, expect, it, vi } from "vitest";
import {
  GuardError,
  assertPathspec,
  assertRefName,
  assertRefNameSyntax,
  assertRefspec,
  isSensitivePath,
  pathspecArgs,
  rejectForbiddenFlags,
} from "../../src/core/guards";
import { createNodeGit } from "../../src/core/git-runner";
import type { GitRunner } from "../../src/core/ports";
import { cleanupTemp, makeRepo } from "../helpers/git-repos";

afterAll(cleanupTemp);

function expectGuard(fn: () => unknown): void {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(GuardError);
    expect((e as GuardError).codigo).toBe("argumento_invalido");
    return;
  }
  throw new Error("expected GuardError");
}

describe("assertRefName", () => {
  const valid = ["main", "feature/PROJ-45", "release/1.2.0", "v1.0.0", "hotfix/x_y-z", "correção/acentos", "a.b", "origin/develop"];
  const invalid = [
    "",
    "-x",
    "--upload-pack=calc",
    "a..b",
    "a@{1}",
    "@{-1}",
    "@",
    "a b",
    "a\tb",
    "a~1",
    "a^",
    "a:b",
    "a?",
    "a*",
    "a[",
    "a\\b",
    "/a",
    "a/",
    "a//b",
    "a.",
    "a.lock",
    "a/.hidden",
    "a\u0000b",
    "x".repeat(300),
  ];

  for (const name of valid) {
    it(`accepts ${JSON.stringify(name)}`, async () => {
      expect(() => assertRefNameSyntax(name)).not.toThrow();
    });
  }
  for (const name of invalid) {
    it(`refuses ${JSON.stringify(name.length > 40 ? `${name.slice(0, 10)}...` : name)}`, () => {
      expectGuard(() => assertRefNameSyntax(name));
    });
  }

  it("asks git (check-ref-format --branch) for a name that passed the syntax check", async () => {
    const repo = makeRepo();
    const git = createNodeGit();
    await expect(assertRefName("feature/ok", { git, cwd: repo })).resolves.toBeUndefined();
    await expect(assertRefName("feature/a..b", { git, cwd: repo })).rejects.toBeInstanceOf(GuardError);
  });

  it("does not call git when the syntax check fails", async () => {
    const git = vi.fn<GitRunner>().mockResolvedValue("");
    await expect(assertRefName("-x", { git, cwd: "." })).rejects.toBeInstanceOf(GuardError);
    expect(git).not.toHaveBeenCalled();
  });

  it("turns a refusal of git into argumento_invalido", async () => {
    const git = vi.fn<GitRunner>().mockRejectedValue(new Error("fatal: bad"));
    await expect(assertRefName("ok", { git, cwd: "." })).rejects.toMatchObject({ codigo: "argumento_invalido" });
    expect(git).toHaveBeenCalledWith(".", ["check-ref-format", "--branch", "ok"]);
  });
});

describe("assertRefspec", () => {
  it("accepts plain refs and src:dst", () => {
    for (const spec of ["main", "main:main", "HEAD:refs/heads/x", "refs/tags/v1.0.0", "feature/x:feature/x"]) {
      expect(() => assertRefspec(spec)).not.toThrow();
    }
  });
  it("refuses forced refspecs", () => {
    for (const spec of ["+main", "+main:main", "main:+main"]) expectGuard(() => assertRefspec(spec));
  });
  it("refuses a refspec that deletes a remote ref", () => {
    for (const spec of [":main", ":refs/heads/x", "main:"]) expectGuard(() => assertRefspec(spec));
  });
  it("refuses empty, option-like and malformed refspecs", () => {
    for (const spec of ["", "-x", "a:b:c", "a b"]) expectGuard(() => assertRefspec(spec));
  });
});

describe("assertPathspec", () => {
  it("accepts relative paths", () => {
    const paths = ["src/main.ts", "README.md", ".", "dir/sub/arquivo com espaço.txt", "ação.txt"];
    expect(assertPathspec(paths)).toEqual(paths);
  });
  it("refuses .., absolute paths, options and pathspec magic", () => {
    const bad = ["../x", "a/../../x", "a\\..\\x", "/etc/passwd", "C:\\x", "C:/x", "\\\\srv\\share", "-f", "--all", ":(top)x", ":!x", "", "  ", "a\u0000b"];
    for (const p of bad) expectGuard(() => assertPathspec([p]));
  });
  it("refuses an empty list", () => {
    expectGuard(() => assertPathspec([]));
  });
  it("puts the paths after `--`", () => {
    expect(pathspecArgs(["a.txt", "b/c.txt"])).toEqual(["--", "a.txt", "b/c.txt"]);
    expectGuard(() => pathspecArgs(["-f"]));
  });
});

describe("rejectForbiddenFlags", () => {
  const forbidden = [
    "--force",
    "-f",
    "--force-with-lease",
    "--force-with-lease=main",
    "--force-if-includes",
    "--delete",
    "-d",
    "-D",
    "--hard",
    "--mirror",
    "--prune",
    "--amend",
    "--no-verify",
    "--rebase",
    "--rebase=true",
    "-i",
    "--interactive",
    // clusters and abbreviations that git would accept
    "-fu",
    "-df",
    "--forc",
    "--del",
    "--FORCE",
  ];
  for (const flag of forbidden) {
    it(`refuses ${flag}`, () => {
      expectGuard(() => rejectForbiddenFlags(["push", "origin", flag]));
    });
  }

  it("accepts the flags the tools really use", () => {
    const ok = [
      ["push", "-u", "origin", "main"],
      ["switch", "-c", "feature/x", "main"],
      ["commit", "-F", "-"],
      ["pull", "--ff-only"],
      ["merge", "--no-edit", "--no-ff", "feature/x"],
      ["revert", "--no-edit", "-m", "1", "abc"],
      ["fetch", "origin", "--tags"],
      ["diff", "--no-color", "--no-ext-diff", "--stat", "-U3"],
      ["log", "--format=%H%x1f%an", "-n", "10", "--decorate"],
      ["status", "--porcelain=v2", "--branch", "-z"],
      ["tag", "-a", "v1", "-m", "x"],
      ["stash", "push", "--include-untracked"],
      ["diff", "--name-only", "--diff-filter=U"],
      ["clone", "--depth", "1", "--branch", "main"],
    ];
    for (const args of ok) expect(() => rejectForbiddenFlags(args)).not.toThrow();
  });

  it("does not inspect what comes after `--` (those are paths)", () => {
    expect(() => rejectForbiddenFlags(["add", "--", "--force"])).not.toThrow();
  });

  it("never calls git (pure check)", () => {
    const git = vi.fn<GitRunner>();
    expectGuard(() => rejectForbiddenFlags(["push", "--force"]));
    expect(git).not.toHaveBeenCalled();
  });
});

describe("isSensitivePath", () => {
  it("flags secrets and keys", () => {
    const sensitive = [
      ".env",
      ".env.local",
      ".env.production",
      "app/.env",
      "chave.pem",
      "certs/server.key",
      "id_rsa",
      "id_rsa.pub",
      "home/.ssh/id_ed25519",
      ".deploy-target",
      "data.json",
      ".obsidian/plugins/x/data.json",
      "C:\\repo\\.env",
      "cert.PFX",
    ];
    for (const p of sensitive) expect(isSensitivePath(p), p).toBe(true);
  });
  it("does not flag ordinary files", () => {
    for (const p of ["README.md", "src/environment.ts", "package.json", "manifest.json", "keys.md", "monkey.ts", "env.ts", "data.json.md"]) {
      expect(isSensitivePath(p), p).toBe(false);
    }
  });
});
