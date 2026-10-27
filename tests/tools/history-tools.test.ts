import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { createNodeGit } from "../../src/core/git-runner";
import { CheckpointStore } from "../../src/core/history/checkpoints";
import { prId } from "../../src/core/history/events";
import type { DevEventType } from "../../src/core/history/events";
import { HistoryService } from "../../src/core/history/history-service";
import type { RemoteSyncResult } from "../../src/core/history/remote-sync";
import type { ProjectInfo } from "../../src/core/ports";
import { buildGitTools } from "../../src/tools/git-tools";
import { buildHistoryTools } from "../../src/tools/history-tools";
import { cleanupTemp, makeRepo, makeTempDir, sh, writeFile } from "../helpers/git-repos";
import { MemoryVault } from "../helpers/memory-ports";
import { callTool, dataOf, makeDeps, textOf } from "../helpers/tool-deps";

afterAll(cleanupTemp);

function commit(dir: string, file: string, message: string): string {
  writeFile(dir, file, `${message}\n`);
  sh(dir, "add", ".");
  sh(dir, "commit", "-q", "-m", message);
  return sh(dir, "rev-parse", "HEAD").trim();
}

function setup(projects: { name: string; clone: string }[], remoteSync?: { syncProject: (p: ProjectInfo) => Promise<RemoteSyncResult> }, eventTypes?: DevEventType[]) {
  const vault = new MemoryVault();
  const store = new CheckpointStore({ load: async () => undefined, save: async () => undefined });
  const history = new HistoryService(createNodeGit(), vault, store, () => ({ eventsFolder: "Eventos", changelogsFolder: "Changelogs", ...(eventTypes ? { eventTypes } : {}) }));
  const deps = makeDeps({ projects, history, ...(remoteSync ? { remoteSync } : {}) });
  const tools = buildHistoryTools(deps);
  const call = (name: string, args: Record<string, unknown>) => callTool(tools, name, args);
  return { vault, store, history, deps, tools, call };
}

const names = (list: { name: string }[]): string[] => list.map((t) => t.name);
const eventNotes = (v: MemoryVault): string[] => [...v.notes.keys()].filter((p) => p.includes("/Eventos/") && !p.endsWith("Eventos.md"));

describe("registry", () => {
  it("has 28 tools with the history deps and 24 without them", () => {
    const repo = makeRepo();
    const s = setup([{ name: "App", clone: repo }]);
    const all = buildGitTools(s.deps);
    expect(all).toHaveLength(28);
    expect(names(all).slice(-4)).toEqual(["git_graph", "git_changelog", "git_sync", "git_registrar_evento"]);
    expect(new Set(names(all)).size).toBe(28);
    expect(buildGitTools(makeDeps({ projects: [{ name: "App", clone: repo }] }))).toHaveLength(24);
  });

  it("annotates the tools as the contract says", () => {
    const s = setup([]);
    const byName = Object.fromEntries(s.tools.map((t) => [t.name, t.annotations]));
    expect(byName.git_graph).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    for (const n of ["git_changelog", "git_sync", "git_registrar_evento"]) expect(byName[n]).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    expect(byName.git_sync?.openWorldHint).toBe(true);
    expect(byName.git_changelog?.openWorldHint).toBe(false);
    expect(byName.git_registrar_evento?.openWorldHint).toBe(false);
    for (const t of s.tools) expect(t.inputSchema.additionalProperties).toBe(false);
  });
});

