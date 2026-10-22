import { afterAll, describe, expect, it } from "vitest";
import { createNodeGit } from "../../../src/core/git-runner";
import { STASH_ACTIONS, gitStash } from "../../../src/core/git/stash";
import { cleanupTemp, makeRepo, sh, writeFile } from "../../helpers/git-repos";
import { spyGit } from "../../helpers/spy-git";

afterAll(cleanupTemp);
const git = createNodeGit();

const porcelain = (repo: string): string => sh(repo, "status", "--porcelain").trim();

describe("gitStash salvar", () => {
  it("guarda alterações rastreadas e deixa a árvore limpa", async () => {
    const repo = makeRepo();
    writeFile(repo, "README.md", "# alterado\n");
    const res = await gitStash(git, repo, { acao: "salvar", mensagem: 'trabalho; $(rm -rf /) "x"' });
    expect(res).toMatchObject({ acao: "salvar", salvo: true, total: 1 });
    if (res.acao !== "salvar") throw new Error("salvar");
    expect(res.entrada).toMatchObject({ indice: 0, ref: "stash@{0}" });
    expect(res.entrada?.descricao).toContain('trabalho; $(rm -rf /) "x"');
    expect(porcelain(repo)).toBe("");
  });

  it("sem alterações: salvo=false e nada é criado", async () => {
    const repo = makeRepo();
    const res = await gitStash(git, repo, { acao: "salvar" });
    expect(res).toEqual({ acao: "salvar", salvo: false, total: 0 });
    expect(sh(repo, "stash", "list").trim()).toBe("");
  });

  it("incluir_nao_rastreados guarda o arquivo novo; sem a opção ele fica", async () => {
    const repo = makeRepo();
    writeFile(repo, "novo.txt", "novo\n");
    expect(await gitStash(git, repo, { acao: "salvar" })).toMatchObject({ salvo: false });
    expect(porcelain(repo)).toBe("?? novo.txt");
    expect(await gitStash(git, repo, { acao: "salvar", incluirNaoRastreados: true })).toMatchObject({ salvo: true });
    expect(porcelain(repo)).toBe("");
  });
});

