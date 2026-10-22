import { rmSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createNodeGit } from "../../../src/core/git-runner";
import { gitAdd } from "../../../src/core/git/add";
import { cleanupTemp, makeRepo, sh, writeFile } from "../../helpers/git-repos";
import { MUTATING, spyGit } from "../../helpers/spy-git";

afterAll(cleanupTemp);
const git = createNodeGit();

const staged = (repo: string): string[] => sh(repo, "diff", "--cached", "--name-only").split(/\r?\n/).filter(Boolean);

describe("gitAdd", () => {
  it("adiciona caminhos e devolve o que ficou no stage", async () => {
    const repo = makeRepo();
    writeFile(repo, "a.txt", "a\n");
    writeFile(repo, "b.txt", "b\n");
    const res = await gitAdd(git, repo, { caminhos: ["a.txt"] });
    expect(res).toMatchObject({ recusado: false, adicionados: ["a.txt"] });
    expect(staged(repo)).toEqual(["a.txt"]);
  });

  it("todos adiciona tudo, inclusive novos e removidos", async () => {
    const repo = makeRepo();
    writeFile(repo, "a.txt", "a\n");
    writeFile(repo, "pasta/b.txt", "b\n");
    rmSync(join(repo, "README.md"));
    const res = await gitAdd(git, repo, { todos: true });
    expect(res.recusado).toBe(false);
    expect(staged(repo).sort()).toEqual(["README.md", "a.txt", "pasta/b.txt"].sort());
  });

  it("exige exatamente um entre caminhos e todos", async () => {
    const repo = makeRepo();
    const spy = spyGit();
    await expect(gitAdd(spy.git, repo, {})).rejects.toMatchObject({ codigo: "argumento_invalido" });
    await expect(gitAdd(spy.git, repo, { caminhos: ["a"], todos: true })).rejects.toMatchObject({ codigo: "argumento_invalido" });
    await expect(gitAdd(spy.git, repo, { caminhos: [] })).rejects.toMatchObject({ codigo: "argumento_invalido" });
    expect(spy.callsTo(...MUTATING)).toEqual([]);
  });

  it(".env é recusado sem confirmar_sensivel e nada vai para o stage", async () => {
    const repo = makeRepo();
    writeFile(repo, ".env", "TOKEN=abc\n");
    writeFile(repo, "ok.txt", "ok\n");
    const byPath = await gitAdd(git, repo, { caminhos: [".env"] });
    expect(byPath).toEqual({ recusado: true, sensiveis: [".env"] });
    const byAll = await gitAdd(git, repo, { todos: true });
    expect(byAll).toEqual({ recusado: true, sensiveis: [".env"] });
    expect(staged(repo)).toEqual([]);
  });

  it("pega o sensível dentro de uma pasta pedida por caminho", async () => {
    const repo = makeRepo();
    writeFile(repo, "cfg/chave.pem", "x\n");
    writeFile(repo, "cfg/outro.txt", "y\n");
    const res = await gitAdd(git, repo, { caminhos: ["cfg"] });
    expect(res).toEqual({ recusado: true, sensiveis: ["cfg/chave.pem"] });
    expect(staged(repo)).toEqual([]);
    // the safe file alone goes through
    const safe = await gitAdd(git, repo, { caminhos: ["cfg/outro.txt"] });
    expect(safe.recusado).toBe(false);
    expect(staged(repo)).toEqual(["cfg/outro.txt"]);
  });

  it("com confirmar_sensivel o .env é adicionado", async () => {
    const repo = makeRepo();
    writeFile(repo, ".env", "TOKEN=abc\n");
    const res = await gitAdd(git, repo, { caminhos: [".env"], confirmarSensivel: true });
    expect(res).toMatchObject({ recusado: false, sensiveisConfirmados: [".env"] });
    expect(staged(repo)).toEqual([".env"]);
  });

  it("a remoção de um arquivo sensível rastreado não é recusada", async () => {
    const repo = makeRepo();
    writeFile(repo, ".env", "x\n");
    sh(repo, "add", "-f", ".env");
    sh(repo, "commit", "-m", "env");
    sh(repo, "rm", "-q", "-f", ".env");
    writeFile(repo, "novo.txt", "n\n");
    const res = await gitAdd(git, repo, { todos: true });
    expect(res.recusado).toBe(false);
    expect(staged(repo).sort()).toEqual([".env", "novo.txt"]);
  });

  it.each([["--force"], ["-f"], ["-A"], [":(exclude)x"], ["../fora.txt"], ["/abs/x"], ["-u"]])("recusa o caminho %j sem chamar o git", async (p) => {
    const repo = makeRepo();
    const spy = spyGit();
    await expect(gitAdd(spy.git, repo, { caminhos: [p] })).rejects.toMatchObject({ codigo: "argumento_invalido" });
    expect(spy.callsTo(...MUTATING)).toEqual([]);
  });

  it("caminho inexistente falha no git sem forçar", async () => {
    const repo = makeRepo();
    await expect(gitAdd(git, repo, { caminhos: ["nao-existe.txt"] })).rejects.toMatchObject({ name: "GitError" });
  });
});
