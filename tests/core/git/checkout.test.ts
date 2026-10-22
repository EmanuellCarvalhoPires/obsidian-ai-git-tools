import { afterAll, describe, expect, it } from "vitest";
import { GitError, createNodeGit } from "../../../src/core/git-runner";
import { gitCheckout } from "../../../src/core/git/checkout";
import { cleanupTemp, makeRepo, sh, writeFile } from "../../helpers/git-repos";
import { MUTATING, spyGit } from "../../helpers/spy-git";

afterAll(cleanupTemp);
const git = createNodeGit();

describe("gitCheckout", () => {
  it("troca para uma branch existente", async () => {
    const repo = makeRepo();
    sh(repo, "branch", "outra");
    const res = await gitCheckout(git, repo, { branch: "outra" });
    expect(res).toMatchObject({ branch: "outra", anterior: "main", criada: false, base: undefined });
    expect(sh(repo, "branch", "--show-current").trim()).toBe("outra");
  });

  it("cria a branch a partir de uma base", async () => {
    const repo = makeRepo();
    const first = sh(repo, "rev-parse", "HEAD").trim();
    writeFile(repo, "a.txt", "a\n");
    sh(repo, "add", "a.txt");
    sh(repo, "commit", "-m", "a");
    const res = await gitCheckout(git, repo, { branch: "feature/x", criar: true, base: first });
    expect(res).toMatchObject({ branch: "feature/x", criada: true, base: first, avisos: [] });
    expect(res.hash).toBe(first);
    expect(sh(repo, "branch", "--show-current").trim()).toBe("feature/x");
  });

  it("criar sem base parte do HEAD e avisa", async () => {
    const repo = makeRepo();
    const res = await gitCheckout(git, repo, { branch: "nova", criar: true });
    expect(res.criada).toBe(true);
    expect(res.base).toBe("HEAD");
    expect(res.avisos.join(" ")).toMatch(/HEAD/);
    expect(sh(repo, "branch", "--show-current").trim()).toBe("nova");
  });

  it("não troca com alterações em conflito (nunca força) e criar de novo falha", async () => {
    const repo = makeRepo();
    sh(repo, "switch", "-c", "b");
    writeFile(repo, "README.md", "# na b\n");
    sh(repo, "commit", "-am", "muda na b");
    sh(repo, "switch", "main");
    writeFile(repo, "README.md", "# sujo\n");
    await expect(gitCheckout(git, repo, { branch: "b" })).rejects.toBeInstanceOf(GitError);
    expect(sh(repo, "branch", "--show-current").trim()).toBe("main");
    expect(sh(repo, "show", "HEAD:README.md")).toBe("# teste\n");
    await expect(gitCheckout(git, repo, { branch: "b", criar: true })).rejects.toBeInstanceOf(GitError);
  });

  it.each([
    ["--force"],
    ["-f"],
    ["--discard-changes"],
    ["-c"],
    ["-D"],
    ["a..b"],
    ["a b"],
    ["a:b"],
    ["feat~1"],
    ["x.lock"],
    ["@{-1}"],
    [""],
  ])("recusa o nome de branch %j sem chamar o git de escrita", async (name) => {
    const repo = makeRepo();
    const spy = spyGit();
    await expect(gitCheckout(spy.git, repo, { branch: name, criar: true })).rejects.toMatchObject({ codigo: "argumento_invalido" });
    await expect(gitCheckout(spy.git, repo, { branch: name })).rejects.toMatchObject({ codigo: "argumento_invalido" });
    expect(spy.callsTo(...MUTATING)).toEqual([]);
    expect(sh(repo, "branch", "--list").trim()).toBe("* main");
  });

  it.each([["--force"], ["-f"], [":/x"], ["a..b"], ["@{u}"], ["--orphan"]])("recusa a base %j", async (base) => {
    const repo = makeRepo();
    const spy = spyGit();
    await expect(gitCheckout(spy.git, repo, { branch: "ok", criar: true, base })).rejects.toMatchObject({ codigo: "argumento_invalido" });
    expect(spy.callsTo(...MUTATING)).toEqual([]);
  });

  it("base sem criar é recusada", async () => {
    const repo = makeRepo();
    await expect(gitCheckout(git, repo, { branch: "main", base: "HEAD" })).rejects.toMatchObject({ codigo: "argumento_invalido" });
  });
});
