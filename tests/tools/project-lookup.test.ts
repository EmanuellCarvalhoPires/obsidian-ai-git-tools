import { describe, expect, it } from "vitest";
import type { CachedMetadata, TFile } from "obsidian";
import { ProjectTracker } from "../../src/core/history/project-tracker";
import { cloneOf, createVaultProjectLister, tagsOf } from "../../src/core/project-lookup";
import type { LookupApp } from "../../src/core/project-lookup";

/** The tracker over the metadata cache, as the plugin builds it. */
function createVaultProjectLookup(app: LookupApp, projectsRoot: () => string): ProjectTracker {
  return new ProjectTracker({ projects: createVaultProjectLister(app) }, () => ({ projectsRoot: projectsRoot() }));
}

interface FakeNote {
  path: string;
  tags?: string[];
  inline?: string[];
  text: string;
  frontmatter?: Record<string, unknown>;
  mtime?: number;
}

function fakeApp(notes: FakeNote[]): LookupApp & { reads: number } {
  const files = notes.map((n) => ({
    path: n.path,
    basename: n.path.split("/").pop()?.replace(/\.md$/, "") ?? "",
    parent: { path: n.path.split("/").slice(0, -1).join("/") },
    stat: { mtime: n.mtime ?? 1 },
  })) as unknown as TFile[];
  const app = {
    reads: 0,
    vault: {
      getMarkdownFiles: () => files,
      cachedRead: (file: TFile) => {
        app.reads++;
        return Promise.resolve(notes.find((n) => n.path === file.path)?.text ?? "");
      },
    },
    metadataCache: {
      getFileCache: (file: TFile) => {
        const n = notes.find((x) => x.path === file.path);
        if (!n) return null;
        return { frontmatter: { ...(n.tags ? { tags: n.tags } : {}), ...n.frontmatter }, tags: (n.inline ?? []).map((tag) => ({ tag })) } as unknown as CachedMetadata;
      },
    },
  };
  return app;
}

describe("tagsOf", () => {
  it("junta tags do frontmatter (lista ou texto) e inline, sem #", () => {
    expect(tagsOf({ frontmatter: { tags: ["dev/projeto", "#x"] }, tags: [{ tag: "#y" }] } as unknown as CachedMetadata)).toEqual(["dev/projeto", "x", "y"]);
    expect(tagsOf({ frontmatter: { tags: "a, b" } } as unknown as CachedMetadata)).toEqual(["a", "b"]);
    expect(tagsOf({} as CachedMetadata)).toEqual([]);
  });
});

describe("cloneOf", () => {
  it("lê a linha Clone local ou a propriedade clone_local", () => {
    expect(cloneOf("- **Clone local:** `C:\\Users\\X\\repo`\n", undefined)).toBe("C:\\Users\\X\\repo");
    expect(cloneOf("sem linha", { clone_local: "D:\\r" })).toBe("D:\\r");
    expect(cloneOf("sem linha", {})).toBeUndefined();
  });
});

describe("createVaultProjectLookup", () => {
  const notes: FakeNote[] = [
    { path: "Projetos/Alpha/Alpha.md", tags: ["dev/projeto"], text: "- **Clone local:** `C:\\clones\\alpha`" },
    { path: "Projetos/Beta/Beta.md", tags: ["dev/projeto"], text: "sem clone" },
    { path: "Projetos/Gama/Gama.md", tags: ["outra"], text: "- **Clone local:** `C:\\clones\\gama`" },
    { path: "Outro/Delta.md", tags: ["dev/projeto"], text: "- **Clone local:** `C:\\clones\\delta`" },
  ];

  it("lista só notas com a tag dentro de projectsRoot", async () => {
    const lookup = createVaultProjectLookup(fakeApp(notes), () => "Projetos");
    const list = await lookup.list();
    expect(list).toEqual([
      { name: "Alpha", folder: "Projetos/Alpha", clonePath: "C:\\clones\\alpha" },
      { name: "Beta", folder: "Projetos/Beta", clonePath: undefined },
    ]);
  });

  it("byName ignora maiúsculas e byClone acha o projeto pelo caminho", async () => {
    const lookup = createVaultProjectLookup(fakeApp(notes), () => "Projetos/");
    expect((await lookup.byName("alpha"))?.clonePath).toBe("C:\\clones\\alpha");
    expect(await lookup.byName("Gama")).toBeUndefined();
    expect((await lookup.byClone("C:\\clones\\alpha\\src\\x.ts"))?.name).toBe("Alpha");
    expect(await lookup.byClone("C:\\clones\\outro")).toBeUndefined();
  });

  it("não relê a nota enquanto o mtime não muda", async () => {
    const app = fakeApp(notes);
    const lookup = createVaultProjectLookup(app, () => "Projetos");
    await lookup.list();
    const first = app.reads;
    await lookup.list();
    expect(app.reads).toBe(first);
  });
});
