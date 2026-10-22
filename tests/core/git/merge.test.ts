import { afterAll, describe, expect, it } from "vitest";
import { GuardError } from "../../../src/core/guards";
import { createNodeGit } from "../../../src/core/git-runner";
import { gitMerge } from "../../../src/core/git/merge";
import { cleanupTemp, makeRepo, sh, writeFile } from "../../helpers/git-repos";
import { MUTATING, spyGit } from "../../helpers/spy-git";

afterAll(cleanupTemp);
const git = createNodeGit();

function commitFile(repo: string, name: string, content = `${name}\n`, message = `add ${name}`): string {
  writeFile(repo, name, content);
  sh(repo, "add", name);
  sh(repo, "commit", "-m", message);
  return sh(repo, "rev-parse", "HEAD").trim();
}

/** main and feature diverge on the same line of README.md. */
function conflictingRepos(): string {
  const repo = makeRepo();
  sh(repo, "switch", "-c", "feature");
  commitFile(repo, "README.md", "# lado feature\n", "muda na feature");
  sh(repo, "switch", "main");
  commitFile(repo, "README.md", "# lado main\n", "muda na main");
  return repo;
}

const exists = (repo: string, ref: string): boolean => {
  try {
    sh(repo, "rev-parse", "-q", "--verify", ref);
    return true;
  } catch {
    return false;
  }
};

describe("gitMerge sem conflito", () => {
  it("avanço simples (fast-forward) quando a origem está à frente", async () => {
    const repo = makeRepo();
    sh(repo, "switch", "-c", "feature");
    const tip = commitFile(repo, "f.txt");
    sh(repo, "switch", "main");
    const res = await gitMerge(git, repo, { origem: "feature" });
    expect(res).toMatchObject({ estado: "mesclado", origem: "feature", branch: "main", hash: tip, hashCurto: tip.slice(0, 7), fastForward: true, jaAtualizado: false });
    expect(sh(repo, "rev-parse", "HEAD").trim()).toBe(tip);
  });

  it("sem_ff cria o commit de merge, com a mensagem pedida", async () => {
    const repo = makeRepo();
    sh(repo, "switch", "-c", "feature");
    commitFile(repo, "f.txt");
    sh(repo, "switch", "main");
    const res = await gitMerge(git, repo, { origem: "feature", semFf: true, mensagem: 'Junta a feature; $(rm -rf /) "aspas"' });
    expect(res).toMatchObject({ estado: "mesclado", fastForward: false });
    expect(sh(repo, "rev-list", "--parents", "-n", "1", "HEAD").trim().split(" ")).toHaveLength(3);
    expect(sh(repo, "log", "-1", "--format=%s").trim()).toBe('Junta a feature; $(rm -rf /) "aspas"');
  });

  it("branches divergentes sem conflito geram merge commit (fast_forward=false)", async () => {
    const repo = makeRepo();
    sh(repo, "switch", "-c", "feature");
    commitFile(repo, "f.txt");
    sh(repo, "switch", "main");
    commitFile(repo, "m.txt");
    const res = await gitMerge(git, repo, { origem: "feature" });
    expect(res).toMatchObject({ estado: "mesclado", fastForward: false, jaAtualizado: false });
    expect(sh(repo, "ls-files").split("\n")).toEqual(expect.arrayContaining(["f.txt", "m.txt"]));
  });

  it("origem já mesclada: ja_atualizado e HEAD não se mexe", async () => {
    const repo = makeRepo();
    sh(repo, "branch", "velha");
    commitFile(repo, "a.txt");
    const head = sh(repo, "rev-parse", "HEAD").trim();
    const res = await gitMerge(git, repo, { origem: "velha" });
    expect(res).toMatchObject({ estado: "mesclado", jaAtualizado: true, fastForward: false, hash: head });
  });
});

