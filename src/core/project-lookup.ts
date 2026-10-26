// Reads the development project notes (tag dev/projeto) through the Obsidian metadata cache. The
// Obsidian VaultPort uses it for `projects()`; the ProjectTracker filters and looks them up.
import type { CachedMetadata, TFile } from "obsidian";
import type { ProjectInfo } from "./ports";

const PROJECT_TAG = "dev/projeto";
/** The line the project notes use for the clone: **Clone local:** `C:\path`. */
const CLONE_LINE = /\*\*Clone local:\*\*\s*`([^`]+)`/;

const REPO_FRONTMATTER_KEYS = [
  "clone_local",
  "repositorio",
  "repositorio_url",
  "hospedagem",
  "epico",
  "epico_url",
  "branch_producao",
  "branch_integracao",
];

const NON_PROJECT_SUBFOLDERS = new Set([
  "branches",
  "eventos",
  "logs",
  "changelogs",
  "arquivo",
  "legado",
  "anexos",
  "docs",
]);

/** Extracts the immediate parent folder name of a file safely. */
export function parentFolderName(file: TFile): string {
  const name = file.parent?.name?.trim();
  if (name) return name;
  const path = (file.parent?.path ?? "").replace(/\\/g, "/").trim();
  if (!path) return "";
  const parts = path.split("/").filter(Boolean);
  return parts.pop() ?? "";
}

/** Checks whether the note contains explicit repository properties in frontmatter or text. */
export function hasRepoProperties(text: string, frontmatter: Record<string, unknown> | undefined): boolean {
  if (frontmatter) {
    for (const key of REPO_FRONTMATTER_KEYS) {
      const val = frontmatter[key];
      if (typeof val === "string" && val.trim() !== "") return true;
    }
  }
  return CLONE_LINE.test(text);
}

/**
 * Validates if a note tagged dev/projeto represents a true development project root note,
 * preventing secondary documents (e.g. test plans, benchmark reports, meeting notes, legacy notes)
 * located inside project folders from being falsely recognized as independent projects.
 */
export function isCandidateProjectNote(file: TFile, cache: CachedMetadata, text: string): boolean {
  const parentName = parentFolderName(file);
  const parentNameLower = parentName.toLowerCase();
  const basename = file.basename.trim();
  const basenameLower = basename.toLowerCase();

  const hasProps = hasRepoProperties(text, cache.frontmatter);

  // Subfolders of project internals (branches, logs, legacy, etc.) without explicit repo props are not projects
  if (NON_PROJECT_SUBFOLDERS.has(parentNameLower) && !hasProps) {
    return false;
  }

  // Vault convention: the primary project note shares the exact name with its folder (Projetos/<Project>/<Project>.md)
  if (parentNameLower !== "" && basenameLower === parentNameLower) {
    return true;
  }

  // Notes with explicit repo/clone properties are always recognized
  if (hasProps) {
    return true;
  }

  // Notes placed directly in the top-level projects folder (Projetos/<Project>.md)
  if (parentNameLower === "projetos") {
    return true;
  }

  return false;
}

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
  const cloneCache = new Map<string, { mtime: number; clone: string | undefined; isProject: boolean }>();

  return async () => {
    const out: ProjectInfo[] = [];
    for (const file of app.vault.getMarkdownFiles()) {
      const cache = app.metadataCache.getFileCache(file);
      if (!cache || !tagsOf(cache).includes(PROJECT_TAG)) continue;
      const mtime = file.stat.mtime;
      let entry = cloneCache.get(file.path);
      if (!entry || entry.mtime !== mtime) {
        const text = await app.vault.cachedRead(file);
        const isProject = isCandidateProjectNote(file, cache, text);
        entry = { mtime, clone: cloneOf(text, cache.frontmatter), isProject };
        cloneCache.set(file.path, entry);
      }
      if (!entry.isProject) continue;
      out.push({ name: file.basename, folder: file.parent?.path ?? "", clonePath: entry.clone });
    }
    return out;
  };
}
