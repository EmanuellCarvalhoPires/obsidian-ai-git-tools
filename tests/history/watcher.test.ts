// The watcher of the reflogs: debounce, lifecycle and containment of errors with a fake folder
// watcher and fake timers, plus a short test with a real repository and the real fs.watch (what the
// user does in the terminal becomes a note, once).
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createNodeGit } from "../../src/core/git-runner";
import { CheckpointStore } from "../../src/core/history/checkpoints";
import { HistoryService } from "../../src/core/history/history-service";
import { Recorder } from "../../src/core/history/recorder";
import { HistoryWatcher, RECONCILE_INTERVAL_MS, WATCH_DEBOUNCE_MS, defaultLogsFolder } from "../../src/core/history/watcher";
import type { FolderHandle, FolderWatchFn } from "../../src/core/history/watcher";
import type { ProjectInfo } from "../../src/core/ports";
import { buildGitTools } from "../../src/tools/git-tools";
import { cleanupTemp, makeRepo, sh, writeFile } from "../helpers/git-repos";
import { MemoryVault } from "../helpers/memory-ports";
import { callTool, dataOf, makeDeps } from "../helpers/tool-deps";

afterAll(cleanupTemp);

interface FakeFolder {
  folder: string;
  emit(name: string): void;
  fail(err: Error): void;
  closed: boolean;
}

function fakeWatch(): { watchFolder: FolderWatchFn; folders: FakeFolder[] } {
  const folders: FakeFolder[] = [];
  const watchFolder: FolderWatchFn = (folder, onEvent, onError) => {
    const f: FakeFolder = { folder, emit: onEvent, fail: onError, closed: false };
    folders.push(f);
    const handle: FolderHandle = {
      close: () => {
        f.closed = true;
      },
    };
    return handle;
  };
  return { watchFolder, folders };
}

const project = (name: string, clonePath: string | undefined): ProjectInfo => ({ name, folder: `Projetos/${name}`, clonePath });

