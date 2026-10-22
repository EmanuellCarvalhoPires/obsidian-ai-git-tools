import { afterAll, describe, expect, it } from "vitest";
import { GitError, createNodeGit } from "../../../src/core/git-runner";
import { GuardError } from "../../../src/core/guards";
import { gitBlame, parseBlame } from "../../../src/core/git/blame";
import { cleanupTemp, makeRepo, sh, writeFile } from "../../helpers/git-repos";

afterAll(cleanupTemp);
const git = createNodeGit();

function repoWithTwoAuthors(): { repo: string; first: string; second: string } {
  const repo = makeRepo();
  writeFile(repo, "f.txt", "um\ndois\ntrês\nquatro\n");
  sh(repo, "add", "f.txt");
  sh(repo, "commit", "-m", "cria f");
  const first = sh(repo, "rev-parse", "HEAD").trim();
  writeFile(repo, "f.txt", "um\ndois mudou\ntrês\nquatro\ncinco\n");
  sh(repo, "commit", "-am", "altera f", "--author=Maria Souza <maria@example.com>");
  const second = sh(repo, "rev-parse", "HEAD").trim();
  return { repo, first, second };
}

describe("parseBlame", () => {
  it("lê o formato porcelain com grupos repetidos do mesmo commit", () => {
    const h = "a".repeat(40);
    const raw = [
      `${h} 1 1 2`,
      "author Ana",
      "author-mail <ana@x.com>",
      "author-time 1700000000",
      "author-tz -0300",
      "summary primeiro",
      "filename f.txt",
      "\tlinha um",
      `${h} 2 2`,
      "\tlinha dois\r",
      "",
    ].join("\n");
    const lines = parseBlame(raw);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ linha: 1, hash: h, autor: "Ana", email: "ana@x.com", resumo: "primeiro", conteudo: "linha um", data: "2023-11-14T22:13:20.000Z" });
    expect(lines[1]).toMatchObject({ linha: 2, autor: "Ana", conteudo: "linha dois" });
  });
});

describe("gitBlame", () => {
  it("arquivo inteiro: cada linha com o commit certo", async () => {
    const { repo, first, second } = repoWithTwoAuthors();
    const res = await gitBlame(git, repo, { caminho: "f.txt" });
    expect(res.truncado).toBe(false);
    expect(res.linhas.map((l) => l.conteudo)).toEqual(["um", "dois mudou", "três", "quatro", "cinco"]);
    expect(res.linhas[0]?.hash).toBe(first);
    expect(res.linhas[1]).toMatchObject({ hash: second, autor: "Maria Souza", email: "maria@example.com", resumo: "altera f" });
    expect(res.linhas[4]?.hash).toBe(second);
  });

  it("intervalo de linhas e só o início", async () => {
    const { repo } = repoWithTwoAuthors();
    const range = await gitBlame(git, repo, { caminho: "f.txt", linhaInicio: 2, linhaFim: 3 });
    expect(range.linhas.map((l) => l.linha)).toEqual([2, 3]);
    const fromTwo = await gitBlame(git, repo, { caminho: "f.txt", linhaInicio: 4 });
    expect(fromTwo.linhas.map((l) => l.linha)).toEqual([4, 5]);
    const toTwo = await gitBlame(git, repo, { caminho: "f.txt", linhaFim: 2 });
    expect(toTwo.linhas.map((l) => l.linha)).toEqual([1, 2]);
  });

  it("com ref examina o arquivo naquele commit", async () => {
    const { repo, first } = repoWithTwoAuthors();
    const res = await gitBlame(git, repo, { caminho: "f.txt", ref: first });
    expect(res.linhas.map((l) => l.conteudo)).toEqual(["um", "dois", "três", "quatro"]);
    expect(new Set(res.linhas.map((l) => l.hash))).toEqual(new Set([first]));
  });

  it("recusa argumentos inválidos sem chamar o git", async () => {
    const never = () => Promise.reject(new Error("o git não devia ser chamado"));
    await expect(gitBlame(never, "/x", { caminho: "../f.txt" })).rejects.toThrow(GuardError);
    await expect(gitBlame(never, "/x", { caminho: "--contents" })).rejects.toThrow(GuardError);
    await expect(gitBlame(never, "/x", { caminho: "f.txt", linhaInicio: 0 })).rejects.toThrow(GuardError);
    await expect(gitBlame(never, "/x", { caminho: "f.txt", linhaInicio: 5, linhaFim: 2 })).rejects.toThrow(GuardError);
    await expect(gitBlame(never, "/x", { caminho: "f.txt", ref: "-x" })).rejects.toThrow(GuardError);
  });

  it("arquivo inexistente vira GitError", async () => {
    const { repo } = repoWithTwoAuthors();
    await expect(gitBlame(git, repo, { caminho: "nao-existe.txt" })).rejects.toBeInstanceOf(GitError);
  });
});
