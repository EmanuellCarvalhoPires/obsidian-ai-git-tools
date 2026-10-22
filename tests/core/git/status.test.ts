import { afterAll, describe, expect, it } from "vitest";
import { createNodeGit } from "../../../src/core/git-runner";
import { gitStatus, parseStatus } from "../../../src/core/git/status";
import { cleanupTemp, makeRepo, makeRepoWithRemote, makeTempDir, sh, writeFile } from "../../helpers/git-repos";

afterAll(cleanupTemp);
const git = createNodeGit();

describe("parseStatus", () => {
  it("lê o cabeçalho, ahead/behind e os quatro tipos de entrada", () => {
    const raw = [
      "# branch.oid 1111111111111111111111111111111111111111",
      "# branch.head feature/x",
      "# branch.upstream origin/feature/x",
      "# branch.ab +2 -3",
      "1 M. N... 100644 100644 100644 aaa bbb staged.txt",
      "1 .M N... 100644 100644 100644 aaa bbb solto com espaço.txt",
      "1 MM N... 100644 100644 100644 aaa bbb ambos.txt",
      "2 R. N... 100644 100644 100644 aaa bbb R100 novo.txt",
      "velho.txt",
      "u UU N... 100644 100644 100644 100644 aaa bbb ccc conflito.txt",
      "? nao-rastreado.txt",
      "",
    ].join("\0");
    const st = parseStatus(raw);
    expect(st.branch).toBe("feature/x");
    expect(st.upstream).toBe("origin/feature/x");
    expect(st.ahead).toBe(2);
    expect(st.behind).toBe(3);
    expect(st.staged.map((e) => e.caminho)).toEqual(["staged.txt", "ambos.txt", "novo.txt"]);
    expect(st.staged[2]).toMatchObject({ status: "R", rotulo: "renomeado", origem: "velho.txt" });
    expect(st.unstaged.map((e) => e.caminho)).toEqual(["solto com espaço.txt", "ambos.txt"]);
    expect(st.conflitos).toEqual(["conflito.txt"]);
    expect(st.untracked).toEqual(["nao-rastreado.txt"]);
    expect(st.limpo).toBe(false);
  });

  it("HEAD solto e repositório sem commits viram undefined", () => {
    const st = parseStatus(["# branch.oid (initial)", "# branch.head (detached)", ""].join("\0"));
    expect(st.branch).toBeUndefined();
    expect(st.oid).toBeUndefined();
    expect(st.limpo).toBe(true);
  });
});

describe("gitStatus (repositório real)", () => {
  it("árvore limpa", async () => {
    const repo = makeRepo();
    const st = await gitStatus(git, repo);
    expect(st).toMatchObject({ branch: "main", limpo: true, ahead: 0, behind: 0, staged: [], unstaged: [], untracked: [], conflitos: [] });
    expect(st.oid).toMatch(/^[0-9a-f]{40}$/);
  });

  it("staged, unstaged, não rastreados e nomes com acento e espaço", async () => {
    const repo = makeRepo();
    writeFile(repo, "novo.txt", "a\n");
    sh(repo, "add", "novo.txt");
    writeFile(repo, "README.md", "# mudou\n");
    writeFile(repo, "ação com espaço.txt", "x\n");
    const st = await gitStatus(git, repo);
    expect(st.staged).toEqual([{ caminho: "novo.txt", status: "A", rotulo: "adicionado" }]);
    expect(st.unstaged).toEqual([{ caminho: "README.md", status: "M", rotulo: "modificado" }]);
    expect(st.untracked).toEqual(["ação com espaço.txt"]);
    expect(st.limpo).toBe(false);
  });

  it("renomeação no stage traz a origem", async () => {
    const repo = makeRepo();
    sh(repo, "mv", "README.md", "LEIAME.md");
    const st = await gitStatus(git, repo);
    expect(st.staged).toEqual([{ caminho: "LEIAME.md", status: "R", rotulo: "renomeado", origem: "README.md" }]);
  });

  it("conflito de merge", async () => {
    const repo = makeRepo();
    sh(repo, "switch", "-c", "outra");
    writeFile(repo, "README.md", "# da outra\n");
    sh(repo, "commit", "-am", "outra");
    sh(repo, "switch", "main");
    writeFile(repo, "README.md", "# da main\n");
    sh(repo, "commit", "-am", "main");
    try {
      sh(repo, "merge", "outra");
    } catch {
      // the conflict is the point
    }
    const st = await gitStatus(git, repo);
    expect(st.conflitos).toEqual(["README.md"]);
    expect(st.limpo).toBe(false);
  });

  it("ahead e behind em relação ao upstream", async () => {
    const { base, repo, remote } = makeRepoWithRemote();
    // another clone pushes one commit: the first repository will be behind
    const other = makeTempDir();
    sh(other, "clone", remote, "outro");
    const outro = `${other}/outro`;
    sh(outro, "config", "user.name", "Teste");
    sh(outro, "config", "user.email", "teste@example.com");
    writeFile(outro, "b.txt", "b\n");
    sh(outro, "add", "b.txt");
    sh(outro, "commit", "-m", "do outro");
    sh(outro, "push");
    // and the first one commits two local commits
    writeFile(repo, "c.txt", "c\n");
    sh(repo, "add", "c.txt");
    sh(repo, "commit", "-m", "c1");
    writeFile(repo, "d.txt", "d\n");
    sh(repo, "add", "d.txt");
    sh(repo, "commit", "-m", "c2");
    sh(repo, "fetch");
    const st = await gitStatus(git, repo);
    expect(st.upstream).toBe("origin/main");
    expect(st.ahead).toBe(2);
    expect(st.behind).toBe(1);
    expect(base).toBeTruthy();
  });
});