describe("errors shared by the documentation tools", () => {
  it.each([
    ["git_graph", {}],
    ["git_changelog", {}],
    ["git_registrar_evento", { tipo: "pr", titulo: "x" }],
  ])("%s: an unknown project is argumento_invalido and lists the known ones", async (tool, extra) => {
    const repo = makeRepo();
    const s = setup([{ name: "App", clone: repo }]);
    const r = await s.call(tool, { projeto: "Outro", ...extra });
    expect(r.isError).toBe(true);
    expect(dataOf(r)).toMatchObject({ ok: false, codigo: "argumento_invalido" });
    expect(textOf(r)).toContain('Projeto "Outro" não encontrado');
    expect(textOf(r)).toContain("App");
  });

  it("a path is not a project name", async () => {
    const repo = makeRepo();
    const s = setup([{ name: "App", clone: repo }]);
    const r = await s.call("git_graph", { projeto: repo });
    expect(dataOf(r).codigo).toBe("argumento_invalido");
  });

  it("a project whose note has no clone is argumento_invalido", async () => {
    const s = setup([{ name: "SemClone", clone: "" }]);
    s.deps.projects = { ...s.deps.projects, byName: () => Promise.resolve({ name: "SemClone", folder: "Projetos/SemClone", clonePath: undefined }) };
    const r = await s.call("git_changelog", { projeto: "SemClone" });
    expect(dataOf(r).codigo).toBe("argumento_invalido");
    expect(textOf(r)).toContain("não tem clone local");
  });

  it("a clone folder that is not a git repository is argumento_invalido", async () => {
    const dir = makeTempDir();
    const s = setup([{ name: "App", clone: dir }]);
    const r = await s.call("git_graph", { projeto: "App" });
    expect(dataOf(r).codigo).toBe("argumento_invalido");
    expect(textOf(r)).toContain("não é um repositório git");
  });

  it("refuses an argument the schema does not declare", async () => {
    const repo = makeRepo();
    const s = setup([{ name: "App", clone: repo }]);
    const r = await s.call("git_graph", { projeto: "App", repo });
    expect(dataOf(r).codigo).toBe("argumento_invalido");
  });
});

describe("git_graph", () => {
  it("draws the graph with lines and the svg, highlighting a branch and a commit", async () => {
    const repo = makeRepo();
    sh(repo, "checkout", "-q", "-b", "feature/x");
    const onFeature = commit(repo, "b", "na feature");
    sh(repo, "checkout", "-q", "main");
    commit(repo, "c", "na main");
    sh(repo, "merge", "-q", "--no-ff", "-m", "Merge feature", "feature/x");
    const s = setup([{ name: "App", clone: repo }]);
    const r = await s.call("git_graph", { projeto: "App", branch: "feature/x", hash: onFeature.slice(0, 7), formato: "svg" });
    expect(r.isError).not.toBe(true);
    const d = dataOf(r);
    expect(d).toMatchObject({ ok: true, projeto: "App", commits: 4 });
    expect(d.faixas as number).toBeGreaterThanOrEqual(2);
    expect((d.linhas as unknown[]).length).toBe(4);
    expect(d.svg as string).toContain("<svg");
    expect(d.svg as string).toContain('class="hl"');
    const text = textOf(r);
    expect(text).toContain("na feature");
    expect(text).toContain("Merge feature");
    expect(text).toContain("SVG:");
  });

  it("defaults to formato texto, returning only text lines without svg", async () => {
    const repo = makeRepo();
    sh(repo, "checkout", "-q", "-b", "feature/x");
    commit(repo, "b", "na feature");
    sh(repo, "checkout", "-q", "main");
    commit(repo, "c", "na main");
    sh(repo, "merge", "-q", "--no-ff", "-m", "Merge feature", "feature/x");
    const s = setup([{ name: "App", clone: repo }]);
    const r = await s.call("git_graph", { projeto: "App" });
    expect(r.isError).not.toBe(true);
    expect(JSON.stringify(r)).not.toContain("<svg");
    const d = dataOf(r);
    expect(d.formato).toBe("texto");
    expect(d.commits).toBe(4);
    expect(d.svg).toBeUndefined();
    expect(d.linhas).toBeUndefined();
    expect(textOf(r)).toContain("na feature");
  });

  it("saves the svg in Anexos with formato arquivo", async () => {
    const repo = makeRepo();
    commit(repo, "b", "na feature");
    const s = setup([{ name: "App", clone: repo }]);
    const r = await s.call("git_graph", { projeto: "App", formato: "arquivo" });
    expect(r.isError).not.toBe(true);
    const d = dataOf(r);
    expect(d.caminho).toBeDefined();
    expect(s.vault.notes.get(d.caminho as string)).toContain("<svg");
    expect(textOf(r)).toContain(d.caminho as string);
    expect(textOf(r)).not.toContain("<svg");
  });

  it("refuses an invalid formato", async () => {
    const repo = makeRepo();
    const s = setup([{ name: "App", clone: repo }]);
    const r = await s.call("git_graph", { projeto: "App", formato: "xml" });
    expect(dataOf(r).codigo).toBe("argumento_invalido");
  });

  it("does not create a .svg note when the repository has no commits", async () => {
    const dir = join(makeTempDir(), "sem-commits");
    mkdirSync(dir);
    sh(dir, "init", "-b", "main");
    const s = setup([{ name: "App", clone: dir }]);
    const r = await s.call("git_graph", { projeto: "App", formato: "arquivo" });
    expect(r.isError).not.toBe(true);
    expect([...s.vault.notes.keys()].some((p) => p.endsWith(".svg"))).toBe(false);
  });

  it("honors limite", async () => {
    const repo = makeRepo();
    commit(repo, "b", "dois");
    commit(repo, "c", "tres");
    const s = setup([{ name: "App", clone: repo }]);
    expect(dataOf(await s.call("git_graph", { projeto: "App", limite: 2 })).commits).toBe(2);
  });

  it("refuses a branch or hash that git would read as an option", async () => {
    const repo = makeRepo();
    const s = setup([{ name: "App", clone: repo }]);
    expect(dataOf(await s.call("git_graph", { projeto: "App", branch: "--all" })).codigo).toBe("argumento_invalido");
    expect(dataOf(await s.call("git_graph", { projeto: "App", hash: "--x" })).codigo).toBe("argumento_invalido");
  });
});

