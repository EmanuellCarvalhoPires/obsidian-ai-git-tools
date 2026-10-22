import { afterAll, describe, expect, it } from "vitest";
import { createNodeGit } from "../../src/core/git-runner";
import { GuardError } from "../../src/core/guards";
import { pullRequestOf, writeChangelog } from "../../src/core/history/changelog";
import type { ProjectInfo } from "../../src/core/ports";
import { cleanupTemp, makeRepo, sh, writeFile } from "../helpers/git-repos";
import { MemoryVault } from "../helpers/memory-ports";

afterAll(cleanupTemp);

function commit(dir: string, file: string, message: string): string {
  writeFile(dir, file, `${message}\n`);
  sh(dir, "add", ".");
  sh(dir, "commit", "-q", "-m", message);
  return sh(dir, "rev-parse", "HEAD").trim();
}

const NOW = new Date(2026, 9, 22, 12, 0, 0).getTime();

function harness(clone: string, folderName = "Changelogs") {
  const vault = new MemoryVault();
  const project: ProjectInfo = { name: "App", folder: "Projetos/App", clonePath: clone };
  const run = (options: Parameters<typeof writeChangelog>[3] = {}) => writeChangelog({ git: createNodeGit(), vault, folderName, now: () => NOW }, project, clone, options);
  return { vault, project, run };
}

