import { afterAll, describe, expect, it } from "vitest";
import { createNodeGit } from "../../../src/core/git-runner";
import { GuardError } from "../../../src/core/guards";
import { gitLog, parseLog } from "../../../src/core/git/log";
import { cleanupTemp, makeRepo, makeTempDir, sh, writeFile } from "../../helpers/git-repos";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

afterAll(cleanupTemp);
const git = createNodeGit();

/** Repository with 4 commits; the third has a multiline message with accents. */
function history(): string {
  const repo = makeRepo();
  writeFile(repo, "a.txt", "a\n");
  sh(repo, "add", "a.txt");
  sh(repo, "commit", "-m", "adiciona a");
  writeFile(repo, "b.txt", "b\n");
  sh(repo, "add", "b.txt");
  sh(repo, "commit", "-m", "Correção do módulo ação\n\nExplica a mudança em detalhe,\ncom várias linhas e acentuação.");
  writeFile(repo, "a.txt", "a2\n");
  sh(repo, "commit", "-am", "muda a pela outra pessoa", "--author=Outra Pessoa <outra@example.com>");
  return repo;
}

describe("parseLog", () => {
  it("separa campos e registros, inclusive assunto com acentos", () => {
    const h = "a".repeat(40);
    const p = "b".repeat(40);
    const raw = `${h}\x1fJosé\x1fjose@x.com\x1f2026-10-22T10:00:00-03:00\x1fAção rápida\x1f${p}\x1e\n${p}\x1fAna\x1fana@x.com\x1f2026-10-21T09:00:00-03:00\x1fantes\x1f\x1e\n`;
    const list = parseLog(raw);
    expect(list).toHaveLength(2);
    expect(list[0]).toMatchObject({ hash: h, hashCurto: "aaaaaaa", autor: "José", assunto: "Ação rápida", pais: [p] });
    expect(list[1]?.pais).toEqual([]);
  });
});

describe("gitLog", () => {
  it("lista do mais novo para o mais antigo, com acentos e só a primeira linha como assunto", async () => {
    const repo = history();
    const res = await gitLog(git, repo, {});
    expect(res.commits.map((c) => c.assunto)).toEqual(["muda a pela outra pessoa", "Correção do módulo ação", "adiciona a", "commit inicial"]);
    expect(res.commits[0]).toMatchObject({ autor: "Outra Pessoa", email: "outra@example.com" });
    expect(res.commits[0]?.pais).toHaveLength(1);
    expect(res.commits[3]?.pais).toEqual([]);
    expect(res.commits[0]?.data).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(res.limite).toBe(10);
    expect(res.podeHaverMais).toBe(false);
  });

  it("limite padrão é 10 e sinaliza podeHaverMais quando há mais commits", async () => {
    const repo = makeRepo();
    for (let i = 1; i <= 11; i++) {
      writeFile(repo, `file${i}.txt`, `conteudo ${i}\n`);
      sh(repo, "add", `file${i}.txt`);
      sh(repo, "commit", "-m", `commit ${i}`);
    }
    const res = await gitLog(git, repo, {});
    expect(res.limite).toBe(10);
    expect(res.commits).toHaveLength(10);
    expect(res.podeHaverMais).toBe(true);
  });

  it("limite, autor, caminho, ref e intervalo", async () => {
    const repo = history();
    const limited = await gitLog(git, repo, { limite: 2 });
    expect(limited.commits).toHaveLength(2);
    expect(limited.podeHaverMais).toBe(true);

    const byAuthor = await gitLog(git, repo, { autor: "Outra" });
    expect(byAuthor.commits.map((c) => c.assunto)).toEqual(["muda a pela outra pessoa"]);

    const byPath = await gitLog(git, repo, { caminho: "a.txt" });
    expect(byPath.commits.map((c) => c.assunto)).toEqual(["muda a pela outra pessoa", "adiciona a"]);

    const byRef = await gitLog(git, repo, { ref: "HEAD~2" });
    expect(byRef.commits.map((c) => c.assunto)).toEqual(["adiciona a", "commit inicial"]);

    const range = await gitLog(git, repo, { intervalo: "HEAD~2..HEAD" });
    expect(range.commits).toHaveLength(2);
    const range3 = await gitLog(git, repo, { intervalo: "HEAD~2...HEAD" });
    expect(range3.commits.length).toBeGreaterThan(0);
  });

  it("desde e ate filtram por data", async () => {
    const repo = history();
    expect((await gitLog(git, repo, { ate: "2000-01-01" })).commits).toEqual([]);
    expect((await gitLog(git, repo, { desde: "2000-01-01" })).commits).toHaveLength(4);
    expect((await gitLog(git, repo, { desde: "2000-01-01", ate: "2000-06-01" })).commits).toEqual([]);
  });

  it("com hash devolve o corpo completo da mensagem e as estatísticas", async () => {
    const repo = history();
    const res = await gitLog(git, repo, { hash: "HEAD~1" });
    expect(res.commits).toHaveLength(1);
    const c = res.commits[0];
    expect(c?.assunto).toBe("Correção do módulo ação");
    expect(c?.corpo).toBe("Explica a mudança em detalhe,\ncom várias linhas e acentuação.");
    expect(res.estatistica).toContain("b.txt");
    expect(res.estatistica).toContain("1 file changed");
  });

  it("repositório sem commits devolve lista vazia", async () => {
    const dir = makeTempDir();
    const repo = join(dir, "vazio");
    mkdirSync(repo);
    sh(repo, "init", "-b", "main");
    expect((await gitLog(git, repo, {})).commits).toEqual([]);
  });

  it("recusa argumentos inválidos sem chamar o git", async () => {
    const repo = history();
    const never = () => Promise.reject(new Error("o git não devia ser chamado"));
    await expect(gitLog(never, repo, { limite: 0 })).rejects.toThrow(GuardError);
    await expect(gitLog(never, repo, { limite: 201 })).rejects.toThrow(GuardError);
    await expect(gitLog(never, repo, { ref: "--all" })).rejects.toThrow(GuardError);
    await expect(gitLog(never, repo, { ref: "main", intervalo: "a..b" })).rejects.toThrow(/ref ou intervalo/);
    await expect(gitLog(never, repo, { intervalo: "semdoispontos" })).rejects.toThrow(GuardError);
    await expect(gitLog(never, repo, { intervalo: "--all..main" })).rejects.toThrow(GuardError);
    await expect(gitLog(never, repo, { intervalo: ".." })).rejects.toThrow(GuardError);
    await expect(gitLog(never, repo, { caminho: "../x" })).rejects.toThrow(GuardError);
    await expect(gitLog(never, repo, { hash: "-p" })).rejects.toThrow(GuardError);
  });

  it("valor do usuário vai colado na flag e nunca vira outra flag", async () => {
    const calls: string[][] = [];
    const spy = (_cwd: string, args: string[]): Promise<string> => {
      calls.push(args);
      return Promise.resolve("");
    };
    await gitLog(spy, "/x", { autor: "--output=/tmp/x", desde: "--all", ate: "-n1" });
    const argv = calls[0] ?? [];
    expect(argv).toContain("--author=--output=/tmp/x");
    expect(argv).toContain("--since=--all");
    expect(argv).toContain("--until=-n1");
    expect(argv).not.toContain("--output=/tmp/x");
  });
});
