// In-memory VaultPort for the history tests.
import { eventIdOf } from "../../src/core/history/events";
import type { ProjectInfo, VaultPort } from "../../src/core/ports";

export class MemoryVault implements VaultPort {
  notes = new Map<string, string>();
  frontmatterEdits: string[] = [];
  projectList: ProjectInfo[] = [];
  constructor(public root = "C:/Cofre") {}
  rootPath(): string {
    return this.root;
  }
  exists(path: string): boolean {
    return this.notes.has(path);
  }
  async read(path: string): Promise<string> {
    const n = this.notes.get(path);
    if (n === undefined) throw new Error(`no note ${path}`);
    return n;
  }
  async create(path: string, content: string): Promise<void> {
    if (this.notes.has(path)) throw new Error(`exists ${path}`);
    this.notes.set(path, content);
  }
  async process(path: string, fn: (c: string) => string): Promise<void> {
    this.notes.set(path, fn(await this.read(path)));
  }
  async updateFrontmatter(path: string, fn: (fm: Record<string, unknown>) => void): Promise<void> {
    await this.read(path);
    const fm: Record<string, unknown> = {};
    fn(fm);
    this.frontmatterEdits.push(JSON.stringify(fm));
  }
  async ensureFolder(): Promise<void> {}
  findNoteByProperty(folder: string, key: string, value: string): string | undefined {
    for (const [path, content] of this.notes) {
      if (!path.startsWith(`${folder}/`)) continue;
      if (key === "evento_id" && eventIdOf(content) === value) return path;
    }
    return undefined;
  }
  async projects(): Promise<ProjectInfo[]> {
    return this.projectList;
  }
}
