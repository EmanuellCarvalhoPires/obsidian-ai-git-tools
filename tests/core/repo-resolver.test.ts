import { join, sep } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createNodeGit } from "../../src/core/git-runner";
import type { GitRunner, ProjectInfo, ProjectLookup } from "../../src/core/ports";
import { RepoError, createRemoteCache, isInside, normalizePathKey, resolveRepo } from "../../src/core/repo-resolver";
import type { RepoResolverDeps } from "../../src/core/repo-resolver";
import { parseRemoteUrl } from "../../src/core/providers/provider";
import { canLinkDirs, cleanupTemp, linkDir, makeRepo, makeTempDir, sh, writeFile } from "../helpers/git-repos";

afterAll(cleanupTemp);

function lookup(projects: ProjectInfo[]): ProjectLookup {
  return {
    list: () => Promise.resolve(projects),
    byName: (name) => Promise.resolve(projects.find((p) => p.name.toLowerCase() === name.toLowerCase())),
    byClone: (path) => Promise.resolve(projects.find((p) => p.clonePath !== undefined && isInside(p.clonePath, path))),
  };
}

const git = createNodeGit();
const linksWork = canLinkDirs();

// base/
//   projA/            repository of the project "Alpha" (remote origin on GitHub)
//   permitida/repoB   repository inside an allowed folder
//   permitida/vazia   plain folder inside an allowed folder
//   fora/repoC        repository that nobody allowed
let base: string;
let projA: string;
let permitida: string;
let repoB: string;
let fora: string;
let repoC: string;
let deps: RepoResolverDeps;

beforeAll(() => {
  base = makeTempDir();
  projA = makeRepo(base, "projA");
  sh(projA, "remote", "add", "origin", "https://u:segredo@github.com/o/r.git");
  writeFile(projA, "src/main.ts", "x");
  permitida = join(base, "permitida");
  repoB = makeRepo(permitida, "repoB");
  writeFile(permitida, "vazia/.keep", "");
  fora = join(base, "fora");
  repoC = makeRepo(fora, "repoC");
  deps = {
    git,
    projects: lookup([
      { name: "Alpha", folder: "Projetos/Alpha", clonePath: projA },
      { name: "Sem Clone", folder: "Projetos/Sem Clone", clonePath: undefined },
    ]),
    allowedFolders: () => [permitida],
  };
});

async function refused(input: string, d: RepoResolverDeps = deps): Promise<RepoError> {
  try {
    await resolveRepo(input, d);
  } catch (e) {
    expect(e).toBeInstanceOf(RepoError);
    expect((e as RepoError).codigo).toBe("repo_nao_permitido");
    return e as RepoError;
  }
  throw new Error("expected repo_nao_permitido");
}

