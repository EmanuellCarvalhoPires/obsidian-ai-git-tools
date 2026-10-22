import { afterAll, describe, expect, it } from "vitest";
import { createNodeGit } from "../../../src/core/git-runner";
import { gitRemoteInfo, parseRemoteList } from "../../../src/core/git/remote-info";
import { cleanupTemp, makeRepo, makeRepoWithRemote, sh } from "../../helpers/git-repos";

afterAll(cleanupTemp);
const git = createNodeGit();
const NONE = { secrets: { github: false, bitbucket: false } };

describe("parseRemoteList", () => {
  it("junta fetch e push por nome", () => {
    const raw = "origin\thttps://github.com/o/r.git (fetch)\norigin\thttps://github.com/o/r.git (push)\nbk\tgit@bitbucket.org:w/s.git (fetch)\n";
    expect(parseRemoteList(raw)).toEqual([
      { nome: "origin", fetch: "https://github.com/o/r.git", push: "https://github.com/o/r.git" },
      { nome: "bk", fetch: "git@bitbucket.org:w/s.git", push: "" },
    ]);
  });
});

describe("gitRemoteInfo (URLs fictícias, sem rede)", () => {
  it("github por https, com credencial mascarada e secret configurada", async () => {
    const repo = makeRepo();
    sh(repo, "remote", "add", "origin", "https://usuario:segredo123@github.com/dono/projeto.git");
    const info = await gitRemoteInfo(git, repo, { secrets: { github: true, bitbucket: false } });
    expect(info).toMatchObject({ principal: "origin", provedor: "github", dono: "dono", slug: "projeto", secretConfigurada: true });
    expect(info.remotos[0]?.url_fetch).toBe("https://***@github.com/dono/projeto.git");
    expect(JSON.stringify(info)).not.toContain("segredo123");
  });

  it("bitbucket por ssh scp e a secret do outro provedor não conta", async () => {
    const repo = makeRepo();
    sh(repo, "remote", "add", "origin", "git@bitbucket.org:meu-ws/meu-repo.git");
    const info = await gitRemoteInfo(git, repo, { secrets: { github: true, bitbucket: false } });
    expect(info).toMatchObject({ provedor: "bitbucket", dono: "meu-ws", slug: "meu-repo", secretConfigurada: false });
    const withSecret = await gitRemoteInfo(git, repo, { secrets: { github: false, bitbucket: true } });
    expect(withSecret.secretConfigurada).toBe(true);
  });

  it("bitbucket por https com usuário", async () => {
    const repo = makeRepo();
    sh(repo, "remote", "add", "origin", "https://emanuell@bitbucket.org/ws/repo.git");
    const info = await gitRemoteInfo(git, repo, NONE);
    expect(info).toMatchObject({ provedor: "bitbucket", dono: "ws", slug: "repo" });
    expect(info.remotos[0]?.url_fetch).toBe("https://***@bitbucket.org/ws/repo.git");
  });

  it("sem origin usa o primeiro remoto; vários remotos são listados", async () => {
    const repo = makeRepo();
    sh(repo, "remote", "add", "upstream", "https://github.com/a/b.git");
    sh(repo, "remote", "add", "outro", "https://github.com/c/d.git");
    const info = await gitRemoteInfo(git, repo, NONE);
    expect(info.remotos.map((r) => r.nome).sort()).toEqual(["outro", "upstream"]);
    expect(info.principal).toBeDefined();
    expect(info.provedor).toBe("github");
  });

  it("host desconhecido e remoto local: sem provedor, sem secret", async () => {
    const { repo } = makeRepoWithRemote();
    const info = await gitRemoteInfo(git, repo, { secrets: { github: true, bitbucket: true } });
    expect(info.principal).toBe("origin");
    expect(info.provedor).toBeUndefined();
    expect(info.secretConfigurada).toBe(false);
  });

  it("repositório sem remoto", async () => {
    const repo = makeRepo();
    const info = await gitRemoteInfo(git, repo, NONE);
    expect(info).toMatchObject({ remotos: [], principal: undefined, provedor: undefined, branchPadrao: undefined, secretConfigurada: false });
  });

  it("branch padrão vem de refs/remotes/<remoto>/HEAD e a ausência é tolerada", async () => {
    const repo = makeRepo();
    sh(repo, "remote", "add", "origin", "https://github.com/o/r.git");
    expect((await gitRemoteInfo(git, repo, NONE)).branchPadrao).toBeUndefined();
    sh(repo, "update-ref", "refs/remotes/origin/main", "HEAD");
    sh(repo, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
    expect((await gitRemoteInfo(git, repo, NONE)).branchPadrao).toBe("main");
  });
});
