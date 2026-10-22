import { chmodSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { createNodeGit } from "../../../src/core/git-runner";
import { buildMessage, gitCommit } from "../../../src/core/git/commit";
import { cleanupTemp, makeRepo, sh, writeFile } from "../../helpers/git-repos";
import { spyGit } from "../../helpers/spy-git";

afterAll(cleanupTemp);
const git = createNodeGit();

describe("buildMessage", () => {
  it("junta título, linha em branco e descrição", () => {
    expect(buildMessage("titulo", "linha 1\nlinha 2")).toBe("titulo\n\nlinha 1\nlinha 2\n");
    expect(buildMessage("  só título \n")).toBe("só título\n");
    expect(buildMessage("a\r\nb")).toBe("a\nb\n");
  });
  it("recusa mensagem vazia ou com caractere nulo", () => {
    expect(() => buildMessage("   ")).toThrow(/obrigatória/);
    expect(() => buildMessage("a\0b")).toThrow(/nulo/);
  });
});

describe("gitCommit", () => {
  it("comita com mensagem de 3 linhas e devolve hash, arquivos e estatística", async () => {
    const repo = makeRepo();
    writeFile(repo, "a.txt", "a\n");
    sh(repo, "add", "a.txt");
    const res = await gitCommit(git, repo, { mensagem: "Linha um\n\nLinha três" });
    if (!res.criado) throw new Error("esperava commit criado");
    expect(res.hash).toBe(sh(repo, "rev-parse", "HEAD").trim());
    expect(res.branch).toBe("main");
    expect(res.arquivos).toEqual(["a.txt"]);
    expect(res.estatistica).toContain("a.txt");
    expect(sh(repo, "log", "-1", "--format=%B").trimEnd()).toBe("Linha um\n\nLinha três");
  });

  it("mensagem + descrição viram título, linha em branco e corpo, com acentos, aspas e crase", async () => {
    const repo = makeRepo();
    writeFile(repo, "a.txt", "a\n");
    sh(repo, "add", "a.txt");
    const res = await gitCommit(git, repo, { mensagem: 'feat: "ação" nova; $(rm -rf /)', descricao: "Corpo com `crase` e # hash\nsegunda linha" });
    expect(res.criado).toBe(true);
    expect(sh(repo, "log", "-1", "--format=%B").trimEnd()).toBe('feat: "ação" nova; $(rm -rf /)\n\nCorpo com `crase` e # hash\nsegunda linha');
  });

  it("sem nada no stage recusa e não cria commit", async () => {
    const repo = makeRepo();
    const before = sh(repo, "rev-parse", "HEAD");
    writeFile(repo, "solto.txt", "x\n"); // untracked, not staged
    const res = await gitCommit(git, repo, { mensagem: "nada" });
    expect(res).toEqual({ criado: false, motivo: "nada_a_commitar" });
    expect(sh(repo, "rev-parse", "HEAD")).toBe(before);
  });

  it("permitir_vazio cria commit vazio", async () => {
    const repo = makeRepo();
    const res = await gitCommit(git, repo, { mensagem: "vazio", permitirVazio: true });
    expect(res.criado).toBe(true);
    expect(sh(repo, "rev-list", "--count", "HEAD").trim()).toBe("2");
  });

  it("nunca usa --amend nem --no-verify", async () => {
    const repo = makeRepo();
    writeFile(repo, "a.txt", "a\n");
    sh(repo, "add", "a.txt");
    const spy = spyGit();
    await gitCommit(spy.git, repo, { mensagem: "x" });
    const commits = spy.callsTo("commit");
    expect(commits).toHaveLength(1);
    const flags = (commits[0] ?? []).join(" ");
    expect(flags).not.toMatch(/amend|no-verify|(^| )-n( |$)/);
    expect(commits[0]).toContain("-F");
  });

  it("erro de hook de pre-commit vira GitError com a saída do hook", async () => {
    const repo = makeRepo();
    const hook = writeFile(repo, ".git/hooks/pre-commit", "#!/bin/sh\necho 'lint falhou: arquivo feio' >&2\nexit 1\n");
    try {
      chmodSync(hook, 0o755);
    } catch {
      // Windows: git runs the hook through its own sh
    }
    writeFile(repo, "a.txt", "a\n");
    sh(repo, "add", "a.txt");
    const before = sh(repo, "rev-parse", "HEAD");
    await expect(gitCommit(git, repo, { mensagem: "x" })).rejects.toMatchObject({ name: "GitError", stderr: expect.stringContaining("lint falhou") });
    expect(sh(repo, "rev-parse", "HEAD")).toBe(before);
  });

  it("mensagem vazia é recusada antes de qualquer chamada", async () => {
    const repo = makeRepo();
    const spy = spyGit();
    await expect(gitCommit(spy.git, repo, { mensagem: "  " })).rejects.toMatchObject({ codigo: "argumento_invalido" });
    expect(spy.calls).toEqual([]);
  });

  it("concluir um merge cujo stage é igual ao HEAD não é recusado", async () => {
    const repo = makeRepo();
    sh(repo, "switch", "-c", "b");
    writeFile(repo, "f.txt", "b\n");
    sh(repo, "add", "f.txt");
    sh(repo, "commit", "-m", "b");
    sh(repo, "switch", "main");
    writeFile(repo, "f.txt", "main\n");
    sh(repo, "add", "f.txt");
    sh(repo, "commit", "-m", "m");
    try {
      sh(repo, "merge", "b");
    } catch {
      // conflict expected
    }
    writeFile(repo, "f.txt", "main\n"); // resolves to the same content as HEAD
    sh(repo, "add", "f.txt");
    const res = await gitCommit(git, repo, { mensagem: "merge b" });
    expect(res.criado).toBe(true);
  });
});
