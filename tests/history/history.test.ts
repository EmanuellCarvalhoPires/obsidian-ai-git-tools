import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { CheckpointStore } from "../../src/core/history/checkpoints";
import { branchId, commitId, parseGraphBlock, prId, pushId, renderEventNote } from "../../src/core/history/events";
import type { DevEventType } from "../../src/core/history/events";
import { HistoryService } from "../../src/core/history/history-service";
import { LOG_FORMAT, layout, parseLog, toSvg } from "../../src/core/history/graph";
import { createNodeGit } from "../../src/core/git-runner";
import type { ProjectInfo } from "../../src/core/ports";
import { cleanupTemp, makeBareRemote, makeRepo, makeTempDir, sh, writeFile } from "../helpers/git-repos";
import { MemoryVault } from "../helpers/memory-ports";
import { configureClone } from "../helpers/spy-git";

afterAll(cleanupTemp);

function commit(dir: string, file: string, message: string): string {
  writeFile(dir, file, `${message}\n`);
  sh(dir, "add", ".");
  sh(dir, "commit", "-q", "-m", message);
  return sh(dir, "rev-parse", "HEAD").trim();
}

function harness(clone: string | undefined, eventTypes?: DevEventType[]) {
  const vault = new MemoryVault();
  const store = new CheckpointStore({ load: async () => undefined, save: async () => undefined });
  const history = new HistoryService(createNodeGit(), vault, store, () => ({ eventsFolder: "Eventos", ...(eventTypes ? { eventTypes } : {}) }));
  const project: ProjectInfo = { name: "App", folder: "Projetos/App", clonePath: clone };
  return { vault, store, history, project };
}

const eventNotes = (v: MemoryVault, prefix: string): string[] => [...v.notes.keys()].filter((p) => p.includes(`/Eventos/${prefix}`));

describe("graph", () => {
  it("lays out a merge and draws an svg with the highlight", async () => {
    const dir = makeRepo();
    sh(dir, "checkout", "-q", "-b", "feature/x");
    const onFeature = commit(dir, "b", "na feature");
    sh(dir, "checkout", "-q", "main");
    commit(dir, "c", "na main");
    sh(dir, "merge", "-q", "--no-ff", "-m", "Merge feature", "feature/x");
    sh(dir, "tag", "v1");
    const commits = parseLog(await createNodeGit()(dir, ["log", "--all", "--date-order", LOG_FORMAT]));
    expect(commits).toHaveLength(4);
    const { rows, lanes } = layout(commits);
    expect(lanes).toBeGreaterThanOrEqual(2);
    expect(rows[0]?.refs).toContain("tag: v1");
    const svg = toSvg(rows, lanes, Date.now(), 320, { branch: "feature/x", hash: onFeature.slice(0, 7) });
    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).toContain("na feature");
    expect(svg).toContain('class="hl"');
    expect(svg).toContain("aigt-graph-svg");
  });

  it("HistoryService.graph draws the repository and fails clearly without a clone", async () => {
    const dir = makeRepo();
    commit(dir, "b", "segundo");
    const h = harness(dir);
    const g = await h.history.graph(h.project, { limit: 5 });
    expect(g.rows).toHaveLength(2);
    expect(g.svg).toContain("segundo");
    await expect(harness(undefined).history.graph({ name: "App", folder: "Projetos/App", clonePath: undefined })).rejects.toThrow(/no git clone/);
  });
});