describe("resolveRepo", () => {
  it("resolves a project name to its clone, with the masked remote", async () => {
    const r = await resolveRepo("Alpha", deps);
    expect(normalizePathKey(r.root)).toBe(normalizePathKey(projA));
    expect(r.projeto).toBe("Alpha");
    expect(r.remoto?.nome).toBe("origin");
    expect(r.remoto?.url).toBe("https://***@github.com/o/r.git");
    expect(r.remoto?.ref).toEqual({ provider: "github", owner: "o", slug: "r", repo: "o/r" });
  });

  it("matches the project name case-insensitively", async () => {
    const r = await resolveRepo("  alpha ", deps);
    expect(r.projeto).toBe("Alpha");
  });

  it("resolves an absolute path inside a project clone to the repository top level", async () => {
    const r = await resolveRepo(join(projA, "src"), deps);
    expect(normalizePathKey(r.root)).toBe(normalizePathKey(projA));
    expect(r.projeto).toBe("Alpha");
  });

  it("resolves a repository inside an allowed folder (no project, no remote)", async () => {
    const r = await resolveRepo(repoB, deps);
    expect(normalizePathKey(r.root)).toBe(normalizePathKey(repoB));
    expect(r.projeto).toBeUndefined();
    expect(r.remoto).toBeUndefined();
  });

  it("accepts forward slashes and, on Windows, another letter case", async () => {
    const r = await resolveRepo(repoB.replace(/\\/g, "/"), deps);
    expect(normalizePathKey(r.root)).toBe(normalizePathKey(repoB));
    if (process.platform === "win32") {
      const r2 = await resolveRepo(repoB.toLowerCase(), deps);
      expect(normalizePathKey(r2.root)).toBe(normalizePathKey(repoB));
    }
  });

  it("refuses a repository outside the projects and the allowed folders", async () => {
    await refused(repoC);
    await refused(fora);
  });

  it("refuses everything when no folder is allowed and no project matches", async () => {
    await refused(repoB, { ...deps, allowedFolders: () => [] });
  });

  it("refuses a path with `..` even when it would land inside", async () => {
    await refused(`${permitida}${sep}repoB${sep}..${sep}repoB`);
    await refused(`${projA}/src/../../fora/repoC`);
  });

  it("refuses a relative path", async () => {
    await refused("projA");
    await refused("./projA");
    await refused("..\\fora\\repoC");
  });

  it("refuses an unknown project, a project without clone and an empty input", async () => {
    await refused("Inexistente");
    await refused("Sem Clone");
    await expect(resolveRepo("   ", deps)).rejects.toMatchObject({ codigo: "argumento_invalido" });
  });

  it("refuses a missing path", async () => {
    await refused(join(permitida, "nao-existe"));
  });

  it("refuses a plain folder (not a repository) inside an allowed folder", async () => {
    await refused(join(permitida, "vazia"));
  });

  it("refuses an allowed folder that sits inside a bigger repository", async () => {
    // projA is a repository; allow only its src folder: the top level (projA) is outside the grant.
    const d: RepoResolverDeps = { ...deps, projects: lookup([]), allowedFolders: () => [join(projA, "src")] };
    await refused(join(projA, "src"), d);
  });

  it.skipIf(!linksWork)("refuses a link inside an allowed folder that points outside", async () => {
    const link = join(permitida, "atalho");
    linkDir(repoC, link);
    await refused(link);
    await refused(join(link, "src"));
  });

  it.skipIf(!linksWork)("accepts a link outside that points to an allowed repository", async () => {
    const link = join(fora, "para-b");
    linkDir(repoB, link);
    const r = await resolveRepo(link, deps);
    expect(normalizePathKey(r.root)).toBe(normalizePathKey(repoB));
  });
});

describe("path helpers", () => {
  it("compares paths without case, separator or trailing slash differences", () => {
    expect(isInside("C:\\Dev\\Repo", "c:/dev/repo/src")).toBe(true);
    expect(isInside("C:\\Dev\\Repo\\", "C:\\DEV\\REPO")).toBe(true);
    expect(isInside("C:\\Dev\\Repo", "C:\\Dev\\Repo2")).toBe(false);
    expect(isInside("C:\\Dev\\Repo", "C:\\Dev")).toBe(false);
  });
});

describe("parseRemoteUrl", () => {
  const gh = (repo: string) => ({ provider: "github", owner: repo.split("/")[0], slug: repo.split("/")[1], repo });
  const bb = (repo: string) => ({ provider: "bitbucket", owner: repo.split("/")[0], slug: repo.split("/")[1], repo });

  it("reads scp-like SSH URLs", () => {
    expect(parseRemoteUrl("git@github.com:o/r.git")).toEqual(gh("o/r"));
    expect(parseRemoteUrl("git@bitbucket.org:ws/rp.git")).toEqual(bb("ws/rp"));
  });
  it("reads HTTPS URLs, with or without .git, user and trailing slash", () => {
    expect(parseRemoteUrl("https://github.com/o/r.git")).toEqual(gh("o/r"));
    expect(parseRemoteUrl("https://github.com/o/r")).toEqual(gh("o/r"));
    expect(parseRemoteUrl("https://github.com/o/r/")).toEqual(gh("o/r"));
    expect(parseRemoteUrl("https://usuario@bitbucket.org/ws/r.git")).toEqual(bb("ws/r"));
    expect(parseRemoteUrl("https://u:p@bitbucket.org/ws/r.git")).toEqual(bb("ws/r"));
  });
  it("reads ssh:// URLs", () => {
    expect(parseRemoteUrl("ssh://git@bitbucket.org/ws/r.git")).toEqual(bb("ws/r"));
  });
  it("keeps dots and dashes in names", () => {
    expect(parseRemoteUrl("https://github.com/Emanuell-C/obsidian.ai-git.tools.git")).toEqual(gh("Emanuell-C/obsidian.ai-git.tools"));
  });
  it("gives undefined for other hosts, look-alike hosts, local paths and garbage", () => {
    for (const url of [
      "https://example.com/x/y.git",
      "https://notgithub.com/o/r.git",
      "https://github.com.evil.io/o/r.git",
      "https://github.com/o",
      "https://github.com/o/r/extra",
      "C:\\repos\\remoto.git",
      "C:/repos/remoto.git",
      "/tmp/remoto.git",
      "",
      "texto qualquer",
    ]) {
      expect(parseRemoteUrl(url), url).toBeUndefined();
    }
  });
});


