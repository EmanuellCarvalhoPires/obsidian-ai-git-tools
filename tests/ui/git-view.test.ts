import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setMockLanguage } from "../mocks/obsidian";
import type { WorkspaceLeaf } from "obsidian";
import type AiGitToolsPlugin from "../../src/main";
import type { ProjectInfo } from "../../src/core/ports";
import type { GitProvider, PrInfo } from "../../src/core/providers/provider";
import { RemoteError } from "../../src/core/providers/errors";
import { DEFAULT_SETTINGS } from "../../src/types";
import { GIT_VIEW_TYPE, GitToolsView, registerGitView } from "../../src/ui/git-view";
import { fakeApp } from "./fakes";
import type { FakeNote } from "./fakes";

// The graph block draws SVG through the DOM; the test stands in for it and checks how the screen calls it.
vi.mock("../../src/ui/graph-block", () => ({
  renderGraphInto: async (
    el: { empty(): void; createDiv(o: unknown): unknown },
    deps: { projects: { byName(n: string): Promise<ProjectInfo | undefined> }; history: { graph(p: ProjectInfo, o: { width?: number }): Promise<{ svg: string; rows: unknown[] }> } },
    opts: { projeto?: string; width?: number },
  ): Promise<boolean> => {
    el.empty();
    const project = await deps.projects.byName(opts.projeto ?? "");
    if (!project?.clonePath) {
      el.createDiv({ cls: "aigt-empty aigt-muted", text: "no clone" });
      return false;
    }
    const g = await deps.history.graph(project, { width: opts.width });
    el.createDiv({ cls: "aigt-graph", text: g.svg });
    return true;
  },
}));

// ---------------------------------------------------------------- helpers over the mock DOM

interface Node {
  children: Node[];
  textContent: string;
  hasClass(c: string): boolean;
  dataset: Record<string, string>;
  attrs: Record<string, string>;
  dispatchEvent(e: { type: string; [k: string]: unknown }): void;
}

const walk = (n: Node): Node[] => [n, ...n.children.flatMap(walk)];
const byClass = (root: Node, cls: string): Node[] => walk(root).filter((n) => n.hasClass(cls));
const allText = (root: Node): string =>
  walk(root)
    .map((n) => n.textContent)
    .join("\n");
const click = (n: Node): void => n.dispatchEvent({ type: "click" });
const flush = async (): Promise<void> => {
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
};

const PROJECT_A: ProjectInfo = { name: "Alfa", folder: "Projetos/Alfa", clonePath: "C:/repos/alfa" };
const PROJECT_B: ProjectInfo = { name: "Beta", folder: "Projetos/Beta", clonePath: undefined };

const event = (path: string, evento: string, data: string, branch = "main"): FakeNote => ({ path, frontmatter: { evento, data, branch } });

interface Setup {
  view: GitToolsView;
  plugin: AiGitToolsPlugin;
  root: Node;
  graph: ReturnType<typeof vi.fn>;
  saveData: ReturnType<typeof vi.fn>;
  openLinkText: ReturnType<typeof vi.fn>;
  providerFor: ReturnType<typeof vi.fn>;
  git: ReturnType<typeof vi.fn>;
}

async function setup(
  opts: {
    projects?: ProjectInfo[];
    notes?: FakeNote[];
    settings?: Partial<typeof DEFAULT_SETTINGS>;
    provider?: Partial<GitProvider> | undefined;
    remoteUrl?: string | undefined;
  } = {},
): Promise<Setup> {
  const projects = opts.projects ?? [PROJECT_A, PROJECT_B];
  const graph = vi.fn(async () => ({ svg: "<svg>grafo</svg>", rows: [{}], lanes: 1 }));
  const saveData = vi.fn(async () => undefined);
  const plugin = {
    settings: { ...DEFAULT_SETTINGS, ...opts.settings },
    projects: { list: async () => projects, byName: async (n: string) => projects.find((p) => p.name === n) },
    history: { eventsFolder: (p: ProjectInfo) => `${p.folder}/Eventos`, graph },
    getSecrets: () => undefined,
    providerHttp: vi.fn(),
    saveSettings: saveData,
    registerView: vi.fn(),
  } as unknown as AiGitToolsPlugin;
  const openLinkText = vi.fn(async () => undefined);
  const app = {
    ...fakeApp(opts.notes ?? []),
    workspace: { openLinkText },
  };
  Object.assign(app.metadataCache, { on: () => ({}) });
  Object.assign(app.vault, { on: () => ({}) });
  const remoteUrl = "remoteUrl" in opts ? opts.remoteUrl : "git@github.com:o/alfa.git";
  const git = vi.fn(async (_cwd: string, args: string[]) => {
    if (remoteUrl === undefined) return "";
    return args[0] === "remote" && args[1] === "get-url" ? `${remoteUrl}\n` : "origin\n";
  });
  const providerFor = vi.fn(async () => ("provider" in opts ? (opts.provider as GitProvider | undefined) : undefined));
  const view = new GitToolsView({ app } as unknown as WorkspaceLeaf, plugin, { git, providerFor });
  await view.onOpen();
  await flush();
  return { view, plugin, root: view.contentEl as unknown as Node, graph, saveData, openLinkText, providerFor, git };
}