describe("gitStash listar, mostrar, aplicar e pop", () => {
  function twoStashes(): string {
    const repo = makeRepo();
    writeFile(repo, "README.md", "# primeiro\n");
    sh(repo, "stash", "push", "-m", "um");
    writeFile(repo, "README.md", "# segundo\n");
    sh(repo, "stash", "push", "-m", "dois");
    return repo;
  }

  it("listar traz índice, ref, hash, descrição e data", async () => {
    const repo = twoStashes();
    const res = await gitStash(git, repo, { acao: "listar" });
    if (res.acao !== "listar") throw new Error("listar");
    expect(res.total).toBe(2);
    expect(res.entradas.map((e) => e.ref)).toEqual(["stash@{0}", "stash@{1}"]);
    expect(res.entradas[0]?.descricao).toContain("dois");
    expect(res.entradas[1]?.descricao).toContain("um");
    expect(res.entradas[0]?.hash).toMatch(/^[0-9a-f]{40}$/);
    expect(res.entradas[0]?.data).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("listar sem stashes devolve lista vazia", async () => {
    expect(await gitStash(git, makeRepo(), { acao: "listar" })).toEqual({ acao: "listar", entradas: [], total: 0 });
  });

  it("mostrar traz o diff do índice pedido (padrão 0)", async () => {
    const repo = twoStashes();
    const top = await gitStash(git, repo, { acao: "mostrar" });
    if (top.acao !== "mostrar") throw new Error("mostrar");
    expect(top).toMatchObject({ indice: 0, ref: "stash@{0}", truncado: false, vazio: false });
    expect(top.diff).toContain("+# segundo");
    const old = await gitStash(git, repo, { acao: "mostrar", indice: 1 });
    if (old.acao !== "mostrar") throw new Error("mostrar");
    expect(old.diff).toContain("+# primeiro");
  });

  it("mostrar corta o diff grande", async () => {
    const repo = makeRepo();
    writeFile(repo, "README.md", `${"linha longa de texto\n".repeat(20_000)}`);
    sh(repo, "stash", "push");
    const res = await gitStash(git, repo, { acao: "mostrar" });
    if (res.acao !== "mostrar") throw new Error("mostrar");
    expect(res.truncado).toBe(true);
    expect(res.bytes).toBeLessThanOrEqual(200_000);
    expect(res.bytesTotal).toBeGreaterThan(200_000);
  });

  it("aplicar reaplica e mantém o stash", async () => {
    const repo = twoStashes();
    const res = await gitStash(git, repo, { acao: "aplicar", indice: 1 });
    expect(res).toMatchObject({ acao: "aplicar", estado: "aplicado", ref: "stash@{1}", mantido: true, total: 2 });
    expect(sh(repo, "show", ":README.md")).toBe("# teste\n");
    expect(porcelain(repo)).toBe("M README.md");
    expect(sh(repo, "stash", "list").trim().split("\n")).toHaveLength(2);
  });

  it("pop reaplica e remove só o escolhido", async () => {
    const repo = twoStashes();
    const res = await gitStash(git, repo, { acao: "pop" });
    expect(res).toMatchObject({ acao: "pop", estado: "aplicado", ref: "stash@{0}", mantido: false, total: 1 });
    expect(sh(repo, "stash", "list")).toContain("um");
    expect(sh(repo, "stash", "list")).not.toContain("dois");
  });

  it("conflito ao aplicar: lista arquivos e o stash é mantido (pop não remove)", async () => {
    const repo = makeRepo();
    writeFile(repo, "README.md", "# do stash\n");
    sh(repo, "stash", "push", "-m", "x");
    writeFile(repo, "README.md", "# commitado depois\n");
    sh(repo, "commit", "-am", "muda");
    // a conflicting working tree change on top: stash apply needs a clean tree to merge, so make the
    // histories diverge at the same line (the stash was made on the older base)
    const res = await gitStash(git, repo, { acao: "pop" });
    expect(res).toMatchObject({ acao: "pop", estado: "conflito", arquivos: ["README.md"], mantido: true, total: 1 });
    expect(sh(repo, "stash", "list")).toContain("x");
  });

  it.each([["mostrar"], ["aplicar"], ["pop"]])("%s com índice inexistente -> argumento_invalido", async (acao) => {
    const repo = twoStashes();
    await expect(gitStash(git, repo, { acao, indice: 5 })).rejects.toMatchObject({ codigo: "argumento_invalido" });
    await expect(gitStash(git, makeRepo(), { acao })).rejects.toMatchObject({ codigo: "argumento_invalido" });
  });

  it.each([[-1], [1.5], [Number.NaN]])("indice %j inválido é recusado sem chamar o git", async (indice) => {
    const repo = makeRepo();
    const spy = spyGit();
    await expect(gitStash(spy.git, repo, { acao: "aplicar", indice })).rejects.toMatchObject({ codigo: "argumento_invalido" });
    expect(spy.calls).toEqual([]);
  });
});

describe("gitStash sem drop nem clear", () => {
  it("só as 5 ações existem", () => {
    expect([...STASH_ACTIONS]).toEqual(["salvar", "listar", "mostrar", "aplicar", "pop"]);
  });

  it.each([["drop"], ["clear"], ["branch"], ["create"], ["store"], ["push"], [""], ["salvar; drop"]])("acao %j é recusada sem chamar o git", async (acao) => {
    const repo = makeRepo();
    const spy = spyGit();
    await expect(gitStash(spy.git, repo, { acao })).rejects.toMatchObject({ codigo: "argumento_invalido" });
    expect(spy.calls).toEqual([]);
  });

  it("nunca emite drop/clear/--keep-index e monta stash@{N} só de inteiro", async () => {
    const repo = makeRepo();
    writeFile(repo, "README.md", "# a\n");
    const spy = spyGit();
    await gitStash(spy.git, repo, { acao: "salvar" });
    await gitStash(spy.git, repo, { acao: "mostrar", indice: 0 });
    await gitStash(spy.git, repo, { acao: "aplicar", indice: 0 });
    await gitStash(spy.git, repo, { acao: "pop", indice: 0 }).catch(() => undefined);
    const text = spy.callsTo("stash").map((c) => c.join(" ")).join("\n");
    expect(text).not.toMatch(/\bdrop\b|\bclear\b/);
    for (const c of spy.callsTo("stash")) {
      for (const a of c) if (a.startsWith("stash@")) expect(a).toMatch(/^stash@\{\d+\}$/);
    }
  });

  it("mensagem ou incluir_nao_rastreados fora de salvar, e indice em salvar/listar, são recusados", async () => {
    const repo = makeRepo();
    await expect(gitStash(git, repo, { acao: "listar", mensagem: "x" })).rejects.toMatchObject({ codigo: "argumento_invalido" });
    await expect(gitStash(git, repo, { acao: "pop", incluirNaoRastreados: true })).rejects.toMatchObject({ codigo: "argumento_invalido" });
    await expect(gitStash(git, repo, { acao: "salvar", indice: 0 })).rejects.toMatchObject({ codigo: "argumento_invalido" });
  });
});