describe("history sync", () => {
  it("stores a baseline first and records nothing", async () => {
    const dir = makeRepo();
    const h = harness(dir);
    const res = await h.history.sync(h.project);
    expect(res.baseline).toBe(true);
    expect(h.vault.notes.size).toBe(0);
    expect(h.store.getDev("App")).toBeDefined();
  });

  it("does nothing for a project without a git clone", async () => {
    const h = harness("C:/nao/existe");
    const res = await h.history.sync(h.project);
    expect(res).toEqual({ project: "App", baseline: false, created: [], errors: [] });
  });

  it("records new commits once, with the ai-git-graph block, and a new branch", async () => {
    const dir = makeRepo();
    const h = harness(dir);
    await h.history.sync(h.project);
    commit(dir, "b", "feat: primeira mudança");
    sh(dir, "branch", "feature/nova");
    const res = await h.history.sync(h.project);
    expect(res.errors).toEqual([]);
    const commitNotes = eventNotes(h.vault, "Commit ");
    expect(commitNotes).toHaveLength(1);
    const body = h.vault.notes.get(commitNotes[0]!)!;
    expect(body).toContain("  - dev/commit");
    expect(body).toContain('up: "[[App - Eventos]]"');
    expect(body).toContain('evento_id: "commit-');
    expect(body).toContain("```ai-git-graph");
    expect(body).not.toContain("ai-log-graph");
    expect(h.vault.notes.has("Projetos/App/Eventos/Branch feature-nova.md")).toBe(true);
    const index = h.vault.notes.get("Projetos/App/Eventos/App - Eventos.md")!;
    expect(index).toContain("tags:\n  - moc");
    expect(index).toContain("```dataview");
    const count = h.vault.notes.size;
    await h.history.sync(h.project);
    expect(h.vault.notes.size).toBe(count);
  });

  it("rebuilds the notes of commits made while Obsidian was closed", async () => {
    const dir = makeRepo();
    const h = harness(dir);
    await h.history.sync(h.project);
    commit(dir, "b", "um");
    commit(dir, "c", "dois");
    commit(dir, "d", "tres");
    await h.history.sync(h.project);
    expect(eventNotes(h.vault, "Commit ")).toHaveLength(3);
  });

  it("detects a push by the remote-tracking branch moving", async () => {
    const dir = makeRepo();
    const bare = makeBareRemote();
    sh(dir, "remote", "add", "origin", bare);
    sh(dir, "push", "-q", "-u", "origin", "main");
    const h = harness(dir);
    await h.history.sync(h.project);
    commit(dir, "b", "novo");
    sh(dir, "push", "-q");
    await h.history.sync(h.project);
    const push = eventNotes(h.vault, "Push main");
    expect(push).toHaveLength(1);
    const body = h.vault.notes.get(push[0]!)!;
    expect(body).toContain("  - dev/push");
    expect(body).toContain("Commits enviados");
    expect(body).toContain('evento_id: "push-origin/main-');
  });

  it("fetch and pull do not become push notes, but a real push does", async () => {
    const dir = makeRepo();
    const bare = makeBareRemote();
    sh(dir, "remote", "add", "origin", bare);
    sh(dir, "push", "-q", "-u", "origin", "main");
    const h = harness(dir);
    await h.history.sync(h.project);

    const base = makeTempDir();
    const outro = join(base, "outro");
    sh(base, "clone", "-q", bare, outro);
    configureClone(sh, outro);

    commit(outro, "remoto.txt", "pelo outro clone");
    sh(outro, "push", "-q");

    sh(dir, "fetch", "-q");
    await h.history.sync(h.project);
    expect(eventNotes(h.vault, "Push main")).toHaveLength(0);

    sh(dir, "merge", "-q", "--ff-only", "origin/main");
    await h.history.sync(h.project);
    expect(eventNotes(h.vault, "Push main")).toHaveLength(0);

    commit(dir, "local.txt", "feito localmente");
    sh(dir, "push", "-q");
    await h.history.sync(h.project);
    expect(eventNotes(h.vault, "Push main")).toHaveLength(1);
  });

  it("records a push even when a fetch happened earlier in the same sync window", async () => {
    const dir = makeRepo();
    const bare = makeBareRemote();
    sh(dir, "remote", "add", "origin", bare);
    sh(dir, "push", "-q", "-u", "origin", "main");
    const h = harness(dir);
    await h.history.sync(h.project);

    const base = makeTempDir();
    const outro = join(base, "outro");
    sh(base, "clone", "-q", bare, outro);
    configureClone(sh, outro);

    commit(outro, "remoto.txt", "pelo outro clone");
    sh(outro, "push", "-q");

    sh(dir, "fetch", "-q");
    sh(dir, "merge", "-q", "--ff-only", "origin/main");
    commit(dir, "local.txt", "feito localmente");
    sh(dir, "push", "-q");

    await h.history.sync(h.project);
    expect(eventNotes(h.vault, "Push main")).toHaveLength(1);
  });
});

