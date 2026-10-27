import { describe, expect, it } from "vitest";
import { CheckpointStore, createFileStorage, normalizeCheckpointFile, pruneDevEvents } from "../../src/core/history/checkpoints";
import type { CheckpointFile, FileAdapter } from "../../src/core/history/checkpoints";

function fakeAdapter(initial?: string): FileAdapter & { files: Map<string, string> } {
  const files = new Map<string, string>();
  if (initial !== undefined) files.set("p/checkpoints.json", initial);
  return {
    files,
    exists: async (p) => files.has(p),
    read: async (p) => files.get(p) ?? "",
    write: async (p, d) => void files.set(p, d),
  };
}

describe("checkpoints", () => {
  it("normalizes garbage to an empty file", () => {
    expect(normalizeCheckpointFile(undefined)).toEqual({ version: 1, dev: {}, devEvents: {} });
    expect(normalizeCheckpointFile({ dev: [], devEvents: "x" })).toEqual({ version: 1, dev: {}, devEvents: {} });
  });

  it("saves and reloads the state through the file storage", async () => {
    const adapter = fakeAdapter();
    const store = await CheckpointStore.open(createFileStorage(adapter, "p/checkpoints.json"));
    store.setDev("App", { cursorMs: 5, tips: { "origin/main": "abc" }, branches: ["main"], prStates: {} });
    store.setEventNote("commit-1", "Projetos/App/Eventos/x.md");
    await store.flush();
    const saved = JSON.parse(adapter.files.get("p/checkpoints.json")!) as CheckpointFile;
    expect(saved.version).toBe(1);
    const reopened = await CheckpointStore.open(createFileStorage(adapter, "p/checkpoints.json"));
    expect(reopened.getDev("App")?.cursorMs).toBe(5);
    expect(reopened.eventNote("commit-1")).toBe("Projetos/App/Eventos/x.md");
  });

  it("reads a corrupt or missing file as empty", async () => {
    expect((await CheckpointStore.open(createFileStorage(fakeAdapter("{not json"), "p/checkpoints.json"))).getDev("App")).toBeUndefined();
    expect((await CheckpointStore.open(createFileStorage(fakeAdapter(), "p/checkpoints.json"))).eventNote("x")).toBeUndefined();
  });

  it("writes by itself shortly after a change", async () => {
    const adapter = fakeAdapter();
    const store = await CheckpointStore.open(createFileStorage(adapter, "p/checkpoints.json"));
    store.setEventNote("a", "b");
    await new Promise((r) => setTimeout(r, 700));
    expect(adapter.files.get("p/checkpoints.json")).toContain('"a":"b"');
  });

  it("pruneDevEvents keeps newest max commit and push entries and preserves other entries", () => {
    const events: Record<string, string> = {};
    for (let i = 0; i < 250; i++) {
      events[`commit-${i}`] = i === 10 ? "-" : `Projetos/App/Eventos/Commit ${i}.md`;
      if (i === 5) events["pr-github-o/r-1"] = "Projetos/App/Eventos/PR 1.md";
      if (i === 100) events["pr-github-o/r-2"] = "Projetos/App/Eventos/PR 2.md";
      if (i === 200) events["pr-github-o/r-3"] = "Projetos/App/Eventos/PR 3.md";
    }
    const pruned = pruneDevEvents(events);
    const commitKeys = Object.keys(pruned).filter((k) => k.startsWith("commit-"));
    expect(commitKeys).toHaveLength(200);
    expect(commitKeys[0]).toBe("commit-50");
    expect(commitKeys[199]).toBe("commit-249");
    expect(pruned["commit-0"]).toBeUndefined();
    expect(pruned["commit-10"]).toBeUndefined();
    expect(pruned["commit-50"]).toBe("Projetos/App/Eventos/Commit 50.md");
    expect(pruned["pr-github-o/r-1"]).toBe("Projetos/App/Eventos/PR 1.md");
    expect(pruned["pr-github-o/r-2"]).toBe("Projetos/App/Eventos/PR 2.md");
    expect(pruned["pr-github-o/r-3"]).toBe("Projetos/App/Eventos/PR 3.md");
  });

  it("pruneDevEvents does not prune when volatile entries do not exceed max", () => {
    const events: Record<string, string> = {};
    for (let i = 0; i < 100; i++) events[`commit-${i}`] = `c/${i}`;
    for (let i = 0; i < 100; i++) events[`push-${i}`] = `p/${i}`;
    const result = pruneDevEvents(events, 200);
    expect(result).toBe(events);
  });

  it("CheckpointStore prunes on flush and persists pruned entries", async () => {
    const adapter = fakeAdapter();
    const store = await CheckpointStore.open(createFileStorage(adapter, "p/checkpoints.json"));
    for (let i = 0; i < 250; i++) store.setEventNote(`commit-${i}`, "x");
    store.setEventNote("pr-a", "y");
    await store.flush();

    const saved = JSON.parse(adapter.files.get("p/checkpoints.json")!) as CheckpointFile;
    const commitKeys = Object.keys(saved.devEvents).filter((k) => k.startsWith("commit-"));
    expect(commitKeys).toHaveLength(200);
    expect(saved.devEvents["pr-a"]).toBe("y");

    const reopened = await CheckpointStore.open(createFileStorage(adapter, "p/checkpoints.json"));
    expect(reopened.eventNote("commit-0")).toBeUndefined();
    expect(reopened.eventNote("commit-249")).toBe("x");
  });
});
