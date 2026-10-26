import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { createNodeGit } from "../../../src/core/git-runner";
import { assertCloneDestination, cloneAllowedRoots, gitClone, validateCloneUrl } from "../../../src/core/git/clone";
import { canLinkDirs, cleanupTemp, linkDir, makeRepoWithRemote, makeTempDir, sh } from "../../helpers/git-repos";
import { spyGit } from "../../helpers/spy-git";
import { lookupOf } from "../../helpers/tool-deps";

afterAll(cleanupTemp);
const git = createNodeGit();
const anyUrl = (u: string): string => u;

describe("validateCloneUrl", () => {
  it.each([
    ["https://github.com/dono/repo.git", "github", "dono", "repo"],
    ["https://github.com/dono/repo", "github", "dono", "repo"],
    ["https://bitbucket.org/ws/meu-repo.git", "bitbucket", "ws", "meu-repo"],
    ["https://usuario@bitbucket.org/ws/repo.git", "bitbucket", "ws", "repo"],
    ["git@github.com:dono/repo.git", "github", "dono", "repo"],
    ["git@bitbucket.org:ws/repo.git", "bitbucket", "ws", "repo"],
    ["ssh://git@github.com/dono/repo.git", "github", "dono", "repo"],
    ["ssh://git@bitbucket.org/ws/repo.git", "bitbucket", "ws", "repo"],
    ["HTTPS://GitHub.com/dono/repo.git", "github", "dono", "repo"],
  ])("aceita %s", (url, provider, owner, slug) => {
    expect(validateCloneUrl(url)).toMatchObject({ provider, owner, slug });
  });

  it.each([
    ["https://gitlab.com/dono/repo.git"],
    ["https://github.com.evil.io/dono/repo.git"],
    ["https://evil.io/github.com/dono/repo.git"],
    ["https://github.com@evil.io/dono/repo.git"],
    ["https://www.github.com/dono/repo.git"],
    ["git@gitlab.com:dono/repo.git"],
    ["git@github.com.evil.io:dono/repo.git"],
    ["ssh://git@evil.io/dono/repo.git"],
    ["http://github.com/dono/repo.git"],
    ["git://github.com/dono/repo.git"],
    ["file:///C:/repo.git"],
    ["ext::sh -c 'rm -rf /'"],
    ["C:\\repos\\x.git"],
    ["/tmp/repo.git"],
    ["../repo.git"],
    ["--upload-pack=calc"],
    ["-u calc"],
    [""],
    ["   "],
    ["https://github.com/dono"],
    ["https://github.com/dono/repo/extra.git"],
    ["https://github.com/../repo.git"],
    ["https://github.com/dono/repo.git?x=1"],
    ["https://github.com/dono/repo.git#frag"],
    ["https://github.com:8443/dono/repo.git"],
    ["https://github.com/dono/re po.git"],
    ["https://github.com/dono/repo.git\n--upload-pack=x"],
  ])("recusa %j", (url) => {
    expect(() => validateCloneUrl(url)).toThrow(expect.objectContaining({ codigo: "argumento_invalido" }));
  });

  it.each([
    ["https://usuario:segredo@github.com/dono/repo.git"],
    ["https://:segredo@bitbucket.org/ws/repo.git"],
    ["ssh://git:segredo@github.com/dono/repo.git"],
  ])("recusa senha na URL (%s) sem repetir o segredo na mensagem", (url) => {
    let message = "";
    try {
      validateCloneUrl(url);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).not.toBe("");
    expect(message).not.toContain("segredo");
  });

  it("ssh só com o usuário git", () => {
    expect(() => validateCloneUrl("ssh://outro@github.com/dono/repo.git")).toThrow(/git/);
  });
});

