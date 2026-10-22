// VaultPort on top of the Obsidian API.
import { FileSystemAdapter, normalizePath } from "obsidian";
import type { App, TFile } from "obsidian";
import { createVaultProjectLister } from "../core/project-lookup";
import type { ProjectInfo, VaultPort } from "../core/ports";

export class ObsidianVaultPort implements VaultPort {
  private readonly listProjects: () => Promise<ProjectInfo[]>;

  constructor(private readonly app: App) {
    this.listProjects = createVaultProjectLister(app);
  }

  rootPath(): string {
    const adapter = this.app.vault.adapter;
    return adapter instanceof FileSystemAdapter ? adapter.getBasePath() : "";
  }

  exists(path: string): boolean {
    return this.app.vault.getFileByPath(normalizePath(path)) !== null;
  }

  async read(path: string): Promise<string> {
    return this.app.vault.read(this.file(path));
  }

  async create(path: string, content: string): Promise<void> {
    const clean = normalizePath(path);
    const dir = clean.includes("/") ? clean.slice(0, clean.lastIndexOf("/")) : "";
    if (dir) await this.ensureFolder(dir);
    await this.app.vault.create(clean, content);
  }

  async process(path: string, fn: (content: string) => string): Promise<void> {
    await this.app.vault.process(this.file(path), fn);
  }

  async updateFrontmatter(path: string, fn: (frontmatter: Record<string, unknown>) => void): Promise<void> {
    await this.app.fileManager.processFrontMatter(this.file(path), (fm: Record<string, unknown>) => fn(fm));
  }

  async ensureFolder(path: string): Promise<void> {
    const parts = normalizePath(path).split("/");
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      if (!this.app.vault.getFolderByPath(current)) {
        try {
          await this.app.vault.createFolder(current);
        } catch {
          // Created by someone else between the check and the call.
        }
      }
    }
  }

  findNoteByProperty(folder: string, key: string, value: string): string | undefined {
    const prefix = `${normalizePath(folder).replace(/\/+$/, "")}/`;
    for (const file of this.app.vault.getMarkdownFiles()) {
      if (!file.path.startsWith(prefix)) continue;
      const found: unknown = this.app.metadataCache.getFileCache(file)?.frontmatter?.[key];
      if (typeof found === "string" && found.trim() === value) return file.path;
    }
    return undefined;
  }

  projects(): Promise<ProjectInfo[]> {
    return this.listProjects();
  }

  private file(path: string): TFile {
    const file = this.app.vault.getFileByPath(normalizePath(path));
    if (!file) throw new Error(`Note not found: ${path}`);
    return file;
  }
}
