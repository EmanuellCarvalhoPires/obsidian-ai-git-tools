// The development projects of the vault: notes tagged dev/projeto inside the projects folder.
// The clone of each project is read from its note by the vault port (the "Clone local" line, or
// the `clone_local` property). The tracker is the ProjectLookup that the repository resolver and
// the history layer use.
import type { ProjectInfo, ProjectLookup, VaultPort } from "../ports";
import { isInside } from "../repo-resolver";
import type { Settings } from "../../types";

export interface ProjectTrackerOptions {
  /** Milliseconds the raw project list is kept. 0 or missing: no cache (every `list()` reads the vault). */
  cacheMs?: number;
  /** Clock, for tests. */
  now?: () => number;
}

export class ProjectTracker implements ProjectLookup {
  private cached: { at: number; promise: Promise<ProjectInfo[]> } | undefined;

  constructor(
    private readonly vault: Pick<VaultPort, "projects">,
    private readonly settings: () => Pick<Settings, "projectsRoot">,
    private readonly options: ProjectTrackerOptions = {},
  ) {}

  /** Drops the cached raw project list so the next `list()` reads the vault again. */
  invalidate(): void {
    this.cached = undefined;
  }

  private raw(): Promise<ProjectInfo[]> {
    const ttl = this.options.cacheMs ?? 0;
    if (ttl <= 0) return this.vault.projects();
    const now = (this.options.now ?? Date.now)();
    if (this.cached && now - this.cached.at < ttl) return this.cached.promise;
    const promise = this.vault.projects();
    this.cached = { at: now, promise };
    // A failed read must not stay cached.
    promise.catch(() => {
      if (this.cached?.promise === promise) this.cached = undefined;
    });
    return promise;
  }

  /** Projects whose note lives inside `settings.projectsRoot` (all of them when it is empty). */
  async list(): Promise<ProjectInfo[]> {
    const root = this.settings()
      .projectsRoot.replace(/\\/g, "/")
      .replace(/^\/+|\/+$/g, "");
    const all = await this.raw();
    if (root === "") return all;
    return all.filter((p) => {
      const folder = p.folder.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
      return folder === root || folder.startsWith(`${root}/`);
    });
  }

  /** Case-insensitive match by project name. */
  async byName(name: string): Promise<ProjectInfo | undefined> {
    const key = name.trim().toLowerCase();
    return (await this.list()).find((p) => p.name.toLowerCase() === key);
  }

  /** Project whose clone contains the absolute path (the path may be inside a subfolder of the clone). */
  async byClone(path: string): Promise<ProjectInfo | undefined> {
    return (await this.list()).find((p) => p.clonePath !== undefined && isInside(p.clonePath, path));
  }
}