const projectRow = (root: Node, name: string): Node => {
  const row = byClass(root, "aigt-project").find((r) => allText(r).includes(name));
  if (!row) throw new Error(`project row ${name} not found`);
  return row;
};
const tabButton = (root: Node, label: string): Node => {
  const tab = byClass(root, "aigt-tab").find((t) => allText(t).includes(label));
  if (!tab) throw new Error(`tab ${label} not found`);
  return tab;
};

beforeEach(() => setMockLanguage("en"));
afterEach(() => setMockLanguage("en"));

describe("GitToolsView: identity and registration", () => {
  it("has the view type, the icon and a title", async () => {
    const { view } = await setup();
    expect(GIT_VIEW_TYPE).toBe("ai-git-tools-view");
    expect(view.getViewType()).toBe("ai-git-tools-view");
    expect(view.getIcon()).toBe("git-branch");
    expect(view.getDisplayText()).toBe("AI Git Tools");
  });

  it("registerGitView registers the view factory on the plugin", async () => {
    const { plugin, view } = await setup();
    registerGitView(plugin);
    const register = plugin.registerView as unknown as ReturnType<typeof vi.fn>;
    expect(register).toHaveBeenCalledTimes(1);
    expect(register.mock.calls[0]?.[0]).toBe("ai-git-tools-view");
    expect(typeof register.mock.calls[0]?.[1]).toBe("function");
    expect(view).toBeInstanceOf(GitToolsView);
  });
});

describe("GitToolsView: projects", () => {
  it("shows an explaining empty state when there are no projects", async () => {
    const { root } = await setup({ projects: [] });
    expect(byClass(root, "aigt-project")).toHaveLength(0);
    expect(allText(root)).toContain("tagged dev/projeto");
    expect(allText(root)).toContain("Projetos");
  });

  it("lists the projects, sorted, and flags the one without a clone", async () => {
    const { root } = await setup({ projects: [PROJECT_B, PROJECT_A] });
    const rows = byClass(root, "aigt-project");
    expect(rows.map((r) => byClass(r, "aigt-project-name")[0]?.textContent)).toEqual(["Alfa", "Beta"]);
    expect(allText(rows[1] as Node)).toContain("No local clone");
    expect(allText(rows[0] as Node)).not.toContain("No local clone");
    expect(byClass(rows[0] as Node, "aigt-project-icon")[0]?.dataset.icon).toBe("folder-git-2");
    expect(byClass(rows[1] as Node, "aigt-project-icon")[0]?.dataset.icon).toBe("folder-x");
  });

  it("asks to pick a project while none is selected", async () => {
    const { root, graph } = await setup();
    expect(allText(root)).toContain("Pick a project");
    expect(byClass(root, "aigt-graph-block")).toHaveLength(0);
    expect(graph).not.toHaveBeenCalled();
  });

  it("selecting a project shows the graph on top, the three tabs, and remembers the choice", async () => {
    const { root, graph, saveData, plugin } = await setup();
    click(projectRow(root, "Alfa"));
    await flush();
    const card = byClass(root, "aigt-graph-card")[0] as Node;
    expect(card).toBeDefined();
    expect(byClass(card, "aigt-graph-block")).toHaveLength(1);
    expect(byClass(card, "aigt-graph")).toHaveLength(1);
    expect(graph).toHaveBeenCalledTimes(1);
    expect(graph.mock.calls[0]?.[0]).toMatchObject({ name: "Alfa" });
    // The graph comes before the tabs in the main area.
    const main = byClass(root, "aigt-main")[0] as Node;
    expect(main.children[0]).toBe(card);
    expect(byClass(main, "aigt-tabs")[0]).toBe(main.children[1]);
    expect(byClass(root, "aigt-tab").map((t) => allText(t).trim())).toEqual(["Events", "Project logs", "Pull requests"]);
    expect(plugin.settings.lastProject).toBe("Alfa");
    expect(saveData).toHaveBeenCalledTimes(1);
    expect(byClass(root, "aigt-project").filter((r) => r.hasClass("is-active"))).toHaveLength(1);
  });

  it("restores the last project", async () => {
    const { root, graph } = await setup({ settings: { lastProject: "Alfa" } });
    expect(byClass(root, "aigt-graph-card")).toHaveLength(1);
    expect(graph).toHaveBeenCalledTimes(1);
  });

  it("ignores a last project that no longer exists", async () => {
    const { root } = await setup({ settings: { lastProject: "Sumiu" } });
    expect(allText(root)).toContain("Pick a project");
  });

  it("explains a project without clone in the graph area", async () => {
    const { root, graph } = await setup({ settings: { lastProject: "Beta" } });
    expect(allText(byClass(root, "aigt-graph-block")[0] as Node)).toContain("no clone");
    expect(graph).not.toHaveBeenCalled();
  });

  it("the refresh button draws the graph again", async () => {
    const { root, graph } = await setup({ settings: { lastProject: "Alfa" } });
    click(byClass(root, "aigt-refresh")[0] as Node);
    await flush();
    expect(graph).toHaveBeenCalledTimes(2);
  });
});