describe("gitMerge com conflito", () => {
  it("devolve a lista de arquivos e deixa o estado de merge", async () => {
    const repo = conflictingRepos();
    const res = await gitMerge(git, repo, { origem: "feature" });
    expect(res).toEqual({ estado: "conflito", origem: "feature", arquivos: ["README.md"] });
    expect(exists(repo, "MERGE_HEAD")).toBe(true);
    expect(sh(repo, "status", "--porcelain")).toContain("UU README.md");
  });

  it("com um merge em andamento, outro merge é recusado e o estado é preservado", async () => {
    const repo = conflictingRepos();
    await gitMerge(git, repo, { origem: "feature" });
    await expect(gitMerge(git, repo, { origem: "feature" })).rejects.toBeInstanceOf(GuardError);
    expect(exists(repo, "MERGE_HEAD")).toBe(true);
  });

  it("alteração local que seria sobrescrita: erro do git, não conflito", async () => {
    const repo = makeRepo();
    sh(repo, "switch", "-c", "feature");
    commitFile(repo, "README.md", "# feature\n", "muda");
    sh(repo, "switch", "main");
    writeFile(repo, "README.md", "# sujo\n");
    await expect(gitMerge(git, repo, { origem: "feature" })).rejects.toMatchObject({ name: "GitError" });
    expect(exists(repo, "MERGE_HEAD")).toBe(false);
  });
});

describe("gitMerge abortar", () => {
  it("com MERGE_HEAD desfaz o merge", async () => {
    const repo = conflictingRepos();
    const before = sh(repo, "rev-parse", "HEAD").trim();
    await gitMerge(git, repo, { origem: "feature" });
    const res = await gitMerge(git, repo, { abortar: true });
    expect(res).toMatchObject({ estado: "abortado", branch: "main", hash: before });
    expect(exists(repo, "MERGE_HEAD")).toBe(false);
    expect(sh(repo, "status", "--porcelain").trim()).toBe("");
    expect(sh(repo, "show", "HEAD:README.md")).toBe("# lado main\n");
  });

  it("sem MERGE_HEAD -> argumento_invalido e nenhum merge --abort", async () => {
    const repo = makeRepo();
    const spy = spyGit();
    await expect(gitMerge(spy.git, repo, { abortar: true })).rejects.toMatchObject({ codigo: "argumento_invalido" });
    expect(spy.callsTo("merge")).toEqual([]);
  });

  it("abortar junto com origem -> argumento_invalido sem chamar o git", async () => {
    const repo = makeRepo();
    const spy = spyGit();
    await expect(gitMerge(spy.git, repo, { abortar: true, origem: "main" })).rejects.toMatchObject({ codigo: "argumento_invalido" });
    expect(spy.calls).toEqual([]);
  });
});

describe("gitMerge argumentos recusados", () => {
  it.each([[""], ["--squash"], ["-s"], ["--abort"], ["a..b"], ["a b"], ["@{u}"], ["-X"], ["--strategy=ours"]])("origem %j é recusada sem chamar o git", async (origem) => {
    const repo = makeRepo();
    const spy = spyGit();
    await expect(gitMerge(spy.git, repo, { origem })).rejects.toMatchObject({ codigo: "argumento_invalido" });
    expect(spy.callsTo(...MUTATING)).toEqual([]);
  });

  it("sem origem e sem abortar -> argumento_invalido", async () => {
    const repo = makeRepo();
    await expect(gitMerge(git, repo, {})).rejects.toMatchObject({ codigo: "argumento_invalido" });
  });

  it("origem inexistente: erro do git e nada muda", async () => {
    const repo = makeRepo();
    const before = sh(repo, "rev-parse", "HEAD");
    await expect(gitMerge(git, repo, { origem: "nao-existe" })).rejects.toMatchObject({ name: "GitError" });
    expect(sh(repo, "rev-parse", "HEAD")).toBe(before);
  });

  it("nunca passa flag de força, squash, estratégia ou edição", async () => {
    const repo = makeRepo();
    sh(repo, "switch", "-c", "feature");
    commitFile(repo, "f.txt");
    sh(repo, "switch", "main");
    const spy = spyGit();
    await gitMerge(spy.git, repo, { origem: "feature", semFf: true, mensagem: "-f --force" });
    const argv = spy.callsTo("merge")[0] ?? [];
    const m = argv.indexOf("-m");
    // the message is its own argument right after -m, never glued to a flag
    expect(argv[m + 1]).toBe("-f --force");
    const flags = [...argv.slice(0, m), ...argv.slice(m + 2)].join(" ");
    expect(flags).not.toMatch(/--squash|--strategy|(^| )-X( |$)|(^| )(-f|--force)( |$)|--abort/);
    expect(flags).toContain("--no-edit");
  });

  it("origem com metacaracteres de shell é só um argumento literal: o git recusa por não ser uma referência", async () => {
    const repo = makeRepo();
    const before = sh(repo, "rev-parse", "HEAD");
    await expect(gitMerge(git, repo, { origem: "main;rm" })).rejects.toMatchObject({ name: "GitError" });
    expect(sh(repo, "rev-parse", "HEAD")).toBe(before);
  });
});
