// Watches the reflogs of the project clones, so what the user does in the terminal (commit, push,
// checkout, merge...) becomes event notes too. Every change of `<clone>/.git/logs` (the reflogs of
// HEAD and of every ref) re-runs `HistoryService.sync` for that project after a quiet time. The sync
// is incremental and idempotent, so a commit already written by a tool is not written again.
//
// Desktop only (fs.watch). Everything that can go wrong (no clone, no logs folder yet, a watcher
// that dies) is contained: the plugin never breaks because of a watcher.
import * as fs from "node:fs";
import * as path from "node:path";
import type { ProjectInfo, ProjectLookup } from "../ports";
import type { HistoryService } from "./history-service";

/** Quiet time between the last change of a reflog and the sync (milliseconds). */
export const WATCH_DEBOUNCE_MS = 1500;
/** How often the set of watched projects is checked against the list of projects (milliseconds). */
export const RECONCILE_INTERVAL_MS = 30_000;

export interface FolderHandle {
  close(): void;
}

/** Watches a folder recursively; `onEvent` receives the relative file name of each change. Throws when it cannot watch. */
export type FolderWatchFn = (folder: string, onEvent: (name: string) => void, onError: (err: Error) => void) => FolderHandle;

export interface HistoryWatcherDeps {
  history: Pick<HistoryService, "sync">;
  projects: Pick<ProjectLookup, "list">;
  /** Default: node `fs.watch`, recursive. Tests inject a fake. */
  watchFolder?: FolderWatchFn;
  /** Absolute folder of the reflogs of a clone, or undefined when there is none yet. Default: `<clone>/.git/logs`. */
  logsFolder?: (clonePath: string) => string | undefined;
  debounceMs?: number;
  reconcileMs?: number;
  /** Diagnostics (default: console.debug). */
  log?: (message: string, err?: unknown) => void;
}

interface Watched {
  project: ProjectInfo;
  clone: string;
  handle: FolderHandle;
  timer: number | undefined;
  running: boolean;
  dirty: boolean;
}

export const nodeWatchFolder: FolderWatchFn = (folder, onEvent, onError) => {
  const watcher = fs.watch(folder, { recursive: true, persistent: false }, (_event, filename) => {
    const name = typeof filename === "string" ? filename : filename ? String(filename) : "";
    if (name !== "") onEvent(name);
  });
  watcher.on("error", onError);
  return { close: () => watcher.close() };
};

/** `<clone>/.git/logs`; follows `.git` files (`gitdir: ...`) of worktrees and submodules. Undefined when it does not exist. */
export function defaultLogsFolder(clonePath: string): string | undefined {
  try {
    const dotGit = path.join(clonePath, ".git");
    const stat = fs.statSync(dotGit);
    let gitDir = dotGit;
    if (stat.isFile()) {
      const target = /^gitdir:\s*(.+?)\s*$/m.exec(fs.readFileSync(dotGit, "utf8"))?.[1];
      if (!target) return undefined;
      gitDir = path.resolve(clonePath, target);
    }
    const logs = path.join(gitDir, "logs");
    return fs.statSync(logs).isDirectory() ? logs : undefined;
  } catch {
    return undefined;
  }
}

const defaultLog = (message: string, err?: unknown): void => {
  console.debug(`[AI Git Tools] ${message}`, err ?? "");
};

export class HistoryWatcher {
  private readonly watched = new Map<string, Watched>();
  /** Projects whose first sync ran although the clone has no reflogs folder to watch yet (retried at every reconcile). */
  private readonly unwatchable = new Set<string>();
  private reconcileTimer: number | undefined;
  private running = false;
  private reconciling: Promise<void> | undefined;

  constructor(private readonly deps: HistoryWatcherDeps) {}

  get active(): boolean {
    return this.running;
  }

  /** Projects (by name) that have a watcher right now. */
  watchedProjects(): string[] {
    return [...this.watched.keys()];
  }

  /**
   * Starts watching: every project with a clone is watched and synced once (what happened while
   * Obsidian was closed is rebuilt from the git log; the first sync of a project only stores the
   * baseline). The set of projects is checked again every `reconcileMs`. Idempotent.
   */
  start(): Promise<void> {
    if (!this.running) {
      this.running = true;
      this.reconcileTimer = window.setInterval(() => void this.reconcile(), this.deps.reconcileMs ?? RECONCILE_INTERVAL_MS);
    }
    return this.reconcile();
  }