describe("history record and deduplication", () => {
  it("record creates once and returns the existing path afterwards", async () => {
    const h = harness(undefined);
    const ev = { tipo: "commit" as const, projeto: "App", id: commitId("a".repeat(40)), titulo: "feito pela tool", data: new Date(0), branch: "main", hash: "a".repeat(40) };
    const first = await h.history.record(h.project, ev);
    expect(first.created).toBe(true);
    expect(first.path).toBe("Projetos/App/Eventos/Commit aaaaaaa - feito pela tool.md");
    const second = await h.history.record(h.project, ev);
    expect(second).toEqual({ path: first.path, created: false });
    expect(h.vault.notes.size).toBe(2); // the note and the index
  });

  it("does not recreate an event whose note was written by the AI Log Manager (other file name)", async () => {
    const dir = makeRepo();
    const h = harness(dir);
    await h.history.sync(h.project);
    const hash = commit(dir, "b", "feito antes");
    // The Log Manager wrote this note, with the same evento_id and another name, in a subfolder.
    const foreign = "Projetos/App/Eventos/2026/commit antigo do log manager.md";
    h.vault.notes.set(foreign, `---\ntags:\n  - dev/commit\nevento: commit\nevento_id: "${commitId(hash)}"\n---\n# Commit\n`);
    const res = await h.history.sync(h.project);
    expect(res.created).toEqual([]);
    expect(eventNotes(h.vault, "Commit ")).toEqual([]);
    // Same through record(), even with a store that never saw the id.
    const fresh = harness(dir);
    fresh.vault.notes.set(foreign, h.vault.notes.get(foreign)!);
    const again = await fresh.history.record(fresh.project, { tipo: "commit", projeto: "App", id: commitId(hash), titulo: "feito antes", data: new Date(), hash });
    expect(again).toEqual({ path: foreign, created: false });
  });

  it("finds the existing note by the path of the event when it has no id, and never makes a suffixed copy for the same id", async () => {
    const h = harness(undefined);
    const ev = { tipo: "branch" as const, projeto: "App", id: branchId("feature/x", "b".repeat(40)), titulo: "feature/x", data: new Date(0), branch: "feature/x", hash: "b".repeat(40) };
    h.vault.notes.set("Projetos/App/Eventos/Branch feature-x.md", "# feito à mão\n");
    const r = await h.history.record(h.project, ev);
    expect(r).toEqual({ path: "Projetos/App/Eventos/Branch feature-x.md", created: false });
    expect([...h.vault.notes.keys()].filter((p) => p.includes("Branch feature-x"))).toHaveLength(1);
  });

  it("a different event with the same note name gets a suffix", async () => {
    const h = harness(undefined);
    const a = { tipo: "branch" as const, projeto: "App", id: branchId("x", "1".repeat(40)), titulo: "x", data: new Date(0), branch: "x", hash: "1".repeat(40) };
    const b = { ...a, id: branchId("x", "2".repeat(40)), hash: "2".repeat(40) };
    const ra = await h.history.record(h.project, a);
    const rb = await h.history.record(h.project, b);
    expect(rb.created).toBe(true);
    expect(rb.path).not.toBe(ra.path);
    expect((await h.history.record(h.project, b)).created).toBe(false);
    expect(eventNotes(h.vault, "Branch ")).toHaveLength(2);
  });

  it("serializes concurrent records of the same event", async () => {
    const h = harness(undefined);
    const ev = { tipo: "commit" as const, projeto: "App", id: commitId("c".repeat(40)), titulo: "concorrente", data: new Date(0), hash: "c".repeat(40) };
    const results = await Promise.all([h.history.record(h.project, ev), h.history.record(h.project, ev), h.history.record(h.project, ev)]);
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(eventNotes(h.vault, "Commit ")).toHaveLength(1);
  });

  it("a commit recorded by a tool is not recorded again by the sync", async () => {
    const dir = makeRepo();
    const h = harness(dir);
    await h.history.sync(h.project);
    const hash = commit(dir, "b", "pela tool");
    await h.history.record(h.project, { tipo: "commit", projeto: "App", id: commitId(hash), titulo: "pela tool", data: new Date(), hash, branch: "main" });
    const res = await h.history.sync(h.project);
    expect(res.created).toEqual([]);
    expect(eventNotes(h.vault, "Commit ")).toHaveLength(1);
  });

  it("recordRemote updates the state of a pull request that already has a note", async () => {
    const h = harness(undefined);
    h.store.setDev("App", { cursorMs: 1, tips: {}, branches: [], prStates: {} });
    const ev = { tipo: "pr" as const, projeto: "App", id: prId("github", "o/r", 5), titulo: "Add x", data: new Date(0), estado: "open", url: "https://github.com/o/r/pull/5" };
    const first = await h.history.recordRemote(h.project, ev);
    expect(first).toMatchObject({ created: true, updated: false });
    const merged = await h.history.recordRemote(h.project, { ...ev, estado: "merged" });
    expect(merged).toMatchObject({ created: false, updated: true, path: first.path });
    const body = h.vault.notes.get(first.path)!;
    expect(body).toContain('estado: "merged"');
    expect(body).toContain("| Estado | merged |");
    expect(h.store.getDev("App")?.prStates[ev.id]).toBe("merged");
    expect(await h.history.recordRemote(h.project, { ...ev, estado: "merged" })).toMatchObject({ updated: false });
  });
});