describe("with a fake folder watcher and fake timers", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function setup(initial: ProjectInfo[], over: { logs?: (clone: string) => string | undefined; sync?: (p: ProjectInfo) => Promise<unknown> } = {}) {
    const projects = { current: initial };
    const syncs: string[] = [];
    const { watchFolder, folders } = fakeWatch();
    const log = vi.fn();
    const watcher = new HistoryWatcher({
      history: {
        sync: async (p) => {
          syncs.push(p.name);
          if (over.sync) await over.sync(p);
          return { project: p.name, baseline: false, created: [], errors: [] };
        },
      },
      projects: { list: async () => projects.current },
      watchFolder,
      logsFolder: over.logs ?? ((clone) => `${clone}/.git/logs`),
      log,
    });
    return { watcher, projects, syncs, folders, log };
  }

  it("syncs every project once when it starts and watches the reflogs of the ones with a clone", async () => {
    const t = setup([project("A", "C:/a"), project("B", "C:/b"), project("Sem", undefined)]);
    await t.watcher.start();
    expect(t.syncs.sort()).toEqual(["A", "B"]);
    expect(t.folders.map((f) => f.folder).sort()).toEqual(["C:/a/.git/logs", "C:/b/.git/logs"]);
    expect(t.watcher.watchedProjects().sort()).toEqual(["A", "B"]);
    t.watcher.stop();
  });

  it("waits for the quiet time and syncs once, however many changes come", async () => {
    const t = setup([project("A", "C:/a")]);
    await t.watcher.start();
    t.syncs.length = 0;
    const folder = t.folders[0]!;
    folder.emit("HEAD");
    await vi.advanceTimersByTimeAsync(1000);
    folder.emit("refs/heads/main");
    await vi.advanceTimersByTimeAsync(1000);
    folder.emit("HEAD");
    // 1000 ms after the last change: still quiet time (the default is 1500 ms)
    await vi.advanceTimersByTimeAsync(WATCH_DEBOUNCE_MS - 1);
    expect(t.syncs).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(t.syncs).toEqual(["A"]);
    t.watcher.stop();
  });

  it("ignores lock files", async () => {
    const t = setup([project("A", "C:/a")]);
    await t.watcher.start();
    t.syncs.length = 0;
    t.folders[0]!.emit("refs/heads/main.lock");
    await vi.advanceTimersByTimeAsync(WATCH_DEBOUNCE_MS * 2);
    expect(t.syncs).toEqual([]);
    t.watcher.stop();
  });

  it("ignores a change only in the reflog of the stash", async () => {
    const t = setup([project("A", "C:/a")]);
    await t.watcher.start();
    t.syncs.length = 0;
    t.folders[0]!.emit("refs/stash");
    t.folders[0]!.emit("refs\\stash");
    await vi.advanceTimersByTimeAsync(WATCH_DEBOUNCE_MS * 2);
    expect(t.syncs).toEqual([]);
    t.folders[0]!.emit("refs/heads/main");
    await vi.advanceTimersByTimeAsync(WATCH_DEBOUNCE_MS * 2);
    expect(t.syncs).toEqual(["A"]);
    t.watcher.stop();
  });

  it("a change during a sync causes one more sync afterwards, never two at once", async () => {
    const gates: Array<() => void> = [];
    let running = 0;
    let max = 0;
    const flush = async (): Promise<void> => {
      for (let i = 0; i < 5; i++) await vi.advanceTimersByTimeAsync(0);
    };
    const t = setup([project("A", "C:/a")], {
      sync: async () => {
        running++;
        max = Math.max(max, running);
        await new Promise<void>((resolve) => gates.push(resolve));
        running--;
      },
    });
    const started = t.watcher.start();
    await flush();
    gates.shift()?.(); // the sync of the start
    await started;
    t.syncs.length = 0;

    t.folders[0]!.emit("HEAD");
    await vi.advanceTimersByTimeAsync(WATCH_DEBOUNCE_MS);
    await flush();
    expect(t.syncs).toEqual(["A"]);
    t.folders[0]!.emit("HEAD"); // arrives while the first sync is still running
    await vi.advanceTimersByTimeAsync(WATCH_DEBOUNCE_MS);
    await flush();
    expect(t.syncs).toEqual(["A"]);
    gates.shift()?.();
    await flush();
    expect(t.syncs).toEqual(["A", "A"]);
    gates.shift()?.();
    await flush();
    expect(t.syncs).toEqual(["A", "A"]);
    expect(max).toBe(1);
    t.watcher.stop();
  });

  it("stop closes the watchers and cancels what was waiting", async () => {
    const t = setup([project("A", "C:/a")]);
    await t.watcher.start();
    t.syncs.length = 0;
    t.folders[0]!.emit("HEAD");
    t.watcher.stop();
    expect(t.folders[0]!.closed).toBe(true);
    expect(t.watcher.active).toBe(false);
    await vi.advanceTimersByTimeAsync(WATCH_DEBOUNCE_MS * 2 + RECONCILE_INTERVAL_MS);
    expect(t.syncs).toEqual([]);
  });

  it("start is idempotent", async () => {
    const t = setup([project("A", "C:/a")]);
    await t.watcher.start();
    await t.watcher.start();
    expect(t.folders).toHaveLength(1);
    expect(t.syncs).toEqual(["A"]);
    t.watcher.stop();
  });

  it("follows the list of projects: a new project is watched and synced, a removed one is dropped, a new clone replaces the old watcher", async () => {
    const t = setup([project("A", "C:/a")]);
    await t.watcher.start();
    t.projects.current = [project("A", "C:/a2"), project("B", "C:/b")];
    await vi.advanceTimersByTimeAsync(RECONCILE_INTERVAL_MS);
    expect(t.watcher.watchedProjects().sort()).toEqual(["A", "B"]);
    expect(t.folders.find((f) => f.folder === "C:/a/.git/logs")?.closed).toBe(true);
    expect(t.folders.find((f) => f.folder === "C:/a2/.git/logs")?.closed).toBe(false);
    expect(t.syncs.filter((n) => n === "B")).toEqual(["B"]);
    t.projects.current = [project("B", "C:/b")];
    await vi.advanceTimersByTimeAsync(RECONCILE_INTERVAL_MS);
    expect(t.watcher.watchedProjects()).toEqual(["B"]);
    expect(t.folders.find((f) => f.folder === "C:/a2/.git/logs")?.closed).toBe(true);
    t.watcher.stop();
  });

  it("a clone without a reflogs folder yet is synced once and watched as soon as the folder exists", async () => {
    let exists = false;
    const t = setup([project("A", "C:/a")], { logs: (clone) => (exists ? `${clone}/.git/logs` : undefined) });
    await t.watcher.start();
    expect(t.syncs).toEqual(["A"]);
    expect(t.folders).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(RECONCILE_INTERVAL_MS);
    expect(t.syncs).toEqual(["A"]); // not synced again while there is nothing to watch
    exists = true;
    await vi.advanceTimersByTimeAsync(RECONCILE_INTERVAL_MS);
    expect(t.folders).toHaveLength(1);
    expect(t.syncs).toEqual(["A", "A"]);
    t.watcher.stop();
  });

  it("contains errors: a watcher that cannot start, a watcher that dies, a sync that fails, a project list that fails", async () => {
    const log = vi.fn();
    const failing: FolderWatchFn = () => {
      throw new Error("sem inotify");
    };
    const watcher = new HistoryWatcher({
      history: { sync: async () => Promise.reject(new Error("git quebrou")) },
      projects: { list: async () => [project("A", "C:/a")] },
      watchFolder: failing,
      logsFolder: (c) => `${c}/.git/logs`,
      log,
    });
    await expect(watcher.start()).resolves.toBeUndefined();
    expect(watcher.watchedProjects()).toEqual([]);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("could not watch A"), expect.any(Error));
    expect(log).toHaveBeenCalledWith(expect.stringContaining("sync of A failed"), expect.any(Error));
    watcher.stop();

    const t = setup([project("A", "C:/a")]);
    await t.watcher.start();
    t.folders[0]!.fail(new Error("morreu"));
    expect(t.watcher.watchedProjects()).toEqual([]);
    await vi.advanceTimersByTimeAsync(RECONCILE_INTERVAL_MS);
    expect(t.watcher.watchedProjects()).toEqual(["A"]); // watched again
    t.watcher.stop();

    const broken = new HistoryWatcher({
      history: { sync: async () => ({ project: "A", baseline: false, created: [], errors: [] }) },
      projects: { list: async () => Promise.reject(new Error("sem projetos")) },
      watchFolder: fakeWatch().watchFolder,
      log,
    });
    await expect(broken.start()).resolves.toBeUndefined();
    broken.stop();
  });

  it("defaultLogsFolder finds .git/logs, and nothing for a missing folder", () => {
    const repo = makeRepo();
    expect(defaultLogsFolder(repo)?.replace(/\\/g, "/")).toMatch(/\/repo\/\.git\/logs$/);
    expect(defaultLogsFolder(`${repo}-nao-existe`)).toBeUndefined();
  });
});

