import { describe, expect, it } from "vitest";
import { CheckpointStore, createFileStorage, normalizeCheckpointFile } from "../../src/core/history/checkpoints";
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
});
