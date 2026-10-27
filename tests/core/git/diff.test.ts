import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createNodeGit } from "../../../src/core/git-runner";
import { GuardError } from "../../../src/core/guards";
import { assertRevision, cutBytes, gitDiff } from "../../../src/core/git/diff";
import { cleanupTemp, makeRepo, sh, writeFile } from "../../helpers/git-repos";

afterAll(cleanupTemp);
const git = createNodeGit();

describe("assertRevision", () => {
  it.each(["main", "feature/x", "HEAD", "HEAD~2", "HEAD^", "main^2~1", "abc1234", "v1.0.0", "origin/develop"])("aceita %s", (rev) => {
    expect(assertRevision(rev)).toBe(rev);
  });
  it.each(["", "-x", "--output=x", "a..b", "a b", "main:arquivo", "main@{1}", "~1", "^main", "HEAD\n--cached"])("recusa %j", (rev) => {
    expect(() => assertRevision(rev)).toThrow(GuardError);
  });
});

describe("cutBytes", () => {
  it("não corta caractere multibyte ao meio", () => {
    const cut = cutBytes("ação", 3); // "a" + first byte of "ç"... must not leave U+FFFD
    expect(cut.truncado).toBe(true);
    expect(cut.text).not.toContain("�");
    expect(cut.bytesTotal).toBe(Buffer.byteLength("ação", "utf8"));
  });
  it("texto curto passa inteiro", () => {
    expect(cutBytes("abc", 10)).toEqual({ text: "abc", truncado: false, bytesTotal: 3 });
  });
});