describe("with a real repository and the real fs.watch", () => {
  async function until(check: () => boolean, ms = 6000): Promise<boolean> {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (check()) return true;
      await new Promise((r) => setTimeout(r, 50));
    }
    return check();
  }

  it("a commit made in the terminal becomes a note, and a commit made by a tool is not written twice", async () => {
    const repo = makeRepo();
    const vault = new MemoryVault();
    const store = new CheckpointStore({ load: async () => undefined, save: async () => undefined });
    const real = createNodeGit();
    const history = new HistoryService(real, vault, store, () => ({ eventsFolder: "Eventos" }));
    const info: ProjectInfo = { name: "App", folder: "Projetos/App", clonePath: repo };
    const lookup = { list: async () => [info], byName: async () => info, byClone: async () => info };
    const watcher = new HistoryWatcher({ history, projects: lookup, debounceMs: 150, log: () => undefined });
    const commitNotes = (): string[] => [...vault.notes.keys()].filter((p) => p.includes("/Eventos/Commit "));

    await watcher.start();
    expect(history.hasBaseline(info)).toBe(true);
    expect(vault.notes.size).toBe(0); // baseline only
    expect(watcher.watchedProjects()).toEqual(["App"]);

    // 1) the terminal
    writeFile(repo, "t.txt", "terminal\n");
    sh(repo, "add", ".");
    sh(repo, "commit", "-q", "-m", "feito no terminal");
    expect(await until(() => commitNotes().length === 1)).toBe(true);
    expect(commitNotes()[0]).toContain("feito no terminal");

    // 2) a tool; the watcher sees its reflog change and must not write it again
    const tools = buildGitTools(makeDeps({ projects: [{ name: "App", clone: repo }], recorder: new Recorder({ history, projects: lookup, git: real }) }));
    writeFile(repo, "u.txt", "tool\n");
    await callTool(tools, "git_add", { repo, todos: true });
    const res = await callTool(tools, "git_commit", { repo, mensagem: "feito pela tool" });
    expect(dataOf(res).nota).toBeDefined();
    expect(commitNotes()).toHaveLength(2);
    await new Promise((r) => setTimeout(r, 700)); // more than the debounce: the watcher has run
    expect(commitNotes()).toHaveLength(2);

    watcher.stop();
    // after stop, the terminal is not seen
    writeFile(repo, "v.txt", "depois\n");
    sh(repo, "add", ".");
    sh(repo, "commit", "-q", "-m", "depois de parar");
    await new Promise((r) => setTimeout(r, 600));
    expect(commitNotes()).toHaveLength(2);
  });
});
