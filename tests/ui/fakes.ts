// Fake notes and a fake App (vault + metadata cache) for the screen tests.
import type { CachedMetadata, TFile } from "obsidian";

export interface FakeNote {
  path: string;
  frontmatter?: Record<string, unknown>;
  tags?: string[];
  headings?: Array<{ level: number; heading: string }>;
  ctime?: number;
  mtime?: number;
}

export function fakeFile(note: FakeNote): TFile {
  const name = note.path.split("/").pop() ?? note.path;
  return {
    path: note.path,
    name,
    basename: name.replace(/\.md$/, ""),
    extension: "md",
    stat: { ctime: note.ctime ?? 1000, mtime: note.mtime ?? 1000, size: 0 },
    parent: null,
  } as unknown as TFile;
}

/** Vault and metadata cache over a list of notes. */
export function fakeApp(notes: FakeNote[]): {
  vault: { getMarkdownFiles(): TFile[] };
  metadataCache: { getFileCache(file: TFile): CachedMetadata | null };
} {
  const files = notes.map(fakeFile);
  const byPath = new Map(notes.map((n) => [n.path, n]));
  return {
    vault: { getMarkdownFiles: () => files },
    metadataCache: {
      getFileCache: (file) => {
        const n = byPath.get(file.path);
        if (!n) return null;
        return {
          ...(n.frontmatter ? { frontmatter: n.frontmatter } : {}),
          ...(n.tags ? { tags: n.tags.map((tag) => ({ tag, position: {} })) } : {}),
          ...(n.headings ? { headings: n.headings } : {}),
        } as unknown as CachedMetadata;
      },
    },
  };
}
