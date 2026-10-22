import { describe, expect, it, vi } from "vitest";
import AiGitToolsPlugin from "../../src/main";
import { DEFAULT_SETTINGS } from "../../src/types";
import type { ProjectInfo } from "../../src/core/ports";

function makePlugin(workspace: unknown = {}): any {
  return new AiGitToolsPlugin({ workspace } as never, { id: "ai-git-tools", version: "0.1.0" } as never);
}

describe("activateView", () => {
  it("reveals the leaf that already shows the screen", async () => {
    const leaf = { setViewState: vi.fn() };
    const workspace = { getLeavesOfType: vi.fn(() => [leaf]), getLeaf: vi.fn(), revealLeaf: vi.fn(async () => undefined) };
    await makePlugin(workspace).activateView();
    expect(workspace.getLeavesOfType).toHaveBeenCalledWith("ai-git-tools-view");
    expect(workspace.getLeaf).not.toHaveBeenCalled();
    expect(leaf.setViewState).not.toHaveBeenCalled();
    expect(workspace.revealLeaf).toHaveBeenCalledWith(leaf);
  });

  it("opens a new tab with the screen when there is none", async () => {
    const leaf = { setViewState: vi.fn(async () => undefined) };
    const workspace = { getLeavesOfType: vi.fn(() => []), getLeaf: vi.fn(() => leaf), revealLeaf: vi.fn(async () => undefined) };
    await makePlugin(workspace).activateView();
    expect(workspace.getLeaf).toHaveBeenCalledWith("tab");
    expect(leaf.setViewState).toHaveBeenCalledWith({ type: "ai-git-tools-view", active: true });
    expect(workspace.revealLeaf).toHaveBeenCalledWith(leaf);
  });
});

describe("refreshAutomation", () => {
  function automation(over: Partial<typeof DEFAULT_SETTINGS> = {}) {
    const p = makePlugin();
    p.api = {};
    p.settings = { ...DEFAULT_SETTINGS, ...over };
    let active = false;
    p.watcher = { start: vi.fn(async () => undefined), stop: vi.fn() };
    p.remoteSync = {
      get active() {
        return active;
      },
      start: vi.fn(() => {
        active = true;
      }),
      stop: vi.fn(() => {
        active = false;
      }),
    };
    return p;
  }

  it("starts the watcher and the polling, and does not restart the polling when nothing changed", () => {
    const p = automation();
    p.refreshAutomation();
    p.refreshAutomation();
    expect(p.watcher.start).toHaveBeenCalledTimes(2);
    expect(p.remoteSync.start).toHaveBeenCalledTimes(1);
  });

  it("restarts the polling only when the interval changes, and stops it when turned off", () => {
    const p = automation();
    p.refreshAutomation();
    p.settings.remoteIntervalMin = 30;
    p.refreshAutomation();
    expect(p.remoteSync.start).toHaveBeenCalledTimes(2);
    p.settings.remotePolling = false;
    p.refreshAutomation();
    expect(p.remoteSync.active).toBe(false);
  });

  it("stops the watcher when watch is off", () => {
    const p = automation({ watch: false });
    p.refreshAutomation();
    expect(p.watcher.start).not.toHaveBeenCalled();
    expect(p.watcher.stop).toHaveBeenCalled();
  });
});

describe("syncAllProjects and lastProjects", () => {
  const project = (name: string, clonePath?: string): ProjectInfo => ({ name, folder: `Projetos/${name}`, clonePath });

  it("syncs the projects with a usable clone and sums the result", async () => {
    const p = makePlugin();
    const list = [project("A", "C:/a"), project("B"), project("C", "C:/c"), project("D", "C:/d")];
    p.projects = { list: vi.fn(async () => list) };
    p.history = {
      repoOf: vi.fn(async (x: ProjectInfo) => (x.name === "D" ? undefined : x.clonePath)),
      sync: vi.fn(async (x: ProjectInfo) =>
        x.name === "A" ? { project: "A", baseline: true, created: [], errors: [] } : { project: "C", baseline: false, created: ["n1", "n2"], errors: ["e"] },
      ),
    };
    expect(await p.syncAllProjects()).toEqual({ projects: 2, created: 2, baselines: 1, errors: 1 });
    expect(p.history.sync).toHaveBeenCalledTimes(2);
    expect(p.lastProjects).toBe(list);
  });

  it("keeps the previous list when listing fails", async () => {
    const p = makePlugin();
    const debug = vi.spyOn(console, "debug").mockImplementation(() => undefined);
    p.lastProjects = [project("A")];
    p.projects = { list: vi.fn(async () => Promise.reject(new Error("x"))) };
    expect(await p.refreshProjects()).toEqual([project("A")]);
    debug.mockRestore();
  });
});