describe("assertCloneDestination", () => {
  it("aceita um destino novo dentro de uma pasta permitida, mesmo com subpastas ainda inexistentes", async () => {
    const base = makeTempDir();
    const dest = await assertCloneDestination(join(base, "a", "b", "novo"), [base]);
    expect(dest.destino).toBe(join(base, "a", "b", "novo"));
    expect(dest.cwd).toBe(base);
  });

  it("recusa destino existente", async () => {
    const base = makeTempDir();
    mkdirSync(join(base, "existe"));
    await expect(assertCloneDestination(join(base, "existe"), [base])).rejects.toThrow(/já existe/);
  });

  it("recusa a própria pasta permitida (precisa ficar dentro dela)", async () => {
    const base = makeTempDir();
    await expect(assertCloneDestination(base, [base])).rejects.toMatchObject({ codigo: "argumento_invalido" });
  });

  it("recusa destino fora das pastas permitidas", async () => {
    const base = makeTempDir();
    const fora = makeTempDir();
    await expect(assertCloneDestination(join(fora, "novo"), [base])).rejects.toThrow(/fora das pastas permitidas/);
    await expect(assertCloneDestination(join(fora, "novo"), [])).rejects.toThrow(/fora das pastas permitidas/);
  });

  it("recusa pasta irmã com o mesmo prefixo", async () => {
    const base = makeTempDir();
    const irma = `${base}-irma`;
    mkdirSync(irma);
    await expect(assertCloneDestination(join(irma, "novo"), [base])).rejects.toThrow(/fora das pastas permitidas/);
  });

  it.each([["relativo/novo"], ["novo"], ["."], [""], ["..\\novo"]])("recusa caminho não absoluto %j", async (dest) => {
    await expect(assertCloneDestination(dest, [makeTempDir()])).rejects.toMatchObject({ codigo: "argumento_invalido" });
  });

  it("recusa '..' mesmo que o caminho resolvido ficasse dentro", async () => {
    const base = makeTempDir();
    mkdirSync(join(base, "a"));
    await expect(assertCloneDestination(`${base}\\a\\..\\novo`, [base])).rejects.toThrow(/\.\./);
    await expect(assertCloneDestination(`${base}/a/../novo`, [base])).rejects.toThrow(/\.\./);
  });

  it("recusa destino que escapa da pasta permitida por um link", async () => {
    if (!canLinkDirs()) return;
    const base = makeTempDir();
    const fora = makeTempDir();
    linkDir(fora, join(base, "atalho"));
    await expect(assertCloneDestination(join(base, "atalho", "novo"), [base])).rejects.toThrow(/fora das pastas permitidas/);
  });
});

describe("cloneAllowedRoots", () => {
  it.skipIf(process.platform !== "win32")("junta as pastas permitidas e a pasta-mãe do clone de cada projeto", async () => {
    const projects = lookupOf([
      { name: "A", folder: "Projetos/A", clonePath: "C:\\dev\\clones\\a" },
      { name: "B", folder: "Projetos/B", clonePath: undefined },
    ]);
    const roots = await cloneAllowedRoots(projects, ["D:\\extra", "relativo", " "]);
    expect(roots).toEqual(["D:\\extra", "C:\\dev\\clones"]);
  });
});