describe("GitToolsView: events tab", () => {
  const notes: FakeNote[] = [
    event("Projetos/Alfa/Eventos/Commit abc1234 - Primeiro.md", "commit", "2026-10-20T10:00:00.000Z", "main"),
    event("Projetos/Alfa/Eventos/Push main - def5678.md", "push", "2026-10-22T10:00:00.000Z", "main"),
    event("Projetos/Alfa/Eventos/Branch feature-x.md", "branch", "2026-10-21T10:00:00.000Z", "feature/x"),
    event("Projetos/Beta/Eventos/Commit zzz9999 - Outro projeto.md", "commit", "2026-10-22T11:00:00.000Z"),
    { path: "Projetos/Alfa/Alfa.md", frontmatter: {} },
  ];

  it("lists the notes of the events folder of the project, newest first, with type, branch and date", async () => {
    const { root } = await setup({ settings: { lastProject: "Alfa" }, notes });
    const rows = byClass(root, "aigt-row");
    expect(rows.map((r) => byClass(r, "aigt-row-title")[0]?.textContent)).toEqual(["Push main - def5678", "Branch feature-x", "Commit abc1234 - Primeiro"]);
    const meta = allText(byClass(rows[1] as Node, "aigt-row-meta")[0] as Node);
    expect(meta).toContain("Branch");
    expect(meta).toContain("feature/x");
    expect(byClass(rows[0] as Node, "aigt-row-icon")[0]?.dataset.icon).toBe("upload");
    expect(byClass(rows[2] as Node, "aigt-row-icon")[0]?.dataset.icon).toBe("git-commit-horizontal");
  });

  it("opens the note on click", async () => {
    const { root, openLinkText } = await setup({ settings: { lastProject: "Alfa" }, notes });
    click(byClass(root, "aigt-row")[0] as Node);
    expect(openLinkText).toHaveBeenCalledWith("Projetos/Alfa/Eventos/Push main - def5678.md", "", false);
  });

  it("opens the note with Enter and ignores other keys (keyboard)", async () => {
    const { root, openLinkText } = await setup({ settings: { lastProject: "Alfa" }, notes });
    const row = byClass(root, "aigt-row")[0] as Node;
    row.dispatchEvent({ type: "keydown", key: "Enter", preventDefault: () => undefined });
    row.dispatchEvent({ type: "keydown", key: "x", preventDefault: () => undefined });
    expect(openLinkText).toHaveBeenCalledTimes(1);
    expect(row.attrs.role).toBe("button");
    expect(row.attrs.tabindex).toBe("0");
  });

  it("shows an empty state when the project has no events", async () => {
    const { root } = await setup({ settings: { lastProject: "Beta" }, notes: [] });
    expect(allText(root)).toContain("No event recorded");
  });
});