describe("git_changelog", () => {
  it("writes the note with the two commits since the last tag and creates the index", async () => {
    const repo = makeRepo();
    sh(repo, "tag", "v1.0.0");
    commit(repo, "b", "corrige bug");
    commit(repo, "c", "nova função");
    const s = setup([{ name: "App", clone: repo }]);
    const r = await s.call("git_changelog", { projeto: "App", versao: "v1.1.0" });
    expect(r.isError).not.toBe(true);
    const d = dataOf(r);
    expect(d).toMatchObject({ ok: true, caminho: "Projetos/App/Changelogs/App - v1.1.0.md", nota: "Projetos/App/Changelogs/App - v1.1.0.md", criada: true, indice_criado: true, commits: 2, desde: "v1.0.0" });
    expect((d.itens as { titulo: string }[]).map((i) => i.titulo)).toEqual(["nova função", "corrige bug"]);
    const note = s.vault.notes.get("Projetos/App/Changelogs/App - v1.1.0.md")!;
    expect(note).toContain("  - dev/changelog");
    expect(note).toContain("nova função");
    expect(s.vault.exists("Projetos/App/Changelogs/App - Changelog.md")).toBe(true);
    expect(textOf(r)).toContain("Nota de changelog criada");
  });

  it("running it again for the same version updates the note", async () => {
    const repo = makeRepo();
    commit(repo, "b", "um");
    const s = setup([{ name: "App", clone: repo }]);
    await s.call("git_changelog", { projeto: "App", versao: "v1" });
    commit(repo, "c", "dois");
    const again = await s.call("git_changelog", { projeto: "App", versao: "v1" });
    expect(dataOf(again)).toMatchObject({ criada: false, atualizada: true, indice_criado: false });
    expect([...s.vault.notes.keys()].filter((p) => p.endsWith("v1.md"))).toHaveLength(1);
    expect(s.vault.notes.get("Projetos/App/Changelogs/App - v1.md")).toContain("dois");
  });

  it("groups by merged PR", async () => {
    const repo = makeRepo();
    sh(repo, "tag", "v1");
    sh(repo, "checkout", "-q", "-b", "feature-x");
    commit(repo, "x", "feat: x");
    sh(repo, "checkout", "-q", "main");
    sh(repo, "merge", "-q", "--no-ff", "-m", "Merge pull request #5 from o/feature-x", "-m", "Recurso X", "feature-x");
    commit(repo, "z", "Outra coisa (#6)");
    const s = setup([{ name: "App", clone: repo }]);
    const d = dataOf(await s.call("git_changelog", { projeto: "App", versao: "v2" }));
    expect(d.prs).toBe(2);
    expect((d.itens as { tipo: string; numero?: number }[]).map((i) => [i.tipo, i.numero])).toEqual([["pr", 6], ["pr", 5]]);
  });

  it("an unknown or unsafe ref is argumento_invalido and writes no note", async () => {
    const repo = makeRepo();
    const s = setup([{ name: "App", clone: repo }]);
    const unknown = await s.call("git_changelog", { projeto: "App", desde: "nao-existe" });
    expect(dataOf(unknown).codigo).toBe("argumento_invalido");
    const unsafe = await s.call("git_changelog", { projeto: "App", ate: "--all" });
    expect(dataOf(unsafe).codigo).toBe("argumento_invalido");
    expect(s.vault.notes.size).toBe(0);
  });
});