describe("RemoteCache and resolveRepo cache behavior", () => {
  it("calls list once per resolution and never calls byName", async () => {
    let listCalls = 0;
    let byNameCalls = 0;
    const baseLookup = lookup([
      { name: "Alpha", folder: "Projetos/Alpha", clonePath: projA },
    ]);
    const wrappedLookup: ProjectLookup = {
      list: async () => {
        listCalls++;
        return baseLookup.list();
      },
      byName: async (name) => {
        byNameCalls++;
        return baseLookup.byName(name);
      },
      byClone: (path) => baseLookup.byClone(path),
    };
    const testDeps: RepoResolverDeps = { ...deps, projects: wrappedLookup };

    const r1 = await resolveRepo("Alpha", testDeps);
    expect(r1.projeto).toBe("Alpha");
    expect(listCalls).toBe(1);
    expect(byNameCalls).toBe(0);

    const r2 = await resolveRepo(projA, testDeps);
    expect(r2.projeto).toBe("Alpha");
    expect(listCalls).toBe(2);
    expect(byNameCalls).toBe(0);
  });

  it("caches the remote and supports forget and ttl expiry", async () => {
    const calls: string[][] = [];
    const spy: GitRunner = (cwd, args, o) => {
      calls.push(args);
      return git(cwd, args, o);
    };
    let t = 0;
    const cache = createRemoteCache(30_000, () => t);
    const testDeps: RepoResolverDeps = { ...deps, git: spy, remoteCache: cache };

    const r1 = await resolveRepo("Alpha", testDeps);
    expect(calls.filter((a) => a[0] === "remote").length).toBe(2);
    expect(r1.remoto).toBeDefined();

    const r2 = await resolveRepo("Alpha", testDeps);
    expect(calls.filter((a) => a[0] === "remote").length).toBe(2);
    expect(r2.remoto).toEqual(r1.remoto);

    cache.forget(r1.root);
    const r3 = await resolveRepo("Alpha", testDeps);
    expect(calls.filter((a) => a[0] === "remote").length).toBe(4);
    expect(r3.remoto).toEqual(r1.remoto);

    t = 30_001;
    const r4 = await resolveRepo("Alpha", testDeps);
    expect(calls.filter((a) => a[0] === "remote").length).toBe(6);
    expect(r4.remoto).toEqual(r1.remoto);
  });

  it("caches negative remote hits (repository without remotes)", async () => {
    const calls: string[][] = [];
    const spy: GitRunner = (cwd, args, o) => {
      calls.push(args);
      return git(cwd, args, o);
    };
    const cache = createRemoteCache(30_000);
    const testDeps: RepoResolverDeps = { ...deps, git: spy, remoteCache: cache };

    const r1 = await resolveRepo(repoB, testDeps);
    expect(r1.remoto).toBeUndefined();
    expect(calls.filter((a) => a[0] === "remote").length).toBe(1);

    const r2 = await resolveRepo(repoB, testDeps);
    expect(r2.remoto).toBeUndefined();
    expect(calls.filter((a) => a[0] === "remote").length).toBe(1);
  });

  it("without remoteCache every resolution executes git remote", async () => {
    const calls: string[][] = [];
    const spy: GitRunner = (cwd, args, o) => {
      calls.push(args);
      return git(cwd, args, o);
    };
    const testDeps: RepoResolverDeps = { ...deps, git: spy };

    await resolveRepo("Alpha", testDeps);
    expect(calls.filter((a) => a[0] === "remote").length).toBe(2);

    await resolveRepo("Alpha", testDeps);
    expect(calls.filter((a) => a[0] === "remote").length).toBe(4);
  });
});