describe("GitToolsView: project logs tab", () => {
  const notes: FakeNote[] = [
    { path: "Knowledge/Logs/21-10-2026 - 12h00 - Meu log.md", frontmatter: { tags: ["log", "claude", "sessao/ativo"], projeto: "[[Alfa]]" } },
    { path: "Knowledge/Logs/20-10-2026 - 09h00 - Velho.md", frontmatter: { tags: ["log", "sessao/arquivado"], projeto: "[[Alfa]]" } },
    { path: "Knowledge/Logs/21-10-2026 - 13h00 - De outro.md", frontmatter: { tags: ["log"], projeto: "[[Beta]]" } },
  ];

  it("lists the logs linked to the project and opens one on click", async () => {
    const { root, openLinkText } = await setup({ settings: { lastProject: "Alfa" }, notes });
    click(tabButton(root, "Project logs"));
    const rows = byClass(root, "aigt-row");
    expect(rows.map((r) => byClass(r, "aigt-row-title")[0]?.textContent)).toEqual(["Meu log", "Velho"]);
    expect(allText(rows[0] as Node)).toContain("Active");
    expect(allText(rows[1] as Node)).toContain("Archived");
    click(rows[0] as Node);
    expect(openLinkText).toHaveBeenCalledWith("Knowledge/Logs/21-10-2026 - 12h00 - Meu log.md", "", false);
    expect(tabButton(root, "Project logs").hasClass("is-active")).toBe(true);
    expect(tabButton(root, "Events").hasClass("is-active")).toBe(false);
  });

  it("explains an empty list", async () => {
    const { root } = await setup({ settings: { lastProject: "Alfa" }, notes: [] });
    click(tabButton(root, "Project logs"));
    expect(allText(root)).toContain("No conversation log is linked");
  });
});

