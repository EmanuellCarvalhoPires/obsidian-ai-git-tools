// The development projects of the vault: notes tagged dev/projeto inside the projects folder.
// The clone of each project is read from its note by the vault port (the "Clone local" line, or
// the `clone_local` property). The tracker is the ProjectLookup that the repository resolver and
// the history layer use.
import type { ProjectInfo, ProjectLookup, VaultPort } from "../ports";
import { isInside } from "../repo-resolver";
import type { Settings } from "../../types";

export class ProjectTracker implements ProjectLookup {
  constructor(
    private readonly vault: Pick<VaultPort, "projects">,
    private readonly settings: () => Pick<Settings, "projectsRoot">,
  ) {}

  /** Projects whose note lives inside `settings.projectsRoot` (all of them when it is empty). */
  async list(): Promise<ProjectInfo[]> {
    const root = this.settings()
      .projectsRoot.replace(/\\/g, "/")
      .replace(/^\/+|\/+$/g, "");
    const all = await this.vault.projects();
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
