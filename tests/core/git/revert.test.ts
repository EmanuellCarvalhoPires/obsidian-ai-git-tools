import { afterAll, describe, expect, it } from "vitest";
import { createNodeGit } from "../../../src/core/git-runner";
import { RevertMergeError, gitRevert } from "../../../src/core/git/revert";
import { cleanupTemp, makeRepo, sh, writeFile } from "../../helpers/git-repos";
import { spyGit } from "../../helpers/spy-git";

afterAll(cleanupTemp);
const git = createNodeGit();

function commitFile(repo: string, name: string, content = `${name}\n`, message = `add ${name}`): string {
  writeFile(repo, name, content);
  sh(repo, "add", name);
  sh(repo, "commit", "-m", message);
  return sh(repo, "rev-parse", "HEAD").trim();
}

const exists = (repo: string, ref: string): boolean => {
  try {
    sh(repo, "rev-parse", "-q", "--verify", ref);
    return true;
  } catch {
    return false;
  }
};

describe("gitRevert simples", () => {
  it("cria um commit que desfaz o anterior e devolve o hash", async () => {
    const repo = makeRepo();
    const target = commitFile(repo, "a.txt");
    const res = await gitRevert(git, repo, { commit: target });
    expect(res).toMatchObject({ estado: "revertido", commit: target, branch: "main" });
    if (res.estado !== "revertido") throw new Error("esperava revertido");
    expect(res.hash).toBe(sh(repo, "rev-parse", "HEAD").trim());
    expect(res.titulo).toMatch(/^Revert "add a\.txt"/);
    expect(sh(repo, "ls-files")).not.toContain("a.txt");
    // history is not rewritten: the reverted commit is still there
    expect(sh(repo, "rev-list", "--count", "HEAD").trim()).toBe("3");
  });
});

describe("gitRevert de merge", () => {
  function mergeRepo(): { repo: string; merge: string } {
    const repo = makeRepo();
    sh(repo, "switch", "-c", "feature");
    commitFile(repo, "f.txt");
    sh(repo, "switch", "main");
    commitFile(repo, "m.txt");
    sh(repo, "merge", "--no-ff", "-m", "junta feature", "feature");
    return { repo, merge: sh(repo, "rev-parse", "HEAD").trim() };
  }

  it("sem merge_pai: RevertMergeError com dica", async () => {
    const { repo, merge } = mergeRepo();
    const err = await gitRevert(git, repo, { commit: merge }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RevertMergeError);
    expect((err as RevertMergeError).dica).toMatch(/merge_pai/);
    expect(sh(repo, "rev-parse", "HEAD").trim()).toBe(merge);
  });

  it("com merge_pai=1 desfaz o lado mesclado e mantém o da branch", async () => {
    const { repo, merge } = mergeRepo();
    const res = await gitRevert(git, repo, { commit: merge, mergePai: 1 });
    expect(res.estado).toBe("revertido");
    const files = sh(repo, "ls-files").split("\n");
    expect(files).toContain("m.txt");
    expect(files).not.toContain("f.txt");
  });

  it.each([[0], [-1], [1.5]])("merge_pai %j é recusado sem chamar o git", async (n) => {
    const repo = makeRepo();
    const spy = spyGit();
    await expect(gitRevert(spy.git, repo, { commit: "HEAD", mergePai: n })).rejects.toMatchObject({ codigo: "argumento_invalido" });
    expect(spy.calls).toEqual([]);
  });
});

describe("gitRevert com conflito", () => {
  function conflictRepo(): { repo: string; target: string } {
    const repo = makeRepo();
    const target = commitFile(repo, "README.md", "# segunda\n", "muda 1");
    commitFile(repo, "README.md", "# terceira\n", "muda 2");
    return { repo, target };
  }

  it("lista os arquivos e deixa o revert em andamento", async () => {
    const { repo, target } = conflictRepo();
    const res = await gitRevert(git, repo, { commit: target });
    expect(res).toEqual({ estado: "conflito", commit: target, arquivos: ["README.md"] });
    expect(exists(repo, "REVERT_HEAD")).toBe(true);
  });

  it("abortar desfaz o revert em andamento", async () => {
    const { repo, target } = conflictRepo();
    const before = sh(repo, "rev-parse", "HEAD").trim();
    await gitRevert(git, repo, { commit: target });
    const res = await gitRevert(git, repo, { abortar: true });
    expect(res).toMatchObject({ estado: "abortado", branch: "main", hash: before });
    expect(exists(repo, "REVERT_HEAD")).toBe(false);
    expect(sh(repo, "status", "--porcelain").trim()).toBe("");
  });

  it("abortar sem REVERT_HEAD -> argumento_invalido e nenhum revert --abort", async () => {
    const repo = makeRepo();
    const spy = spyGit();
    await expect(gitRevert(spy.git, repo, { abortar: true })).rejects.toMatchObject({ codigo: "argumento_invalido" });
    expect(spy.callsTo("revert")).toEqual([]);
  });

  it("abortar junto com commit -> argumento_invalido sem chamar o git", async () => {
    const repo = makeRepo();
    const spy = spyGit();
    await expect(gitRevert(spy.git, repo, { abortar: true, commit: "HEAD" })).rejects.toMatchObject({ codigo: "argumento_invalido" });
    expect(spy.calls).toEqual([]);
  });
});

describe("gitRevert argumentos recusados", () => {
  it.each([[""], ["--no-commit"], ["-n"], ["--abort"], ["a..b"], ["HEAD~3..HEAD"], ["a b"], ["-m"], ["--continue"], ["--skip"]])("commit %j é recusado sem chamar o git", async (commit) => {
    const repo = makeRepo();
    const spy = spyGit();
    await expect(gitRevert(spy.git, repo, { commit })).rejects.toMatchObject({ codigo: "argumento_invalido" });
    expect(spy.callsTo("revert")).toEqual([]);
  });

  it("sem commit e sem abortar -> argumento_invalido", async () => {
    const repo = makeRepo();
    await expect(gitRevert(git, repo, {})).rejects.toMatchObject({ codigo: "argumento_invalido" });
  });
});