describe("git_sync", () => {
  it("stores only the baseline the first time and records the new commit afterwards", async () => {
    const repo = makeRepo();
    const s = setup([{ name: "App", clone: repo }]);
    const first = await s.call("git_sync", { projeto: "App" });
    expect(dataOf(first)).toMatchObject({ ok: true, total_criadas: 0 });
    expect((dataOf(first).projetos as { linha_de_base: boolean }[])[0]?.linha_de_base).toBe(true);
    expect(textOf(first)).toContain("Primeira leitura");
    expect(eventNotes(s.vault)).toHaveLength(0);

    commit(repo, "b", "feat: nova");
    const second = await s.call("git_sync", { projeto: "App" });
    expect(dataOf(second).total_criadas).toBe(1);
    expect(eventNotes(s.vault).some((p) => p.includes("Commit "))).toBe(true);
    // Nothing new: nothing created.
    expect(dataOf(await s.call("git_sync", { projeto: "App" })).total_criadas).toBe(0);
  });

  it("without projeto it goes through every project with a clone and reports the ones it skipped", async () => {
    const a = makeRepo(undefined, "a");
    const b = makeRepo(undefined, "b");
    const notGit = makeTempDir();
    const s = setup([
      { name: "Alfa", clone: a },
      { name: "Beta", clone: b },
      { name: "Gama", clone: notGit },
    ]);
    // A project whose note has no clone.
    const list = await s.deps.projects.list();
    s.deps.projects = { ...s.deps.projects, list: () => Promise.resolve([...list, { name: "Delta", folder: "Projetos/Delta", clonePath: undefined }]) };
    const spy = vi.spyOn(s.history, "sync");
    const r = await s.call("git_sync", {});
    expect(r.isError).not.toBe(true);
    expect(spy.mock.calls.map((c) => c[0].name)).toEqual(["Alfa", "Beta"]);
    const d = dataOf(r);
    expect((d.projetos as { projeto: string }[]).map((p) => p.projeto)).toEqual(["Alfa", "Beta"]);
    expect(d.ignorados).toEqual([
      { projeto: "Gama", motivo: "a pasta do clone não é um repositório git" },
      { projeto: "Delta", motivo: "sem clone local" },
    ]);
    expect((d.avisos as string[]).some((w) => w.includes("Delta"))).toBe(true);
  });

  it("an unknown project is argumento_invalido", async () => {
    const s = setup([]);
    expect(dataOf(await s.call("git_sync", { projeto: "X" })).codigo).toBe("argumento_invalido");
  });

  it("reads the remote when asked and adds what it created", async () => {
    const repo = makeRepo();
    const syncProject = vi.fn(async (p: ProjectInfo): Promise<RemoteSyncResult> => ({ project: p.name, baseline: false, created: ["Projetos/App/Eventos/PR 7 - x.md"], updated: ["Projetos/App/Eventos/PR 3 - y.md"], errors: [] }));
    const s = setup([{ name: "App", clone: repo }], { syncProject });
    const r = await s.call("git_sync", { projeto: "App", remoto: true });
    expect(syncProject).toHaveBeenCalledTimes(1);
    const d = dataOf(r);
    expect(d.criadas).toContain("Projetos/App/Eventos/PR 7 - x.md");
    expect(d.atualizadas).toEqual(["Projetos/App/Eventos/PR 3 - y.md"]);
    expect((d.projetos as { remoto: { lido: boolean } }[])[0]?.remoto.lido).toBe(true);
  });

  it("does not read the remote without the option", async () => {
    const repo = makeRepo();
    const syncProject = vi.fn();
    const s = setup([{ name: "App", clone: repo }], { syncProject });
    await s.call("git_sync", { projeto: "App" });
    expect(syncProject).not.toHaveBeenCalled();
  });

  it("without a secret the remote is only a warning, not an error", async () => {
    const repo = makeRepo();
    const syncProject = async (p: ProjectInfo): Promise<RemoteSyncResult> => ({ project: p.name, skipped: "sem secret para o github", baseline: false, created: [], updated: [], errors: [] });
    const s = setup([{ name: "App", clone: repo }], { syncProject });
    const r = await s.call("git_sync", { projeto: "App", remoto: true });
    expect(r.isError).not.toBe(true);
    expect(dataOf(r).ok).toBe(true);
    expect(dataOf(r).avisos).toContain("Remoto de App não lido: sem secret para o github.");
    expect((dataOf(r).projetos as { remoto: { lido: boolean; ignorado: string } }[])[0]?.remoto).toMatchObject({ lido: false, ignorado: "sem secret para o github" });
  });

  it("warns when the remote read is not available at all", async () => {
    const repo = makeRepo();
    const s = setup([{ name: "App", clone: repo }]);
    const r = await s.call("git_sync", { projeto: "App", remoto: true });
    expect(r.isError).not.toBe(true);
    expect(dataOf(r).avisos).toContain("A leitura do remoto não está disponível neste momento.");
  });

  it("fails with git_falhou when every project failed and nothing was recorded", async () => {
    const repo = makeRepo();
    const s = setup([{ name: "App", clone: repo }]);
    vi.spyOn(s.history, "sync").mockResolvedValue({ project: "App", baseline: false, created: [], errors: ["boom"] });
    const r = await s.call("git_sync", { projeto: "App" });
    expect(r.isError).toBe(true);
    expect(dataOf(r).codigo).toBe("git_falhou");
  });
});