describe("event types", () => {
  it("with ['pr']: baseline, 2 commits and a push creates neither commit notes nor push notes", async () => {
    const dir = makeRepo();
    const bare = makeBareRemote();
    sh(dir, "remote", "add", "origin", bare);
    sh(dir, "push", "-q", "-u", "origin", "main");
    const h = harness(dir, ["pr"]);
    await h.history.sync(h.project);
    commit(dir, "b", "c1");
    commit(dir, "c", "c2");
    sh(dir, "push", "-q");
    await h.history.sync(h.project);
    expect(eventNotes(h.vault, "Commit ")).toHaveLength(0);
    expect(eventNotes(h.vault, "Push ")).toHaveLength(0);
  });

  it("with ['commit']: 1 commit creates commit note and no push note", async () => {
    const dir = makeRepo();
    const bare = makeBareRemote();
    sh(dir, "remote", "add", "origin", bare);
    sh(dir, "push", "-q", "-u", "origin", "main");
    const h = harness(dir, ["commit"]);
    await h.history.sync(h.project);
    commit(dir, "b", "c1");
    sh(dir, "push", "-q");
    await h.history.sync(h.project);
    expect(eventNotes(h.vault, "Commit ")).toHaveLength(1);
    expect(eventNotes(h.vault, "Push ")).toHaveLength(0);
  });

  it("record with commit event and ['pr'] ignores unless forced", async () => {
    const h = harness(undefined, ["pr"]);
    const ev = { tipo: "commit" as const, projeto: "App", id: commitId("c".repeat(40)), titulo: "commit manual", data: new Date(0) };
    const res = await h.history.record(h.project, ev);
    expect(res).toEqual({ path: "", created: false, ignorado: true });
    expect(h.vault.notes.size).toBe(0);

    const forced = await h.history.record(h.project, ev, { forcar: true });
    expect(forced.created).toBe(true);
    expect(forced.ignorado).toBeUndefined();
    expect(h.vault.notes.size).toBeGreaterThan(0);
  });

  it("recordRemote with deploy event and ['pr'] returns ignorado: true", async () => {
    const h = harness(undefined, ["pr"]);
    const ev = { tipo: "deploy" as const, projeto: "App", id: "dep-1", titulo: "deploy prod", data: new Date(0) };
    const res = await h.history.recordRemote(h.project, ev);
    expect(res).toEqual({ path: "", created: false, ignorado: true, updated: false });
  });

  it("with []: baseline then commit and second sync creates no notes, store dev exists, cursorMs updated", async () => {
    const dir = makeRepo();
    const h = harness(dir, []);
    await h.history.sync(h.project);
    const firstState = h.store.getDev("App")!;
    expect(firstState).toBeDefined();

    commit(dir, "b", "c1");
    await h.history.sync(h.project);
    expect(h.vault.notes.size).toBe(0);
    const secondState = h.store.getDev("App")!;
    expect(secondState).toBeDefined();
    expect(secondState.cursorMs).toBeGreaterThanOrEqual(firstState.cursorMs);
  });
});

