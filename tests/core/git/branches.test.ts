import { afterAll, describe, expect, it } from "vitest";
import { createNodeGit } from "../../../src/core/git-runner";
import { GuardError } from "../../../src/core/guards";
import { gitBranches, parseBranches, parseLsRemote } from "../../../src/core/git/branches";
import { cleanupTemp, makeRepo, makeRepoWithRemote, makeTempDir, sh, writeFile } from "../../helpers/git-repos";

afterAll(cleanupTemp);
const git = createNodeGit();

describe("parsers", () => {
  it("parseBranches ignora <remoto>/HEAD e lê ahead, behind e gone", () => {
    const f = "\x1f";
    const row = (ref: string, short: string, up: string, track: string, head: string): string =>
      `${ref}${f}${short}${f}${"1".repeat(40)}${f}${up}${f}${track}${f}${head}${f}2026-10-22T10:00:00-03:00${f}assunto ç${"\x1e"}\n`;
    const raw =
      row("refs/heads/main", "main", "origin/main", "[ahead 2, behind 1]", "*") +
      row("refs/heads/velha", "velha", "origin/velha", "[gone]", " ") +
      row("refs/heads/solta", "solta", "", "", " ") +
      row("refs/remotes/origin/HEAD", "origin", "", "", " ");
    const list = parseBranches(raw);
    expect(list.map((b) => b.nome)).toEqual(["main", "velha", "solta"]);
    expect(list[0]).toMatchObject({ upstream: "origin/main", ahead: 2, behind: 1, atual: true, assunto: "assunto ç" });
    expect(list[1]).toMatchObject({ upstream_sumiu: true });
    expect(list[2]).toMatchObject({ upstream: undefined, ahead: 0, behind: 0, atual: false });
  });

  it("parseLsRemote", () => {
    const h = "a".repeat(40);
    expect(parseLsRemote(`${h}\trefs/heads/main\n${h}\trefs/heads/feature/x\n${h}\trefs/tags/v1\n`)).toEqual([
      { hash: h, nome: "main" },
      { hash: h, nome: "feature/x" },
    ]);
  });
});

describe("gitBranches (repositório real)", () => {
  it("branches locais, atual e upstream", async () => {
    const { repo } = makeRepoWithRemote();
    sh(repo, "branch", "feature/a");
    const res = await gitBranches(git, repo, {});
    expect(res.atual).toBe("main");
    expect(res.locais.map((b) => b.nome).sort()).toEqual(["feature/a", "main"]);
    const main = res.locais.find((b) => b.nome === "main");
    expect(main).toMatchObject({ atual: true, upstream: "origin/main", ahead: 0, behind: 0 });
    expect(res.remotas).toBeUndefined();
    expect(res.remotoVivo).toBeUndefined();
  });

  it("com remotas: branches de acompanhamento e ls-remote do remoto bare", async () => {
    const { repo } = makeRepoWithRemote();
    sh(repo, "switch", "-c", "feature/b");
    writeFile(repo, "x.txt", "x\n");
    sh(repo, "add", "x.txt");
    sh(repo, "commit", "-m", "x");
    sh(repo, "push", "-u", "origin", "feature/b");
    const res = await gitBranches(git, repo, { remotas: true });
    expect(res.remotas?.map((b) => b.nome).sort()).toEqual(["origin/feature/b", "origin/main"]);
    expect(res.remotoVivo?.ok).toBe(true);
    expect(res.remotoVivo?.remoto).toBe("origin");
    expect(res.remotoVivo?.branches.map((b) => b.nome).sort()).toEqual(["feature/b", "main"]);
  });

  it("com remotas e remoto inacessível: marca a falha e não quebra", async () => {
    const repo = makeRepo();
    const nowhere = makeTempDir();
    sh(repo, "remote", "add", "origin", `${nowhere}/nao-existe.git`);
    const res = await gitBranches(git, repo, { remotas: true });
    expect(res.locais.length).toBe(1);
    expect(res.remotoVivo?.ok).toBe(false);
    expect(res.remotoVivo?.erro).toBeTruthy();
  });

  it("com remotas e sem remoto configurado", async () => {
    const repo = makeRepo();
    const res = await gitBranches(git, repo, { remotas: true });
    expect(res.remotoVivo).toMatchObject({ ok: false, branches: [] });
  });

  it("mescladas_em lista só as branches já mescladas", async () => {
    const repo = makeRepo();
    sh(repo, "branch", "ja-mesclada"); // points at main, so it is merged
    sh(repo, "switch", "-c", "nova");
    writeFile(repo, "n.txt", "n\n");
    sh(repo, "add", "n.txt");
    sh(repo, "commit", "-m", "n");
    sh(repo, "switch", "main");
    const res = await gitBranches(git, repo, { mescladasEm: "main" });
    expect(res.locais.map((b) => b.nome).sort()).toEqual(["main", "ja-mesclada"].sort());
  });

  it("recusa mescladas_em inválido sem chamar o git", async () => {
    const never = () => Promise.reject(new Error("o git não devia ser chamado"));
    await expect(gitBranches(never, "/x", { mescladasEm: "--all" })).rejects.toThrow(GuardError);
  });
});