describe("changelog: range and note", () => {
  it("lists the two commits since the last tag and creates the releases index", async () => {
    const dir = makeRepo();
    sh(dir, "tag", "v1.0.0");
    commit(dir, "b", "corrige bug");
    commit(dir, "c", "nova função");
    const h = harness(dir);
    const res = await h.run({ versao: "v1.1.0" });

    expect(res.path).toBe("Projetos/App/Changelogs/App - v1.1.0.md");
    expect(res.created).toBe(true);
    expect(res.indexCreated).toBe(true);
    expect(res.commits).toBe(2);
    expect(res.desde).toBe("v1.0.0");
    const body = h.vault.notes.get(res.path)!;
    expect(body).toContain("tags:\n  - dev/changelog");
    expect(body).toContain('up: "[[App - Changelog]]"');
    expect(body).toContain('projeto: "[[App]]"');
    expect(body).toContain('versao: "v1.1.0"');
    expect(body).toContain("corrige bug");
    expect(body).toContain("nova função");
    expect(body).not.toContain("commit inicial");
    expect(body).toContain("```ai-git-graph\nprojeto: App\n```");
    const index = h.vault.notes.get("Projetos/App/Changelogs/App - Changelog.md")!;
    expect(index).toContain("  - moc");
    expect(index).toContain('up: "[[App]]"');
    expect(index).toContain("```dataview");
  });

  it("keeps an existing index and does not create it again", async () => {
    const dir = makeRepo();
    sh(dir, "tag", "v1");
    commit(dir, "b", "um");
    const h = harness(dir);
    await h.run({ versao: "v2" });
    const index = h.vault.notes.get("Projetos/App/Changelogs/App - Changelog.md")!;
    commit(dir, "c", "dois");
    const second = await h.run({ versao: "v3" });
    expect(second.indexCreated).toBe(false);
    expect(h.vault.notes.get("Projetos/App/Changelogs/App - Changelog.md")).toBe(index);
    expect([...h.vault.notes.keys()].sort()).toEqual(["Projetos/App/Changelogs/App - Changelog.md", "Projetos/App/Changelogs/App - v2.md", "Projetos/App/Changelogs/App - v3.md"]);
  });

  it("rewrites the note of the same version instead of creating a second one", async () => {
    const dir = makeRepo();
    sh(dir, "tag", "v1");
    commit(dir, "b", "primeiro");
    const h = harness(dir);
    const first = await h.run({ versao: "v1.1" });
    commit(dir, "c", "segundo");
    const second = await h.run({ versao: "v1.1" });

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.updated).toBe(true);
    expect(second.path).toBe(first.path);
    expect([...h.vault.notes.keys()].filter((p) => p.includes("v1.1"))).toHaveLength(1);
    const body = h.vault.notes.get(first.path)!;
    expect(body).toContain("primeiro");
    expect(body).toContain("segundo");
    expect(body.match(/tags:/g)).toHaveLength(1);
  });

  it("starts at the first commit when the repository has no tag, and names the release by the date", async () => {
    const dir = makeRepo();
    commit(dir, "b", "segundo commit");
    const h = harness(dir);
    const res = await h.run();
    expect(res.desde).toBeUndefined();
    expect(res.commits).toBe(2);
    expect(res.versao).toBe("2026-10-22");
    expect(res.path).toBe("Projetos/App/Changelogs/App - 2026-10-22.md");
    const body = h.vault.notes.get(res.path)!;
    expect(body).toContain("commit inicial");
    expect(body).toContain("desde o primeiro commit");
    expect(body).not.toContain("\ndesde:");
  });

  it("uses the last tag even when it is not the one at HEAD, and the tag name as the release when HEAD is tagged", async () => {
    const dir = makeRepo();
    sh(dir, "tag", "v1.0.0");
    commit(dir, "b", "entrou na 1.1");
    sh(dir, "tag", "v1.1.0");
    const h = harness(dir);
    const res = await h.run();
    expect(res.versao).toBe("v1.1.0");
    expect(res.desde).toBe("v1.0.0");
    expect(res.commits).toBe(1);
    const body = h.vault.notes.get(res.path)!;
    expect(body).toContain("entrou na 1.1");
    expect(body).not.toContain("commit inicial");
  });

  it("honors desde and ate", async () => {
    const dir = makeRepo();
    const a = commit(dir, "a", "a");
    commit(dir, "b", "b");
    const c = commit(dir, "c", "c");
    commit(dir, "d", "d");
    const h = harness(dir);
    const res = await h.run({ desde: a, ate: c, versao: "meio" });
    expect(res.commits).toBe(2);
    const body = h.vault.notes.get(res.path)!;
    expect(body).toContain("- `" + c.slice(0, 7) + "` c");
    expect(body).not.toMatch(/`[0-9a-f]{7}` d \(/);
    expect(body).not.toMatch(/`[0-9a-f]{7}` a \(/);
  });

  it("says so when the range has no commit", async () => {
    const dir = makeRepo();
    const h = harness(dir);
    const res = await h.run({ desde: "HEAD", versao: "vazio" });
    expect(res.commits).toBe(0);
    expect(h.vault.notes.get(res.path)).toContain("Nenhum commit no intervalo.");
  });

  it("writes in the configured changelogs folder", async () => {
    const dir = makeRepo();
    const h = harness(dir, "Releases");
    const res = await h.run({ versao: "v1" });
    expect(res.path).toBe("Projetos/App/Releases/App - v1.md");
    expect(h.vault.exists("Projetos/App/Releases/App - Changelog.md")).toBe(true);
  });

  it("refuses unsafe or unknown refs and a bad version, writing nothing", async () => {
    const dir = makeRepo();
    const h = harness(dir);
    await expect(h.run({ desde: "--output=x" })).rejects.toBeInstanceOf(GuardError);
    await expect(h.run({ ate: "a..b" })).rejects.toBeInstanceOf(GuardError);
    await expect(h.run({ desde: "tag-que-nao-existe" })).rejects.toThrow(/não existe/);
    await expect(h.run({ versao: "   " })).rejects.toBeInstanceOf(GuardError);
    expect(h.vault.notes.size).toBe(0);
  });

  it("keeps a version with a slash or a line break out of the file name and the frontmatter", async () => {
    const dir = makeRepo();
    const h = harness(dir);
    const res = await h.run({ versao: 'rel/1"x\ny' });
    expect(res.versao).toBe('rel/1"x y');
    expect(res.path).toBe('Projetos/App/Changelogs/App - rel1x y.md');
    expect(h.vault.notes.get(res.path)).toContain('versao: "rel/1\\"x y"');
  });
});

describe("changelog: grouped by pull request", () => {
  function repoWithPrs() {
    const dir = makeRepo();
    sh(dir, "tag", "v1");
    // GitHub merge commit: "Merge pull request #12 from o/feature-x" + the title of the PR in the body.
    sh(dir, "checkout", "-q", "-b", "feature-x");
    commit(dir, "x1", "feat: x parte 1");
    commit(dir, "x2", "feat: x parte 2");
    sh(dir, "checkout", "-q", "main");
    sh(dir, "merge", "-q", "--no-ff", "-m", "Merge pull request #12 from o/feature-x", "-m", "Adiciona o recurso X", "feature-x");
    // Bitbucket merge commit: "Merged in <branch> (pull request #13)" + the title in the body.
    sh(dir, "checkout", "-q", "-b", "bugfix/y");
    commit(dir, "y1", "fix: y");
    sh(dir, "checkout", "-q", "main");
    sh(dir, "merge", "-q", "--no-ff", "-m", "Merged in bugfix/y (pull request #13)", "-m", "Corrige o problema Y\n\nApproved-by: Alguém", "bugfix/y");
    // Squash: one commit with (#14).
    commit(dir, "z", "Adiciona Z (#14)");
    // A commit of no PR.
    commit(dir, "w", "chore: ajuste solto");
    return dir;
  }

  it("lists each merged PR once, with its commits, and the loose commit apart", async () => {
    const dir = repoWithPrs();
    const h = harness(dir);
    const res = await h.run({ versao: "v1.1" });

    expect(res.prs).toBe(3);
    expect(res.itens.filter((i) => i.tipo === "pr").map((i) => i.numero)).toEqual([14, 13, 12]);
    const gh = res.itens.find((i) => i.numero === 12)!;
    expect(gh.titulo).toBe("Adiciona o recurso X");
    expect(gh.commits.map((c) => c.titulo)).toEqual(["feat: x parte 2", "feat: x parte 1"]);
    const bb = res.itens.find((i) => i.numero === 13)!;
    expect(bb.titulo).toBe("Corrige o problema Y");
    expect(bb.commits.map((c) => c.titulo)).toEqual(["fix: y"]);
    const squash = res.itens.find((i) => i.numero === 14)!;
    expect(squash.titulo).toBe("Adiciona Z");
    expect(squash.commits).toEqual([]);

    const body = h.vault.notes.get(res.path)!;
    expect(body).toContain("## Pull requests");
    expect(body).toMatch(/- #12 Adiciona o recurso X \(`[0-9a-f]{7}`, Teste\)\n {2}- `[0-9a-f]{7}` feat: x parte 2 \(Teste\)\n {2}- `[0-9a-f]{7}` feat: x parte 1/);
    expect(body).toContain("- #13 Corrige o problema Y");
    expect(body).toContain("- #14 Adiciona Z");
    // The commits that came with a PR appear under it only.
    expect(body.match(/feat: x parte 1/g)).toHaveLength(1);
    const commitsSection = body.slice(body.indexOf("## Commits"), body.indexOf("## Grafo"));
    expect(commitsSection).toContain("chore: ajuste solto");
    expect(commitsSection).not.toContain("feat: x");
    expect(commitsSection).not.toContain("fix: y");
    expect(commitsSection).not.toContain("Merged in");
    expect(res.commits).toBe(7);
  });

  it("lists the commits one by one when there is no PR", async () => {
    const dir = makeRepo();
    sh(dir, "tag", "v1");
    commit(dir, "b", "primeiro");
    commit(dir, "c", "segundo");
    const h = harness(dir);
    const res = await h.run({ versao: "v2" });
    expect(res.prs).toBe(0);
    const body = h.vault.notes.get(res.path)!;
    expect(body).not.toContain("## Pull requests");
    expect(body).toContain("## Commits");
    expect(res.itens.map((i) => i.tipo)).toEqual(["commit", "commit"]);
  });

  it("recognizes the pull request of a commit", () => {
    const base = { parents: ["a"], corpo: "" };
    expect(pullRequestOf({ ...base, parents: ["a", "b"], assunto: "Merged in feature/x (pull request #7)", corpo: "Título\n\nApproved-by: x" })).toEqual({ numero: 7, titulo: "Título", merge: true });
    expect(pullRequestOf({ ...base, parents: ["a", "b"], assunto: "Merge pull request #8 from o/br", corpo: "" })).toEqual({ numero: 8, titulo: "o/br", merge: true });
    expect(pullRequestOf({ ...base, assunto: "Faz coisa (#9)" })).toEqual({ numero: 9, titulo: "Faz coisa", merge: false });
    expect(pullRequestOf({ ...base, assunto: "Faz coisa (pull request #10)" })).toEqual({ numero: 10, titulo: "Faz coisa", merge: false });
    expect(pullRequestOf({ ...base, assunto: "Fix: sem número" })).toBeUndefined();
    expect(pullRequestOf({ ...base, assunto: "mencionou #11 no meio" })).toBeUndefined();
  });
});