describe("GitToolsView: pull requests tab", () => {
  const pr = (n: number, estado: PrInfo["estado"], url = `https://github.com/o/alfa/pull/${n}`): PrInfo => ({
    numero: n,
    titulo: `Titulo ${n}`,
    estado,
    origem: `feature/${n}`,
    destino: "develop",
    url,
    autor: "ana",
    criadoEm: "2026-10-20T10:00:00.000Z",
  });

  it("explains how to configure the secret when none is chosen", async () => {
    const { root, providerFor } = await setup({ settings: { lastProject: "Alfa" } });
    click(tabButton(root, "Pull requests"));
    await flush();
    expect(allText(root)).toContain("No GitHub secret is chosen");
    expect(allText(root)).toContain("configurar-ai-git-tools");
    expect(providerFor).not.toHaveBeenCalled();
  });

  it("names Bitbucket for a Bitbucket remote", async () => {
    const { root } = await setup({ settings: { lastProject: "Alfa" }, remoteUrl: "https://bitbucket.org/ws/alfa.git" });
    click(tabButton(root, "Pull requests"));
    await flush();
    expect(allText(root)).toContain("No Bitbucket secret is chosen");
  });

  it("checks the secret of the provider of the remote, not another one", async () => {
    const { root, providerFor } = await setup({ settings: { lastProject: "Alfa", secretBitbucket: "BB" } });
    click(tabButton(root, "Pull requests"));
    await flush();
    expect(allText(root)).toContain("No GitHub secret is chosen");
    expect(providerFor).not.toHaveBeenCalled();
  });

  it("lists the pull requests as links when a secret is chosen", async () => {
    const listarPrs = vi.fn(async () => ({ itens: [pr(2, "aberto"), pr(1, "mesclado", "javascript:alert(1)")], truncado: false }));
    const { root, providerFor } = await setup({ settings: { lastProject: "Alfa", secretGithub: "GH" }, provider: { listarPrs } });
    click(tabButton(root, "Pull requests"));
    await flush();
    expect(providerFor).toHaveBeenCalledWith(expect.objectContaining({ provider: "github", repo: "o/alfa" }));
    expect(listarPrs).toHaveBeenCalledWith({ estado: "todos", limite: 30 });
    const rows = byClass(root, "aigt-row");
    expect(rows).toHaveLength(2);
    expect(allText(rows[0] as Node)).toContain("#2 Titulo 2");
    expect(allText(rows[0] as Node)).toContain("feature/2 to develop");
    expect(allText(rows[0] as Node)).toContain("Open");
    expect((rows[0] as Node).attrs.href).toBe("https://github.com/o/alfa/pull/2");
    expect((rows[0] as Node).attrs.target).toBe("_blank");
    expect(byClass(rows[1] as Node, "aigt-row-icon")[0]?.dataset.icon).toBe("git-merge");
    // A link that is not https is never turned into an anchor.
    expect((rows[1] as Node).attrs.href).toBeUndefined();
  });

  it("notes when the list was cut", async () => {
    const listarPrs = vi.fn(async () => ({ itens: [pr(1, "aberto")], truncado: true }));
    const { root } = await setup({ settings: { lastProject: "Alfa", secretGithub: "GH" }, provider: { listarPrs } });
    click(tabButton(root, "Pull requests"));
    await flush();
    expect(allText(root)).toContain("Showing the 1 newest pull requests.");
  });

  it("shows the empty state of the repository", async () => {
    const listarPrs = vi.fn(async () => ({ itens: [], truncado: false }));
    const { root } = await setup({ settings: { lastProject: "Alfa", secretGithub: "GH" }, provider: { listarPrs } });
    click(tabButton(root, "Pull requests"));
    await flush();
    expect(allText(root)).toContain("No pull request found in o/alfa.");
  });

  it("shows the provider error with its message", async () => {
    const listarPrs = vi.fn(async () => {
      throw new RemoteError("provedor_http_401", "Credencial recusada pelo GitHub.", { status: 401 });
    });
    const { root } = await setup({ settings: { lastProject: "Alfa", secretGithub: "GH" }, provider: { listarPrs } });
    click(tabButton(root, "Pull requests"));
    await flush();
    expect(allText(root)).toContain("Could not read the pull requests: Credencial recusada pelo GitHub.");
  });

  it("says when the secrets of Environment Keys cannot be reached", async () => {
    const { root } = await setup({ settings: { lastProject: "Alfa", secretGithub: "GH" }, provider: undefined });
    click(tabButton(root, "Pull requests"));
    await flush();
    expect(allText(root)).toContain("Could not reach the secrets of Environment Keys");
  });

  it("says when the clone has no GitHub or Bitbucket remote", async () => {
    const { root } = await setup({ settings: { lastProject: "Alfa", secretGithub: "GH" }, remoteUrl: "C:/outro/bare.git" });
    click(tabButton(root, "Pull requests"));
    await flush();
    expect(allText(root)).toContain("no GitHub or Bitbucket remote");
  });

  it("says when the project has no clone", async () => {
    const { root, git } = await setup({ settings: { lastProject: "Beta" } });
    click(tabButton(root, "Pull requests"));
    await flush();
    expect(allText(root)).toContain("no local clone, so its remote repository is unknown");
    expect(git).not.toHaveBeenCalled();
  });
});

describe("GitToolsView: language and icons", () => {
  it("uses Portuguese when the Obsidian language is Portuguese", async () => {
    setMockLanguage("pt-BR");
    const { root } = await setup({ settings: { lastProject: "Alfa" } });
    expect(byClass(root, "aigt-tab").map((t) => allText(t).trim())).toEqual(["Eventos", "Logs do projeto", "PRs"]);
  });

  it("has no emoji in any text, and the icons come from setIcon", async () => {
    for (const language of ["en", "pt"]) {
      setMockLanguage(language);
      const { root } = await setup({
        settings: { lastProject: "Alfa" },
        notes: [event("Projetos/Alfa/Eventos/Commit abc1234 - X.md", "commit", "2026-10-20T10:00:00.000Z")],
      });
      for (const label of ["Project logs", "Logs do projeto", "Pull requests", "PRs"]) {
        const tab = byClass(root, "aigt-tab").find((t) => allText(t).includes(label));
        if (tab) click(tab);
        await flush();
        expect(allText(root)).not.toMatch(/\p{Extended_Pictographic}/u);
      }
      const icons = walk(root).filter((n) => n.dataset.icon !== undefined);
      expect(icons.length).toBeGreaterThan(5);
      for (const n of icons) expect(n.dataset.icon).toMatch(/^[a-z0-9-]+$/);
    }
  });
});
