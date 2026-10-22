import { afterAll, describe, expect, it } from "vitest";
import { createNodeGit } from "../../../src/core/git-runner";
import { gitFetch } from "../../../src/core/git/fetch";
import { cleanupTemp, makeRepoWithRemote, sh, writeFile } from "../../helpers/git-repos";
import { MUTATING, configureClone, spyGit } from "../../helpers/spy-git";

afterAll(cleanupTemp);
const git = createNodeGit();

describe("gitFetch", () => {
  it("traz branches e tags novas do remoto e conta o que mudou", async () => {
    const { base, repo, remote } = makeRepoWithRemote();
    const outro = `${base}/outro`;
    sh(base, "clone", remote, "outro");
    configureClone(sh, outro);
    sh(outro, "switch", "-c", "feature-x");
    writeFile(outro, "x.txt", "x\n");
    sh(outro, "add", "x.txt");
    sh(outro, "commit", "-m", "x");
    sh(outro, "tag", "v1.0");
    sh(outro, "push", "origin", "feature-x", "v1.0");
    sh(outro, "switch", "main");
    writeFile(outro, "y.txt", "y\n");
    sh(outro, "add", "y.txt");
    sh(outro, "commit", "-m", "y");
    sh(outro, "push", "origin", "main");

    const antes = sh(repo, "rev-parse", "HEAD");
    const res = await gitFetch(git, repo);
    expect(res.remoto).toBe("origin");
    expect(res.novas).toContain("origin/feature-x");
    expect(res.novas).toContain("tag v1.0");
    expect(res.atualizadas).toContain("origin/main");
    // the working tree and HEAD are untouched
    expect(sh(repo, "rev-parse", "HEAD")).toBe(antes);
    expect(sh(repo, "tag", "--list")).toContain("v1.0");

    const again = await gitFetch(git, repo, { remoto: "origin" });
    expect(again.novas).toEqual([]);
    expect(again.atualizadas).toEqual([]);
  });

  it("não usa --prune: branch apagada no remoto continua conhecida", async () => {
    const { base, repo, remote } = makeRepoWithRemote();
    sh(repo, "switch", "-c", "efemera");
    sh(repo, "push", "origin", "efemera");
    sh(repo, "switch", "main");
    sh(base, "--git-dir", remote, "branch", "-D", "efemera");
    await gitFetch(git, repo);
    expect(sh(repo, "branch", "-r")).toContain("origin/efemera");
  });

  it("recusa remoto inexistente, URL e opção sem chamar o fetch", async () => {
    const { repo } = makeRepoWithRemote();
    for (const bad of ["naoexiste", "https://example.com/x.git", "--all", "-p", "../x", "a b", ""]) {
      const spy = spyGit();
      await expect(gitFetch(spy.git, repo, { remoto: bad })).rejects.toMatchObject({ codigo: "argumento_invalido" });
      expect(spy.callsTo(...MUTATING)).toEqual([]);
    }
  });
});