describe("stash", () => {
  it("a saved stash makes no event note and is not in the graph; pop keeps working", async () => {
    const dir = makeRepo();
    const h = harness(dir);
    await h.history.sync(h.project);
    // An old stash exists before the first commit after the baseline.
    writeFile(dir, "README.md", "alterado\n");
    sh(dir, "stash", "push", "-m", "stash de teste");
    commit(dir, "b", "commit real");
    writeFile(dir, "README.md", "outra alteração\n");
    sh(dir, "stash", "push", "-m", "segundo stash");
    const res = await h.history.sync(h.project);
    expect(res.errors).toEqual([]);
    const notes = eventNotes(h.vault, "Commit ");
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("commit real");
    for (const body of h.vault.notes.values()) {
      expect(body).not.toContain("refs/stash");
      expect(body).not.toContain("stash de teste");
      expect(body).not.toContain("index on main");
    }
    const g = await h.history.graph(h.project);
    expect(g.rows.map((r) => r.subject)).toEqual(["commit real", "commit inicial"]);
    expect(g.rows.flatMap((r) => r.refs)).not.toContain("refs/stash");
    expect(g.svg).not.toContain("stash");
    // pop still works and the next sync stays quiet.
    sh(dir, "stash", "pop");
    const after = await h.history.sync(h.project);
    expect(after.created).toEqual([]);
    expect(eventNotes(h.vault, "Commit ")).toHaveLength(1);
  });

  it("the baseline does not mark the commits of a stash either, and an old stash does not break it", async () => {
    const dir = makeRepo();
    writeFile(dir, "README.md", "alterado\n");
    sh(dir, "stash", "push", "-m", "antigo");
    const h = harness(dir);
    expect((await h.history.sync(h.project)).baseline).toBe(true);
    const g = await h.history.graph(h.project);
    expect(g.rows.map((r) => r.subject)).toEqual(["commit inicial"]);
  });
});

describe("event helpers", () => {
  it("builds the ids the AI Log Manager writes", () => {
    expect(commitId("abcdef1234567890")).toBe("commit-abcdef1234567890");
    expect(branchId("feature/x", "abcdef1234567890")).toBe("branch-feature/x-abcdef1");
    expect(pushId("origin/main", "abcdef1234567890")).toBe("push-origin/main-abcdef1");
    expect(prId("bitbucket", "ws/rp", 3)).toBe("pr-bitbucket-ws/rp-3");
  });

  it("round-trips the graph block", () => {
    const note = renderEventNote({ tipo: "commit", projeto: "App", id: "c1", titulo: "t", data: new Date(0), branch: "main", hash: "abcdef123456" }, "App - Eventos");
    const block = /```ai-git-graph\n([\s\S]*?)```/.exec(note)![1]!;
    expect(parseGraphBlock(block)).toEqual({ projeto: "App", branch: "main", hash: "abcdef123456" });
  });
});

describe("saveGraphSvg", () => {
  it("saves the svg in the project attachments folder and returns its path", async () => {
    const h = harness(undefined);
    const path = await h.history.saveGraphSvg(h.project, "<svg>1</svg>");
    expect(path).toBe("Projetos/App/Anexos/App - grafo.svg");
    expect(h.vault.notes.get(path)).toBe("<svg>1</svg>");
  });

  it("rewrites the file when called again and keeps only one svg", async () => {
    const h = harness(undefined);
    await h.history.saveGraphSvg(h.project, "<svg>1</svg>");
    const path = await h.history.saveGraphSvg(h.project, "<svg>2</svg>");
    expect(path).toBe("Projetos/App/Anexos/App - grafo.svg");
    expect(h.vault.notes.get(path)).toBe("<svg>2</svg>");
    expect([...h.vault.notes.keys()].filter((p) => p.includes(".svg"))).toHaveLength(1);
  });
});
