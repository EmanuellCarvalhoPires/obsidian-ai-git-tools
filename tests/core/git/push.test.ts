import { chmodSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { GitError, createNodeGit } from "../../../src/core/git-runner";
import { PushRejectedError, gitPush } from "../../../src/core/git/push";
import { cleanupTemp, makeRepo, makeRepoWithRemote, sh, writeFile } from "../../helpers/git-repos";
import { MUTATING, configureClone, spyGit } from "../../helpers/spy-git";

afterAll(cleanupTemp);
const git = createNodeGit();

function commitFile(repo: string, name: string): string {
  writeFile(repo, name, `${name}\n`);
  sh(repo, "add", name);
  sh(repo, "commit", "-m", `add ${name}`);
  return sh(repo, "rev-parse", "HEAD").trim();
}

const remoteHeads = (remote: string): string => sh(remote, "for-each-ref", "--format=%(refname) %(objectname)", "refs/heads");

describe("gitPush", () => {
  it("branch nova com definir_upstream: envia, liga o upstream e avisa que é nova", async () => {
    const base = makeRepoWithRemote();
    sh(base.repo, "switch", "-c", "feature/x");
    const tip = commitFile(base.repo, "x.txt");
    const res = await gitPush(git, base.repo, { definirUpstream: true });
    expect(res).toMatchObject({ remoto: "origin", branch: "feature/x", hash: tip, branchNova: true, emDia: false, upstreamDefinido: true });
    expect(remoteHeads(base.remote)).toContain(`refs/heads/feature/x ${tip}`);
    expect(sh(base.repo, "rev-parse", "--abbrev-ref", "feature/x@{upstream}").trim()).toBe("origin/feature/x");
  });

  it("sem definir_upstream não liga o upstream; segundo push da mesma ponta está em dia", async () => {
    const base = makeRepoWithRemote();
    sh(base.repo, "switch", "-c", "b");
    commitFile(base.repo, "b.txt");
    const first = await gitPush(git, base.repo, {});
    expect(first).toMatchObject({ branch: "b", branchNova: true, upstreamDefinido: false });
    expect(() => sh(base.repo, "rev-parse", "--abbrev-ref", "b@{upstream}")).toThrow();
    const again = await gitPush(git, base.repo, { branch: "b" });
    expect(again).toMatchObject({ branchNova: false, emDia: true });
  });

  it("avanço normal de uma branch existente: não é nova", async () => {
    const base = makeRepoWithRemote();
    const tip = commitFile(base.repo, "n.txt");
    const res = await gitPush(git, base.repo, { remoto: "origin" });
    expect(res).toMatchObject({ branch: "main", hash: tip, branchNova: false, emDia: false });
    expect(remoteHeads(base.remote)).toContain(`refs/heads/main ${tip}`);
  });

  it("remoto à frente: PushRejectedError com dica de git_pull e nada é sobrescrito", async () => {
    const { base, repo, remote } = makeRepoWithRemote();
    sh(base, "clone", remote, "outro");
    const outro = `${base}/outro`;
    configureClone(sh, outro);
    const remoteTip = commitFile(outro, "remoto.txt");
    sh(outro, "push", "origin", "main");
    commitFile(repo, "local.txt");

    const err = await gitPush(git, repo, {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PushRejectedError);
    expect((err as PushRejectedError).dica).toMatch(/git_pull/);
    expect(remoteHeads(remote)).toContain(`refs/heads/main ${remoteTip}`);
  });

  it("recusa por hook pre-receive no remoto: GitError comum, com a saída do hook e SEM dica de git_pull", async () => {
    const { repo, remote } = makeRepoWithRemote();
    const hook = writeFile(remote, "hooks/pre-receive", "#!/bin/sh\necho 'politica: push bloqueado' >&2\nexit 1\n");
    try {
      chmodSync(hook, 0o755);
    } catch {
      // Windows: git runs the hook through its own sh
    }
    const before = remoteHeads(remote);
    commitFile(repo, "bloqueado.txt");
    const err = await gitPush(git, repo, {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitError);
    expect(err).not.toBeInstanceOf(PushRejectedError);
    expect((err as GitError).stderr).toContain("politica: push bloqueado");
    expect((err as GitError).message).not.toMatch(/git_pull/);
    expect(remoteHeads(remote)).toBe(before);
  });

  it("push de tag; segundo push da mesma tag está em dia", async () => {
    const { repo, remote } = makeRepoWithRemote();
    sh(repo, "tag", "-a", "v1.0.0", "-m", "release");
    const res = await gitPush(git, repo, { tag: "v1.0.0" });
    expect(res).toMatchObject({ tag: "v1.0.0", branch: undefined, tagNova: true, branchNova: false });
    expect(res.hash).toBe(sh(repo, "rev-parse", "HEAD").trim());
    expect(sh(remote, "tag", "--list")).toContain("v1.0.0");
    const again = await gitPush(git, repo, { tag: "v1.0.0" });
    expect(again).toMatchObject({ tagNova: false, emDia: true });
  });

  it("HEAD solto sem branch informada é recusado", async () => {
    const { repo } = makeRepoWithRemote();
    sh(repo, "switch", "--detach", "HEAD");
    const spy = spyGit();
    await expect(gitPush(spy.git, repo, {})).rejects.toMatchObject({ codigo: "argumento_invalido", message: expect.stringMatching(/HEAD solto/) });
    expect(spy.callsTo("push")).toEqual([]);
  });

  it("branch ou tag inexistente é recusada sem push", async () => {
    const { repo } = makeRepoWithRemote();
    const spy = spyGit();
    await expect(gitPush(spy.git, repo, { branch: "naoexiste" })).rejects.toMatchObject({ codigo: "argumento_invalido" });
    await expect(gitPush(spy.git, repo, { tag: "naoexiste" })).rejects.toMatchObject({ codigo: "argumento_invalido" });
    expect(spy.callsTo("push")).toEqual([]);
  });

  it.each([
    ["--force"],
    ["-f"],
    ["--force-with-lease"],
    ["+main"],
    ["+refs/heads/main"],
    [":main"],
    ["main:main"],
    ["main:"],
    ["-D"],
    ["--delete"],
    ["--mirror"],
    ["HEAD"],
    ["a b"],
    ["--tags"],
  ])("recusa a branch %j sem chamar o push", async (branch) => {
    const { repo, remote } = makeRepoWithRemote();
    const before = remoteHeads(remote);
    const spy = spyGit();
    await expect(gitPush(spy.git, repo, { branch })).rejects.toMatchObject({ codigo: "argumento_invalido" });
    expect(spy.callsTo(...MUTATING)).toEqual([]);
    expect(remoteHeads(remote)).toBe(before);
  });

  it.each([["--force"], ["+v1"], [":v1"], ["-d"], ["v1:v1"], ["--delete"]])("recusa a tag %j sem chamar o push", async (tag) => {
    const { repo } = makeRepoWithRemote();
    const spy = spyGit();
    await expect(gitPush(spy.git, repo, { tag })).rejects.toMatchObject({ codigo: "argumento_invalido" });
    expect(spy.callsTo(...MUTATING)).toEqual([]);
  });

  it.each([["--force"], ["-f"], ["--all"], ["--mirror"], ["https://example.com/x.git"], ["../x"], ["naoexiste"]])("recusa o remoto %j sem chamar o push", async (remoto) => {
    const { repo } = makeRepoWithRemote();
    const spy = spyGit();
    await expect(gitPush(spy.git, repo, { remoto })).rejects.toMatchObject({ codigo: "argumento_invalido" });
    expect(spy.callsTo(...MUTATING)).toEqual([]);
  });

  it("branch e tag juntas, ou upstream com tag, são recusados", async () => {
    const { repo } = makeRepoWithRemote();
    sh(repo, "tag", "t1");
    const spy = spyGit();
    await expect(gitPush(spy.git, repo, { branch: "main", tag: "t1" })).rejects.toMatchObject({ codigo: "argumento_invalido" });
    await expect(gitPush(spy.git, repo, { tag: "t1", definirUpstream: true })).rejects.toMatchObject({ codigo: "argumento_invalido" });
    expect(spy.callsTo("push")).toEqual([]);
  });

  it("nunca monta argumentos de força ou de apagar", async () => {
    const { repo } = makeRepoWithRemote();
    commitFile(repo, "z.txt");
    const spy = spyGit();
    await gitPush(spy.git, repo, { definirUpstream: true });
    const push = (spy.callsTo("push")[0] ?? []).join(" ");
    expect(push).not.toMatch(/force|--delete|--mirror|\+|--prune/);
    expect(push).toContain("-u");
  });

  it("sem remoto configurado recusa com mensagem clara", async () => {
    const repo = makeRepo();
    await expect(gitPush(git, repo, {})).rejects.toMatchObject({ codigo: "argumento_invalido", message: expect.stringMatching(/não tem o remoto/) });
  });
});
