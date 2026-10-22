// Reads the development project notes (tag dev/projeto) through the Obsidian metadata cache. The
// Obsidian VaultPort uses it for `projects()`; the ProjectTracker filters and looks them up.
import type { CachedMetadata, TFile } from "obsidian";
import type { ProjectInfo } from "./ports";

const PROJECT_TAG = "dev/projeto";
/** The line the project notes use for the clone: **Clone local:** `C:\path`. */
const CLONE_LINE = /\*\*Clone local:\*\*\s*`([^`]+)`/;

/** The part of the Obsidian App this lookup uses (a fake in the tests). */
export interface LookupApp {
  vault: {
    getMarkdownFiles(): TFile[];
    cachedRead(file: TFile): Promise<string>;
  };
  metadataCache: {
    getFileCache(file: TFile): CachedMetadata | null;
  };
}

function normalizeTag(tag: string): string {
  return tag.trim().replace(/^#/, "").toLowerCase();
}

/** Tags of a note: frontmatter `tags` plus inline tags, without "#". */
export function tagsOf(cache: CachedMetadata): string[] {
  const out: string[] = [];
  const fm: unknown = cache.frontmatter?.tags;
  if (typeof fm === "string") out.push(...fm.split(/[\s,]+/));
  else if (Array.isArray(fm)) for (const t of fm) if (typeof t === "string") out.push(t);
  for (const t of cache.tags ?? []) out.push(t.tag);
  return out.map(normalizeTag).filter((t) => t !== "");
}

/** Clone path written in the note: the "Clone local" line, or the `clone_local` property. */
export function cloneOf(text: string, frontmatter: Record<string, unknown> | undefined): string | undefined {
  const line = CLONE_LINE.exec(text)?.[1]?.trim();
  if (line) return line;
  const prop: unknown = frontmatter?.clone_local;
  return typeof prop === "string" && prop.trim() !== "" ? prop.trim() : undefined;
}

/** Lists every note tagged dev/projeto with its clone. The clone is re-read only when the note changes. */
export function createVaultProjectLister(app: LookupApp): () => Promise<ProjectInfo[]> {
  const cloneCache = new Map<string, { mtime: number; clone: string | undefined }>();

  return async () => {
    const out: ProjectInfo[] = [];
    for (const file of app.vault.getMarkdownFiles()) {
      const cache = app.metadataCache.getFileCache(file);
      if (!cache || !tagsOf(cache).includes(PROJECT_TAG)) continue;
      const mtime = file.stat.mtime;
      let entry = cloneCache.get(file.path);
      if (!entry || entry.mtime !== mtime) {
        entry = { mtime, clone: cloneOf(await app.vault.cachedRead(file), cache.frontmatter) };
        cloneCache.set(file.path, entry);
      }
      out.push({ name: file.basename, folder: file.parent?.path ?? "", clonePath: entry.clone });
    }
    return out;
  };
}
