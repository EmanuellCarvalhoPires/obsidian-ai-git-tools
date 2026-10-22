import { afterAll, describe, expect, it } from "vitest";
import { createNodeGit } from "../../../src/core/git-runner";
import { PullNotFastForwardError, gitPull } from "../../../src/core/git/pull";
import { cleanupTemp, makeRepoWithRemote, sh, writeFile } from "../../helpers/git-repos";
import { MUTATING, configureClone, spyGit } from "../../helpers/spy-git";

afterAll(cleanupTemp);
const git = createNodeGit();

function commitFile(repo: string, name: string, content = `${name}\n`): string {
  writeFile(repo, name, content);
  sh(repo, "add", name);
  sh(repo, "commit", "-m", `add ${name}`);
  return sh(repo, "rev-parse", "HEAD").trim();
}

/** Repo with a remote and a second clone ("outro") that can push to it. */
function setup(): { repo: string; outro: string; remote: string } {
  const { base, repo, remote } = makeRepoWithRemote();
  sh(base, "clone", remote, "outro");
  const outro = `${base}/outro`;
  configureClone(sh, outro);
  return { repo, outro, remote };
}

describe("gitPull", () => {
  it("ff-only avança quando o remoto está à frente", async () => {
    const { repo, outro } = setup();
    const before = sh(repo, "rev-parse", "HEAD").trim();
    const tip = commitFile(outro, "novo.txt");
    sh(outro, "push", "origin", "main");
    const res = await gitPull(git, repo, {});
    expect(res).toMatchObject({ conflito: false, modo: "ff-only", antes: before, depois: tip, atualizado: true, commitsNovos: 1 });
    expect(sh(repo, "rev-parse", "HEAD").trim()).toBe(tip);
  });

  it("já em dia: atualizado=false", async () => {
    const { repo } = setup();
    const res = await gitPull(git, repo, { remoto: "origin", branch: "main" });
    expect(res).toMatchObject({ conflito: false, atualizado: false, commitsNovos: 0, remoto: "origin", branch: "main" });
  });

  it("ff-only com histórias divergentes falha com dica de usar o modo merge e nada muda", async () => {
    const { repo, outro } = setup();
    commitFile(outro, "r.txt");
    sh(outro, "push", "origin", "main");
    const local = commitFile(repo, "l.txt");
    const err = await gitPull(git, repo, {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PullNotFastForwardError);
    expect((err as PullNotFastForwardError).dica).toMatch(/merge/);
    expect(sh(repo, "rev-parse", "HEAD").trim()).toBe(local);
  });

  it("modo merge junta histórias divergentes sem conflito", async () => {
    const { repo, outro } = setup();
    commitFile(outro, "r.txt");
    sh(outro, "push", "origin", "main");
    commitFile(repo, "l.txt");
    const res = await gitPull(git, repo, { modo: "merge" });
    expect(res).toMatchObject({ conflito: false, modo: "merge", atualizado: true });
    expect(sh(repo, "rev-list", "--merges", "--count", "HEAD").trim()).toBe("1");
    expect(sh(repo, "ls-files").split(/\r?\n/)).toEqual(expect.arrayContaining(["l.txt", "r.txt"]));
  });

  it("modo merge com conflito devolve a lista e deixa o merge em andamento", async () => {
    const { repo, outro } = setup();
    commitFile(outro, "f.txt", "do outro\n");
    sh(outro, "push", "origin", "main");
    commitFile(repo, "f.txt", "do local\n");
    const res = await gitPull(git, repo, { modo: "merge" });
    expect(res).toEqual({ conflito: true, modo: "merge", arquivos: ["f.txt"] });
    expect(() => sh(repo, "rev-parse", "-q", "--verify", "MERGE_HEAD")).not.toThrow();
  });

  it("nunca monta rebase", async () => {
    const { repo } = setup();
    const spy = spyGit();
    await gitPull(spy.git, repo, { modo: "merge" });
    await gitPull(spy.git, repo, {});
    for (const call of spy.callsTo("pull")) {
      expect(call.join(" ")).not.toMatch(/--rebase|-r( |$)/);
    }
    expect(spy.callsTo("pull").map((c) => c[1])).toEqual(["--no-rebase", "--ff-only"]);
  });

  it.each([["rebase"], ["--rebase"], ["force"], [""], ["merge --no-verify"]])("recusa o modo %j sem chamar o pull", async (modo) => {
    const { repo } = setup();
    const spy = spyGit();
    await expect(gitPull(spy.git, repo, { modo: modo as "merge" })).rejects.toMatchObject({ codigo: "argumento_invalido" });
    expect(spy.callsTo(...MUTATING)).toEqual([]);
  });

  it.each([["--rebase"], ["--force"], ["-f"], ["--all"], ["https://example.com/x.git"], ["naoexiste"]])("recusa o remoto %j sem chamar o pull", async (remoto) => {
    const { repo } = setup();
    const spy = spyGit();
    await expect(gitPull(spy.git, repo, { remoto })).rejects.toMatchObject({ codigo: "argumento_invalido" });
    expect(spy.callsTo(...MUTATING)).toEqual([]);
  });

  it.each([["--rebase"], ["-D"], ["+main"], ["a..b"], ["main:main"]])("recusa a branch %j sem chamar o pull", async (branch) => {
    const { repo } = setup();
    const spy = spyGit();
    await expect(gitPull(spy.git, repo, { branch })).rejects.toMatchObject({ codigo: "argumento_invalido" });
    expect(spy.callsTo(...MUTATING)).toEqual([]);
  });
});
