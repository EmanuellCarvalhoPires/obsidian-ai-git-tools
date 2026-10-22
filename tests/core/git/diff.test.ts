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
});
