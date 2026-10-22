import { afterAll, describe, expect, it } from "vitest";
import { createNodeGit } from "../../../src/core/git-runner";
import { TAG_LIST_LIMIT, gitTag } from "../../../src/core/git/tag";
import { cleanupTemp, makeRepo, sh, writeFile } from "../../helpers/git-repos";
import { spyGit } from "../../helpers/spy-git";

afterAll(cleanupTemp);
const git = createNodeGit();

function commitFile(repo: string, name: string): string {
  writeFile(repo, name, `${name}\n`);
  sh(repo, "add", name);
  sh(repo, "commit", "-m", `add ${name}`);
  return sh(repo, "rev-parse", "HEAD").trim();
}

describe("gitTag criar", () => {
  it("cria tag anotada no HEAD com a mensagem multilinha", async () => {
    const repo = makeRepo();
    const head = sh(repo, "rev-parse", "HEAD").trim();
    const res = await gitTag(git, repo, { acao: "criar", nome: "v0.1.0", mensagem: 'Primeira\n\nSegunda linha; $(rm -rf /) "x"' });
    expect(res).toMatchObject({ acao: "criar", nome: "v0.1.0", hash: head });
    expect(sh(repo, "cat-file", "-t", "v0.1.0").trim()).toBe("tag");
    expect(sh(repo, "rev-parse", "v0.1.0^{commit}").trim()).toBe(head);
    expect(sh(repo, "tag", "-l", "--format=%(contents)", "v0.1.0").trimEnd()).toBe('Primeira\n\nSegunda linha; $(rm -rf /) "x"');
  });

  it("cria a tag em um commit informado", async () => {
    const repo = makeRepo();
    const first = sh(repo, "rev-parse", "HEAD").trim();
    commitFile(repo, "a.txt");
    const res = await gitTag(git, repo, { acao: "criar", nome: "v0.0.1", commit: first, mensagem: "antiga" });
    expect(res).toMatchObject({ hash: first });
    expect(sh(repo, "rev-parse", "v0.0.1^{commit}").trim()).toBe(first);
  });

  it("recusa tag existente e a deixa intacta", async () => {
    const repo = makeRepo();
    await gitTag(git, repo, { acao: "criar", nome: "v1", mensagem: "um" });
    const before = sh(repo, "rev-parse", "v1").trim();
    commitFile(repo, "a.txt");
    await expect(gitTag(git, repo, { acao: "criar", nome: "v1", mensagem: "dois" })).rejects.toMatchObject({ codigo: "argumento_invalido", message: expect.stringContaining("já existe") });
    expect(sh(repo, "rev-parse", "v1").trim()).toBe(before);
  });

  it.each([["-x"], ["a..b"], ["a b"], ["v1~"], ["v1^"], ["v1:2"], ["a?b"], ["a*b"], ["a[b"], ["a\\b"], ["a@{b"], ["x.lock"], [".oculta"], ["HEAD"], ["@"], ["--delete"], ["-d"], ["-f"]])("nome %j é recusado sem criar tag", async (nome) => {
    const repo = makeRepo();
    const spy = spyGit();
    await expect(gitTag(spy.git, repo, { acao: "criar", nome, mensagem: "m" })).rejects.toMatchObject({ codigo: "argumento_invalido" });
    expect(spy.callsTo("tag")).toEqual([]);
    expect(sh(repo, "tag", "--list").trim()).toBe("");
  });

  it("exige nome e mensagem", async () => {
    const repo = makeRepo();
    await expect(gitTag(git, repo, { acao: "criar", mensagem: "m" })).rejects.toMatchObject({ codigo: "argumento_invalido" });
    await expect(gitTag(git, repo, { acao: "criar", nome: "v1" })).rejects.toMatchObject({ codigo: "argumento_invalido" });
    await expect(gitTag(git, repo, { acao: "criar", nome: "v1", mensagem: "  " })).rejects.toMatchObject({ codigo: "argumento_invalido" });
  });

  it("commit inexistente ou perigoso é recusado", async () => {
    const repo = makeRepo();
    await expect(gitTag(git, repo, { acao: "criar", nome: "v1", mensagem: "m", commit: "nao-existe" })).rejects.toMatchObject({ codigo: "argumento_invalido" });
    await expect(gitTag(git, repo, { acao: "criar", nome: "v1", mensagem: "m", commit: "--force" })).rejects.toMatchObject({ codigo: "argumento_invalido" });
    expect(sh(repo, "tag", "--list").trim()).toBe("");
  });

  it("nunca usa -d/--delete/-f e envia a mensagem pelo stdin", async () => {
    const repo = makeRepo();
    const spy = spyGit();
    await gitTag(spy.git, repo, { acao: "criar", nome: "v2", mensagem: "m" });
    const argv = spy.callsTo("tag")[0] ?? [];
    expect(argv.join(" ")).not.toMatch(/(^| )(-d|-D|-f|--delete|--force)( |$)/);
    expect(argv).toEqual(expect.arrayContaining(["-a", "-F", "-"]));
  });
});

describe("gitTag listar", () => {
  it("lista com nome, commit apontado, anotada, data e assunto; mais nova primeiro", async () => {
    const repo = makeRepo();
    const first = sh(repo, "rev-parse", "HEAD").trim();
    await gitTag(git, repo, { acao: "criar", nome: "v1", mensagem: "primeira versão\n\ncorpo" });
    const second = commitFile(repo, "a.txt");
    sh(repo, "tag", "leve", second);
    const res = await gitTag(git, repo, { acao: "listar" });
    if (res.acao !== "listar") throw new Error("listar");
    expect(res.total).toBe(2);
    expect(res.truncado).toBe(false);
    const byName = Object.fromEntries(res.tags.map((t) => [t.nome, t]));
    expect(byName.v1).toMatchObject({ hash: first, anotada: true, assunto: "primeira versão" });
    expect(byName.leve).toMatchObject({ hash: second, anotada: false });
    expect(byName.v1?.data).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("sem tags devolve lista vazia", async () => {
    expect(await gitTag(git, makeRepo(), { acao: "listar" })).toEqual({ acao: "listar", tags: [], total: 0, truncado: false });
  });

  it(`corta em ${TAG_LIST_LIMIT} e marca truncado`, async () => {
    const repo = makeRepo();
    const head = sh(repo, "rev-parse", "HEAD").trim();
    const lines = Array.from({ length: TAG_LIST_LIMIT + 5 }, (_, i) => `${head} refs/tags/t${i}`);
    writeFile(repo, ".git/packed-refs", `${lines.join("\n")}\n`);
    const res = await gitTag(git, repo, { acao: "listar" });
    if (res.acao !== "listar") throw new Error("listar");
    expect(res.total).toBe(TAG_LIST_LIMIT + 5);
    expect(res.tags).toHaveLength(TAG_LIST_LIMIT);
    expect(res.truncado).toBe(true);
  });

  it("nome, commit ou mensagem com listar -> argumento_invalido", async () => {
    const repo = makeRepo();
    await expect(gitTag(git, repo, { acao: "listar", nome: "x" })).rejects.toMatchObject({ codigo: "argumento_invalido" });
  });

  it.each([["deletar"], ["apagar"], ["delete"], ["-d"], [""], ["listar; criar"]])("acao %j é recusada sem chamar o git", async (acao) => {
    const spy = spyGit();
    await expect(gitTag(spy.git, makeRepo(), { acao })).rejects.toMatchObject({ codigo: "argumento_invalido" });
    expect(spy.calls).toEqual([]);
  });
});