  /** Stops every watcher and timer. Idempotent. */
  stop(): void {
    this.running = false;
    if (this.reconcileTimer !== undefined) window.clearInterval(this.reconcileTimer);
    this.reconcileTimer = undefined;
    for (const name of [...this.watched.keys()]) this.detach(name);
  }

  /**
   * Brings the watchers in line with the projects of the vault: watches the new ones (and syncs them
   * once), drops the ones that left or whose clone changed. Calls that overlap share one run.
   */
  reconcile(): Promise<void> {
    if (!this.running) return Promise.resolve();
    this.reconciling ??= this.reconcileNow().finally(() => {
      this.reconciling = undefined;
    });
    return this.reconciling;
  }

  /** Runs a sync of a project right away (also used by the quiet-time timer). Runs never overlap per project; changes during a run cause one more. */
  async syncNow(project: ProjectInfo): Promise<void> {
    const w = this.watched.get(project.name);
    if (w?.running) {
      w.dirty = true;
      return;
    }
    if (w) w.running = true;
    try {
      const res = await this.deps.history.sync(project);
      for (const e of res.errors) this.log(`sync of ${project.name}: ${e}`);
    } catch (err) {
      this.log(`sync of ${project.name} failed`, err);
    } finally {
      if (w) {
        w.running = false;
        if (w.dirty && this.running && this.watched.get(project.name) === w) {
          w.dirty = false;
          void this.syncNow(project);
        }
      }
    }
  }

  // ---------------------------------------------------------------- internals

  private log(message: string, err?: unknown): void {
    (this.deps.log ?? defaultLog)(message, err);
  }

  private async reconcileNow(): Promise<void> {
    let projects: ProjectInfo[];
    try {
      projects = await this.deps.projects.list();
    } catch (err) {
      this.log("could not list the projects", err);
      return;
    }
    if (!this.running) return;
    const wanted = new Map<string, ProjectInfo>();
    for (const p of projects) if (p.clonePath) wanted.set(p.name, p);

    for (const [name, w] of [...this.watched]) {
      const now = wanted.get(name);
      if (now?.clonePath !== w.clone) this.detach(name);
      else w.project = now;
    }

    const syncs: Promise<void>[] = [];
    for (const [name, project] of wanted) {
      if (this.watched.has(name)) continue;
      // The first sync also covers the time Obsidian was closed, so it runs for projects without a logs folder too.
      if (this.attach(project)) syncs.push(this.syncNow(project));
      else if (!this.unwatchable.has(name)) {
        this.unwatchable.add(name);
        syncs.push(this.syncNow(project));
      }
    }
    for (const name of [...this.unwatchable]) if (!wanted.has(name)) this.unwatchable.delete(name);
    await Promise.all(syncs);
  }

  /** Starts the folder watcher of a project. False when there is nothing to watch (yet). */
  private attach(project: ProjectInfo): boolean {
    const clone = project.clonePath;
    if (!clone) return false;
    const folder = (this.deps.logsFolder ?? defaultLogsFolder)(clone);
    if (folder === undefined) return false;
    try {
      const w: Watched = { project, clone, handle: { close: () => undefined }, timer: undefined, running: false, dirty: false };
      w.handle = (this.deps.watchFolder ?? nodeWatchFolder)(
        folder,
        (name) => this.onChange(w, name),
        (err) => {
          this.log(`watcher of ${project.name} stopped`, err);
          // Dropped, so the next reconcile watches it again.
          if (this.watched.get(project.name) === w) this.detach(project.name);
        },
      );
      this.watched.set(project.name, w);
      this.unwatchable.delete(project.name);
      return true;
    } catch (err) {
      this.log(`could not watch ${project.name}`, err);
      return false;
    }
  }

  private onChange(w: Watched, name: string): void {
    const project = w.project;
    // Lock files come and go during every git command; the real change follows.
    if (name.endsWith(".lock")) return;
    // A stash is not part of the history; the reflog of `refs/stash` alone needs no sync.
    if (/^refs[\\/]stash$/.test(name)) return;
    if (!this.running || this.watched.get(project.name) !== w) return;
    if (w.timer !== undefined) window.clearTimeout(w.timer);
    w.timer = window.setTimeout(() => {
      w.timer = undefined;
      void this.syncNow(w.project);
    }, this.deps.debounceMs ?? WATCH_DEBOUNCE_MS);
  }

  private detach(name: string): void {
    const w = this.watched.get(name);
    if (!w) return;
    this.watched.delete(name);
    if (w.timer !== undefined) window.clearTimeout(w.timer);
    try {
      w.handle.close();
    } catch {
      // already closed
    }
  }
}