describe("gitDiff", () => {
  it("worktree: mostra a alteração fora do stage e nada do stage", async () => {
    const repo = makeRepo();
    writeFile(repo, "README.md", "# teste\nlinha nova\n");
    const res = await gitDiff(git, repo, { alvo: "worktree" });
    expect(res.vazio).toBe(false);
    expect(res.diff).toContain("+linha nova");
    expect(res.diff.startsWith("diff --git")).toBe(true);
    const staged = await gitDiff(git, repo, { alvo: "staged" });
    expect(staged.vazio).toBe(true);
  });

  it("staged: mostra o que foi para o stage", async () => {
    const repo = makeRepo();
    writeFile(repo, "novo.txt", "conteudo\n");
    sh(repo, "add", "novo.txt");
    const res = await gitDiff(git, repo, { alvo: "staged" });
    expect(res.diff).toContain("+conteudo");
    expect(res.diff).toContain("novo.txt");
  });

  it("refs: base e head, head padrão HEAD, caminhos, stat e contexto", async () => {
    const repo = makeRepo();
    writeFile(repo, "a.txt", "1\n2\n3\n4\n5\n");
    writeFile(repo, "b.txt", "b\n");
    sh(repo, "add", ".");
    sh(repo, "commit", "-m", "dois arquivos");
    writeFile(repo, "a.txt", "1\n2\n3 mudou\n4\n5\n");
    sh(repo, "commit", "-am", "muda a");

    const all = await gitDiff(git, repo, { alvo: "refs", base: "HEAD~2" });
    expect(all).toMatchObject({ base: "HEAD~2", head: "HEAD" });
    expect(all.diff).toContain("a.txt");
    expect(all.diff).toContain("b.txt");

    const only = await gitDiff(git, repo, { alvo: "refs", base: "HEAD~1", head: "HEAD", caminhos: ["a.txt"] });
    expect(only.diff).toContain("3 mudou");
    expect(only.diff).not.toContain("b.txt");

    const stat = await gitDiff(git, repo, { alvo: "refs", base: "HEAD~2", stat: true });
    expect(stat.diff).toContain("a.txt");
    expect(stat.diff).toContain("2 files changed");
    expect(stat.diff).not.toContain("@@");

    const ctx0 = await gitDiff(git, repo, { alvo: "refs", base: "HEAD~1", contexto: 0 });
    expect(ctx0.diff).not.toContain(" 2\n");
    const ctx3 = await gitDiff(git, repo, { alvo: "refs", base: "HEAD~1", contexto: 3 });
    expect(ctx3.diff).toContain(" 2\n");
  });

  it("corta em max_bytes e marca truncado", async () => {
    const repo = makeRepo();
    writeFile(repo, "grande.txt", `${"linha de teste com acentuação ção\n".repeat(500)}`);
    sh(repo, "add", "grande.txt");
    const full = await gitDiff(git, repo, { alvo: "staged" });
    expect(full.truncado).toBe(false);
    const cut = await gitDiff(git, repo, { alvo: "staged", maxBytes: 1000 });
    expect(cut.truncado).toBe(true);
    expect(cut.bytes).toBeLessThanOrEqual(1000);
    expect(cut.bytesTotal).toBe(full.bytes);
    expect(cut.diff).not.toContain("�");
  });

  it("recusa argumentos inválidos sem chamar o git", async () => {
    const repo = makeRepo();
    const never = () => Promise.reject(new Error("o git não devia ser chamado"));
    await expect(gitDiff(never, repo, { alvo: "refs" })).rejects.toThrow(/exige a referência base/);
    await expect(gitDiff(never, repo, { alvo: "refs", base: "--output=/tmp/x" })).rejects.toThrow(GuardError);
    await expect(gitDiff(never, repo, { alvo: "refs", base: "main", head: "a b" })).rejects.toThrow(GuardError);
    await expect(gitDiff(never, repo, { alvo: "worktree", base: "main" })).rejects.toThrow(/só valem com alvo=refs/);
    await expect(gitDiff(never, repo, { alvo: "worktree", caminhos: ["../fora"] })).rejects.toThrow(GuardError);
    await expect(gitDiff(never, repo, { alvo: "worktree", caminhos: ["--cached"] })).rejects.toThrow(GuardError);
    await expect(gitDiff(never, repo, { alvo: "worktree", contexto: -1 })).rejects.toThrow(GuardError);
    await expect(gitDiff(never, repo, { alvo: "worktree", maxBytes: 0 })).rejects.toThrow(GuardError);
    await expect(gitDiff(never, repo, { alvo: "outro" as unknown as "refs" })).rejects.toThrow(GuardError);
  });

  it("remove linhas de índice e lista omitidos quando cortado", async () => {
    const repo = makeRepo();
    writeFile(repo, "a.txt", "conteudo a\n");
    writeFile(repo, "b.txt", "conteudo b\n");
    sh(repo, "add", ".");
    sh(repo, "commit", "-m", "inicial");

    writeFile(repo, "README.md", "# alterado readme\n");
    writeFile(repo, "a.txt", "conteudo a alterado\n");
    writeFile(repo, "b.txt", "conteudo b alterado\n");

    const res = await gitDiff(git, repo, { alvo: "worktree" });
    expect(res.diff).not.toMatch(/^index /m);
    expect(res.omitidos).toEqual([]);

    const secondHeader = res.diff.indexOf("\ndiff --git", 1);
    expect(secondHeader).toBeGreaterThan(0);
    const cut = await gitDiff(git, repo, { alvo: "worktree", maxBytes: secondHeader - 1 });
    expect(cut.truncado).toBe(true);
    expect(cut.omitidos).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ caminho: "a.txt", adicionadas: expect.any(Number), removidas: expect.any(Number) }),
        expect.objectContaining({ caminho: "b.txt", adicionadas: expect.any(Number), removidas: expect.any(Number) }),
      ]),
    );
    expect(cut.omitidos.map((o) => o.caminho)).not.toContain("README.md");
  });

  it("stat: true com maxBytes minúsculo: omitidos é []", async () => {
    const repo = makeRepo();
    writeFile(repo, "a.txt", "1\n");
    writeFile(repo, "b.txt", "2\n");
    sh(repo, "add", ".");
    sh(repo, "commit", "-m", "inicial");
    writeFile(repo, "a.txt", "1 mudou\n");
    writeFile(repo, "b.txt", "2 mudou\n");
    const res = await gitDiff(git, repo, { alvo: "worktree", stat: true, maxBytes: 10 });
    expect(res.truncado).toBe(true);
    expect(res.omitidos).toEqual([]);
  });

  it("sem maxBytes devolve truncado true e bytes <= 40000 para diff de ~100000 bytes", async () => {
    const repo = makeRepo();
    writeFile(repo, "grande.txt", "inicio\n");
    sh(repo, "add", ".");
    sh(repo, "commit", "-m", "inicio");
    const linha = "123456789012345678901234567890123456789\n";
    writeFile(repo, "grande.txt", linha.repeat(3000));
    const res = await gitDiff(git, repo, { alvo: "worktree" });
    expect(res.truncado).toBe(true);
    expect(res.bytes).toBeLessThanOrEqual(40_000);
  });

  it("arquivo binário alterado aparece em omitidos com adicionadas null quando cortado", async () => {
    const repo = makeRepo();
    const binPath = join(repo, "imagem.bin");
    writeFileSync(binPath, Buffer.from([0, 1, 2, 3, 4, 5, 6, 7]));
    sh(repo, "add", ".");
    sh(repo, "commit", "-m", "commit binario");

    writeFile(repo, "README.md", `${"linha de texto longa\n".repeat(100)}`);
    writeFileSync(binPath, Buffer.from([7, 6, 5, 4, 3, 2, 1, 0, 99]));

    const full = await gitDiff(git, repo, { alvo: "worktree" });
    const binHeader = full.diff.indexOf("\ndiff --git a/imagem.bin", 1);
    expect(binHeader).toBeGreaterThan(0);

    const cut = await gitDiff(git, repo, { alvo: "worktree", maxBytes: binHeader - 1 });
    expect(cut.truncado).toBe(true);
    const binOmitido = cut.omitidos.find((o) => o.caminho === "imagem.bin");
    expect(binOmitido).toBeDefined();
    expect(binOmitido?.adicionadas).toBeNull();
    expect(binOmitido?.removidas).toBeNull();
  });
});