describe("gitClone (remoto bare local, sem rede)", () => {
  it("clona, devolve branch e hash do clone", async () => {
    const { base, remote } = makeRepoWithRemote();
    const tip = sh(remote, "rev-parse", "main").trim();
    const res = await gitClone(git, { url: remote, destino: join(base, "clones", "novo") }, { allowedRoots: [base], validateUrl: anyUrl });
    expect(res).toMatchObject({ destino: join(base, "clones", "novo"), branch: "main", hash: tip });
    expect(sh(res.destino, "rev-parse", "HEAD").trim()).toBe(tip);
    expect(sh(res.destino, "remote", "get-url", "origin").trim().toLowerCase()).toContain("remoto.git");
  });

  it("branch e profundidade", async () => {
    const { base, repo, remote } = makeRepoWithRemote();
    sh(repo, "switch", "-c", "feature");
    sh(repo, "commit", "--allow-empty", "-m", "um");
    sh(repo, "commit", "--allow-empty", "-m", "dois");
    sh(repo, "push", "origin", "feature");
    const res = await gitClone(
      git,
      { url: pathToFileURL(remote).href, destino: join(base, "raso"), branch: "feature", profundidade: 1 },
      { allowedRoots: [base], validateUrl: anyUrl },
    );
    expect(res).toMatchObject({ branch: "feature", profundidade: 1 });
    expect(sh(res.destino, "rev-list", "--count", "HEAD").trim()).toBe("1");
  });

  it("destino existente, fora da lista e com '..' não chamam o git", async () => {
    const { base, remote } = makeRepoWithRemote();
    const outro = makeTempDir();
    mkdirSync(join(base, "ja"));
    const spy = spyGit();
    const ctx = { allowedRoots: [base], validateUrl: anyUrl };
    await expect(gitClone(spy.git, { url: remote, destino: join(base, "ja") }, ctx)).rejects.toThrow(/já existe/);
    await expect(gitClone(spy.git, { url: remote, destino: join(outro, "novo") }, ctx)).rejects.toThrow(/fora das pastas permitidas/);
    await expect(gitClone(spy.git, { url: remote, destino: `${base}\\x\\..\\novo` }, ctx)).rejects.toThrow(/\.\./);
    expect(spy.callsTo("clone")).toEqual([]);
  });

  it("URL de host não permitido (validação real) e senha na URL não chamam o git", async () => {
    const base = makeTempDir();
    const spy = spyGit();
    const ctx = { allowedRoots: [base] };
    await expect(gitClone(spy.git, { url: "https://gitlab.com/o/r.git", destino: join(base, "n1") }, ctx)).rejects.toMatchObject({ codigo: "argumento_invalido" });
    await expect(gitClone(spy.git, { url: "https://u:senha@github.com/o/r.git", destino: join(base, "n2") }, ctx)).rejects.toMatchObject({ codigo: "argumento_invalido" });
    await expect(gitClone(spy.git, { url: "file:///tmp/x", destino: join(base, "n3") }, ctx)).rejects.toMatchObject({ codigo: "argumento_invalido" });
    expect(spy.calls).toEqual([]);
  });

  it.each([[0], [-1], [1.5], [100001]])("profundidade %j é recusada sem chamar o git", async (profundidade) => {
    const { base, remote } = makeRepoWithRemote();
    const spy = spyGit();
    await expect(gitClone(spy.git, { url: remote, destino: join(base, "n"), profundidade }, { allowedRoots: [base], validateUrl: anyUrl })).rejects.toMatchObject({ codigo: "argumento_invalido" });
    expect(spy.callsTo("clone")).toEqual([]);
  });

  it.each([["--upload-pack=x"], ["-f"], ["a..b"], ["a b"]])("branch %j é recusada sem clonar", async (branch) => {
    const { base, remote } = makeRepoWithRemote();
    const spy = spyGit();
    await expect(gitClone(spy.git, { url: remote, destino: join(base, "n"), branch }, { allowedRoots: [base], validateUrl: anyUrl })).rejects.toMatchObject({ codigo: "argumento_invalido" });
    expect(spy.callsTo("clone")).toEqual([]);
  });

  it("a URL vai depois de '--' (nunca lida como opção)", async () => {
    const { base, remote } = makeRepoWithRemote();
    const spy = spyGit();
    await gitClone(spy.git, { url: remote, destino: join(base, "n") }, { allowedRoots: [base], validateUrl: anyUrl });
    const argv = spy.callsTo("clone")[0] ?? [];
    expect(argv[argv.indexOf("--") + 1]).toBe(remote);
  });

  it("remoto inexistente: GitError sem credenciais no texto", async () => {
    const base = makeTempDir();
    await expect(gitClone(git, { url: join(base, "nao-existe.git"), destino: join(base, "n") }, { allowedRoots: [base], validateUrl: anyUrl })).rejects.toMatchObject({ name: "GitError" });
  });
});