describe("git_registrar_evento", () => {
  const PR = { projeto: "App", tipo: "pr", titulo: "Abre o PR 12", branch: "feature/x", url: "https://example.com/pr/12", estado: "open" };

  it("writes the note of an event the repository does not show", async () => {
    const repo = makeRepo();
    const s = setup([{ name: "App", clone: repo }]);
    const r = await s.call("git_registrar_evento", PR);
    expect(r.isError).not.toBe(true);
    const d = dataOf(r);
    expect(d).toMatchObject({ ok: true, projeto: "App", id: "pr-feature/x-Abre o PR 12", criado: true });
    expect(d.nota).toBe(d.caminho);
    const note = s.vault.notes.get(d.caminho as string)!;
    expect(note).toContain("  - dev/pr");
    expect(note).toContain('evento_id: "pr-feature/x-Abre o PR 12"');
    expect(note).toContain("| Link | https://example.com/pr/12 |");
    expect(note).toContain('estado: "open"');
    expect(note).toContain("```ai-git-graph");
    expect(s.vault.exists("Projetos/App/Eventos/App - Eventos.md")).toBe(true);
  });

  it("does not duplicate when repeated", async () => {
    const repo = makeRepo();
    const s = setup([{ name: "App", clone: repo }]);
    const first = await s.call("git_registrar_evento", PR);
    const second = await s.call("git_registrar_evento", PR);
    expect(dataOf(second)).toMatchObject({ criado: false, id: dataOf(first).id, caminho: dataOf(first).caminho });
    expect(eventNotes(s.vault)).toHaveLength(1);
    expect(textOf(second)).toContain("já estava gravado");
  });

  it("a deploy with environment and details", async () => {
    const repo = makeRepo();
    const s = setup([{ name: "App", clone: repo }]);
    const r = await s.call("git_registrar_evento", { projeto: "App", tipo: "deploy", titulo: "Produção 1.2", ambiente: "producao", detalhes: "Subiu às 10h.", estado: "sucesso" });
    const note = s.vault.notes.get(dataOf(r).caminho as string)!;
    expect(note).toContain('ambiente: "producao"');
    expect(note).toContain("Subiu às 10h.");
    expect(dataOf(r).id).toBe("deploy-Produção 1.2");
  });

  it("a commit with a short hash uses the id of the automatic record, so the sync does not duplicate it", async () => {
    const repo = makeRepo();
    const s = setup([{ name: "App", clone: repo }]);
    await s.call("git_sync", { projeto: "App" }); // baseline
    const hash = commit(repo, "b", "feat: manual");
    const r = await s.call("git_registrar_evento", { projeto: "App", tipo: "commit", titulo: "feat: manual", hash: hash.slice(0, 7), branch: "main" });
    expect(dataOf(r)).toMatchObject({ id: `commit-${hash}`, criado: true });
    await s.call("git_sync", { projeto: "App" });
    expect(eventNotes(s.vault).filter((p) => p.includes("/Commit "))).toHaveLength(1);
  });

  it("a branch with a hash uses the id of the automatic record", async () => {
    const repo = makeRepo();
    const head = sh(repo, "rev-parse", "HEAD").trim();
    const s = setup([{ name: "App", clone: repo }]);
    const r = await s.call("git_registrar_evento", { projeto: "App", tipo: "branch", titulo: "feature/y", branch: "feature/y", hash: head.slice(0, 10) });
    expect(dataOf(r).id).toBe(`branch-feature/y-${head.slice(0, 7)}`);
  });

  it("refuses an invalid tipo, an empty titulo, a bad url, a bad branch and a hash that looks like an option", async () => {
    const repo = makeRepo();
    const s = setup([{ name: "App", clone: repo }]);
    const invalidType = await s.call("git_registrar_evento", { projeto: "App", tipo: "release", titulo: "x" });
    expect(dataOf(invalidType).codigo).toBe("argumento_invalido");
    expect(textOf(invalidType)).toContain("tipo inválido");
    expect(dataOf(await s.call("git_registrar_evento", { projeto: "App", tipo: "pr", titulo: "  " })).codigo).toBe("argumento_invalido");
    expect(dataOf(await s.call("git_registrar_evento", { projeto: "App", tipo: "pr", titulo: "x", url: "javascript:alert(1)" })).codigo).toBe("argumento_invalido");
    expect(dataOf(await s.call("git_registrar_evento", { projeto: "App", tipo: "pr", titulo: "x", branch: "-x" })).codigo).toBe("argumento_invalido");
    expect(dataOf(await s.call("git_registrar_evento", { projeto: "App", tipo: "commit", titulo: "x", hash: "--help" })).codigo).toBe("argumento_invalido");
    expect(eventNotes(s.vault)).toHaveLength(0);
  });

  it("ignores the eventTypes filter and records even when eventTypes is empty", async () => {
    const repo = makeRepo();
    const s = setup([{ name: "App", clone: repo }], undefined, []);
    const first = await s.call("git_registrar_evento", PR);
    expect(dataOf(first).criado).toBe(true);
    expect(s.vault.notes.has(dataOf(first).caminho as string)).toBe(true);
    const second = await s.call("git_registrar_evento", PR);
    expect(dataOf(second).criado).toBe(false);
  });

  it("an empty clone folder is not a repository", async () => {
    const dir = join(makeTempDir(), "nao-criada");
    mkdirSync(dir);
    const s = setup([{ name: "App", clone: dir }]);
    expect(dataOf(await s.call("git_registrar_evento", PR)).codigo).toBe("argumento_invalido");
  });

  it("with numero on a GitHub clone sets remote-sync prId and does not duplicate on repeat", async () => {
    const repo = makeRepo();
    sh(repo, "remote", "add", "origin", "https://github.com/o/r.git");
    const s = setup([{ name: "App", clone: repo }]);
    const first = await s.call("git_registrar_evento", { projeto: "App", tipo: "pr", titulo: "Abre o PR 12", numero: 12 });
    expect(dataOf(first)).toMatchObject({ id: "pr-github-o/r-12", criado: true });
    const second = await s.call("git_registrar_evento", { projeto: "App", tipo: "pr", titulo: "Abre o PR 12", numero: 12 });
    expect(dataOf(second)).toMatchObject({ id: "pr-github-o/r-12", criado: false, caminho: dataOf(first).caminho });
    expect(eventNotes(s.vault)).toHaveLength(1);
  });

  it("recognizes a PR note already created by remote sync and does not duplicate", async () => {
    const repo = makeRepo();
    sh(repo, "remote", "add", "origin", "https://github.com/o/r.git");
    const s = setup([{ name: "App", clone: repo }]);
    const remoteRecord = await s.history.recordRemote(
      { name: "App", folder: "Projetos/App", clonePath: repo },
      { tipo: "pr", projeto: "App", id: prId("github", "o/r", 12), titulo: "Abre o PR 12", data: new Date(), estado: "open" },
    );
    const r = await s.call("git_registrar_evento", { projeto: "App", tipo: "pr", titulo: "Abre o PR 12", numero: 12 });
    expect(dataOf(r)).toMatchObject({ criado: false, caminho: remoteRecord.path });
    expect(eventNotes(s.vault)).toHaveLength(1);
  });

  it("refuses numero with tipo other than pr", async () => {
    const repo = makeRepo();
    const s = setup([{ name: "App", clone: repo }]);
    const r = await s.call("git_registrar_evento", { projeto: "App", tipo: "commit", titulo: "Commit", numero: 12 });
    expect(dataOf(r).codigo).toBe("argumento_invalido");
    expect(textOf(r)).toContain("só vale com tipo pr");
  });

  it("refuses numero when remote is not GitHub or Bitbucket", async () => {
    const repo = makeRepo();
    sh(repo, "remote", "add", "origin", "https://exemplo.com/o/r.git");
    const s = setup([{ name: "App", clone: repo }]);
    const r = await s.call("git_registrar_evento", { projeto: "App", tipo: "pr", titulo: "Abre o PR 12", numero: 12 });
    expect(dataOf(r).codigo).toBe("argumento_invalido");
    expect(eventNotes(s.vault)).toHaveLength(0);
  });

  it("refuses numero less than 1", async () => {
    const repo = makeRepo();
    const s = setup([{ name: "App", clone: repo }]);
    const r = await s.call("git_registrar_evento", { projeto: "App", tipo: "pr", titulo: "Abre o PR 12", numero: 0 });
    expect(dataOf(r).codigo).toBe("argumento_invalido");
  });
});
