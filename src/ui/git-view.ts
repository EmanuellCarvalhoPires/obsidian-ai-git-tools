// The screen of the module: the development projects on the left; for the chosen project, the
// repository graph on top and three tabs below (events, conversation logs, pull requests). It only
// reads: the vault (metadata cache), the repository (git log for the graph) and, for the PR tab, the
// provider of the remote (GitHub or Bitbucket) when a secret was chosen for it.
import { ItemView, Notice, debounce, getLanguage, setIcon } from "obsidian";
import type { WorkspaceLeaf } from "obsidian";
import type AiGitToolsPlugin from "../main";
import { createNodeGit } from "../core/git-runner";
import { createProviderResolver } from "../core/history/remote-sync";
import type { ProviderResolver } from "../core/history/remote-sync";
import type { GitRunner, ProjectInfo } from "../core/ports";
import { RemoteError, nomeDoProvedor } from "../core/providers/errors";
import { parseRemoteUrl } from "../core/providers/provider";
import type { PrInfo, RemoteRef } from "../core/providers/provider";
import { renderGraphInto } from "./graph-block";
import { logsDoProjeto } from "./project-logs";
import { paginate, renderPaginationControls } from "./pagination";

export const GIT_VIEW_TYPE = "ai-git-tools-view";

/** Newest items shown in the events tab. */
const EVENT_LIMIT = 200;
/** Pull requests asked of the provider. */
const PR_LIMIT = 30;
/** Quiet time before the lists follow a change in the notes (milliseconds). */
const REFRESH_DEBOUNCE_MS = 500;

type Tab = "events" | "logs" | "prs";
const TABS: Tab[] = ["events", "logs", "prs"];

// ---------------------------------------------------------------- texts

type Table = Record<string, string>;

const en: Table = {
  "title": "AI Git Tools",
  "refresh": "Refresh",
  "projects": "Projects",
  "noClone": "No local clone",
  "pickProject": "Pick a project on the list to see its repository graph, events, logs and pull requests.",
  "noProjects": "No development project found. Create a note tagged dev/projeto inside the folder {root} and write the local clone in it (the line Clone local).",
  "graph": "Repository graph",
  "loading": "Loading...",
  "tab.events": "Events",
  "tab.logs": "Project logs",
  "tab.prs": "Pull requests",
  "events.empty": "No event recorded for this project yet. Commits, pushes, branches and pull requests appear here as notes.",
  "events.type.commit": "Commit",
  "events.type.push": "Push",
  "events.type.branch": "Branch",
  "events.type.pr": "Pull request",
  "events.type.deploy": "Deploy",
  "events.type.other": "Event",
  "logs.empty": "No conversation log is linked to this project. A log appears here when its projeto property points to the project note.",
  "logs.active": "Active",
  "logs.archived": "Archived",
  "prs.noClone": "This project has no local clone, so its remote repository is unknown.",
  "prs.noRemote": "The clone has no GitHub or Bitbucket remote.",
  "prs.noSecret": "No {provider} secret is chosen. Run the skill configurar-ai-git-tools, or pick the secret in the AI Git Tools settings, to list the pull requests.",
  "prs.noService": "Could not reach the secrets of Environment Keys. Check that the plugin is active and its vault is unlocked.",
  "prs.empty": "No pull request found in {repo}.",
  "prs.failed": "Could not read the pull requests: {reason}",
  "prs.truncated": "Showing the {n} newest pull requests.",
  "prs.open": "Open",
  "prs.merged": "Merged",
  "prs.closed": "Closed",
  "prs.branches": "{from} to {to}",
  "openFailed": "Could not open the note.",
};

const pt: Table = {
  "title": "AI Git Tools",
  "refresh": "Atualizar",
  "projects": "Projetos",
  "noClone": "Sem clone local",
  "pickProject": "Escolha um projeto na lista para ver o grafo do repositório, os eventos, os logs e os PRs.",
  "noProjects": "Nenhum projeto de desenvolvimento encontrado. Crie uma nota com a tag dev/projeto dentro da pasta {root} e escreva nela o clone local (a linha Clone local).",
  "graph": "Grafo do repositório",
  "loading": "Carregando...",
  "tab.events": "Eventos",
  "tab.logs": "Logs do projeto",
  "tab.prs": "PRs",
  "events.empty": "Nenhum evento registrado para este projeto ainda. Commits, pushes, branches e PRs aparecem aqui como notas.",
  "events.type.commit": "Commit",
  "events.type.push": "Push",
  "events.type.branch": "Branch",
  "events.type.pr": "PR",
  "events.type.deploy": "Deploy",
  "events.type.other": "Evento",
  "logs.empty": "Nenhum log de conversa está ligado a este projeto. O log aparece aqui quando a propriedade projeto aponta para a nota do projeto.",
  "logs.active": "Ativo",
  "logs.archived": "Arquivado",
  "prs.noClone": "Este projeto não tem clone local, então o repositório remoto é desconhecido.",
  "prs.noRemote": "O clone não tem remoto do GitHub nem do Bitbucket.",
  "prs.noSecret": "Nenhuma secret do {provider} foi escolhida. Rode a skill configurar-ai-git-tools, ou escolha a secret nas configurações do AI Git Tools, para listar os PRs.",
  "prs.noService": "Não foi possível acessar as secrets do Environment Keys. Confira se o plugin está ativo e se o cofre dele está desbloqueado.",
  "prs.empty": "Nenhum PR encontrado em {repo}.",
  "prs.failed": "Não foi possível ler os PRs: {reason}",
  "prs.truncated": "Mostrando os {n} PRs mais recentes.",
  "prs.open": "Aberto",
  "prs.merged": "Mesclado",
  "prs.closed": "Fechado",
  "prs.branches": "{from} para {to}",
  "openFailed": "Não foi possível abrir a nota.",
};

/** Text of the screen in the language of the Obsidian interface (same rule as the rest of the plugin). */
function tr(key: string, vars?: Record<string, string | number>): string {
  const table = getLanguage().toLowerCase().startsWith("pt") ? pt : en;
  let text = table[key] ?? en[key] ?? key;
  if (vars) for (const [k, v] of Object.entries(vars)) text = text.split(`{${k}}`).join(String(v));
  return text;
}

// ---------------------------------------------------------------- services

/** What the screen needs besides the plugin. Tests replace them. */
export interface GitViewServices {
  git: GitRunner;
  providerFor: ProviderResolver;
}

/** The remote of a clone (`origin`, or the first one) when it is on GitHub or Bitbucket. */
async function remoteOf(git: GitRunner, clone: string): Promise<RemoteRef | undefined> {
  try {
    const names = (await git(clone, ["remote"]))
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter((s) => s !== "");
    const name = names.includes("origin") ? "origin" : names[0];
    if (!name) return undefined;
    return parseRemoteUrl((await git(clone, ["remote", "get-url", name])).trim());
  } catch {
    return undefined;
  }
}

const reasonOf = (err: unknown): string => {
  if (err instanceof RemoteError) return typeof err.dica === "string" ? `${err.mensagem} (${err.dica})` : err.mensagem;
  return err instanceof Error ? err.message : String(err);
};

// ---------------------------------------------------------------- rows

interface EventRow {
  path: string;
  titulo: string;
  tipo: string;
  branch: string;
  data: number;
}

const EVENT_ICON: Record<string, string> = {
  commit: "git-commit-horizontal",
  push: "upload",
  branch: "git-branch",
  pr: "git-pull-request",
  deploy: "rocket",
};

const TAB_ICON: Record<Tab, string> = { events: "list", logs: "scroll-text", prs: "git-pull-request" };

const text = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/** Makes an element behave as a button: click, Enter and Space. */
function activate(el: HTMLElement, run: () => void): void {
  el.setAttribute("role", "button");
  el.setAttribute("tabindex", "0");
  el.addEventListener("click", run);
  el.addEventListener("keydown", (e: KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      run();
    }
  });
}

const dateLabel = (ms: number): string => (Number.isFinite(ms) ? new Date(ms).toLocaleString() : "");

export class GitToolsView extends ItemView {
  private readonly services: GitViewServices;
  private projects: ProjectInfo[] = [];
  private selected: string | undefined;
  private tab: Tab = "events";
  private graphSeq = 0;
  private graphTail: Promise<void> = Promise.resolve();
  private prSeq = 0;
  private eventsPage = 1;
  private logsPage = 1;

  private projectsEl!: HTMLElement;
  private mainEl!: HTMLElement;
  private graphEl!: HTMLElement;
  private tabsEl!: HTMLElement;
  private panelEl!: HTMLElement;
  private readonly requestRefresh = debounce(() => void this.refreshLists(), REFRESH_DEBOUNCE_MS, true);

  constructor(
    leaf: WorkspaceLeaf,
    private readonly plugin: AiGitToolsPlugin,
    services: Partial<GitViewServices> = {},
  ) {
    super(leaf);
    this.services = {
      git: services.git ?? createNodeGit(),
      providerFor:
        services.providerFor ??
        createProviderResolver({ settings: () => this.plugin.settings, getSecrets: this.plugin.getSecrets, http: this.plugin.providerHttp }),
    };
  }

  getViewType(): string {
    return GIT_VIEW_TYPE;
  }

  getDisplayText(): string {
    return tr("title");
  }

  getIcon(): string {
    return "git-branch";
  }

  async onOpen(): Promise<void> {
    const root = this.contentEl;
    root.empty();
    root.addClass("aigt-view");

    const bar = root.createDiv({ cls: "aigt-toolbar" });
    const refresh = bar.createEl("button", { cls: "clickable-icon aigt-refresh", attr: { "aria-label": tr("refresh") } });
    setIcon(refresh, "refresh-cw");
    refresh.addEventListener("click", () => void this.refreshAll());

    const body = root.createDiv({ cls: "aigt-body" });
    const side = body.createEl("nav", { cls: "aigt-projects", attr: { "aria-label": tr("projects") } });
    this.projectsEl = side.createDiv({ cls: "aigt-project-list" });
    this.mainEl = body.createDiv({ cls: "aigt-main" });

    this.registerEvent(
      this.app.metadataCache.on("changed", (file) => {
        const project = this.current();
        if (project && file.path.startsWith(`${this.plugin.history.eventsFolder(project)}/`)) {
          void this.drawGraph(project);
          if (this.tab === "events") this.renderPanel(project);
          return;
        }
        // Only refresh project list if a note inside projectsRoot changed
        if (file.path.startsWith(this.plugin.settings.projectsRoot)) {
          this.requestRefresh();
        } else if (this.tab === "logs") {
          // If a log changed, refresh only the panel
          if (project) this.renderPanel(project);
        }
      }),
    );
    this.registerEvent(this.app.metadataCache.on("resolved", () => this.requestRefresh()));
    this.registerEvent(this.app.vault.on("delete", () => this.requestRefresh()));
    this.registerEvent(this.app.vault.on("rename", () => this.requestRefresh()));

    await this.loadProjects();
    const last = this.plugin.settings.lastProject;
    if (last !== "" && this.projects.some((p) => p.name === last)) this.selected = last;
    this.renderProjects();
    this.renderMain();
  }

  onClose(): Promise<void> {
    this.requestRefresh.cancel();
    this.graphSeq++;
    this.prSeq++;
    return Promise.resolve();
  }

  /** Chooses a project (the list does it on click). The choice is remembered in the settings. */
  select(name: string): void {
    if (!this.projects.some((p) => p.name === name)) return;
    this.selected = name;
    this.remember(name);
    this.tab = "events";
    this.eventsPage = 1;
    this.logsPage = 1;
    this.renderProjects();
    this.renderMain();
  }

  // ---------------------------------------------------------------- data

  private current(): ProjectInfo | undefined {
    return this.projects.find((p) => p.name === this.selected);
  }

  private async loadProjects(): Promise<void> {
    try {
      this.projects = (await this.plugin.projects.list()).sort((a, b) => a.name.localeCompare(b.name));
    } catch (err) {
      console.debug("[AI Git Tools] could not list the projects", err);
      this.projects = [];
    }
    if (this.selected !== undefined && !this.projects.some((p) => p.name === this.selected)) this.selected = undefined;
  }

  private remember(name: string): void {
    this.plugin.settings.lastProject = name;
    // The settings file is the one of the plugin; a failure to save only loses the memory of the choice.
    void this.plugin.saveSettings().catch((err: unknown) => console.debug("[AI Git Tools] could not save the last project", err));
  }

  /** Refresh button: the projects, the graph and the active tab. */
  private async refreshAll(): Promise<void> {
    await this.loadProjects();
    this.renderProjects();
    this.renderMain();
  }

  /** Follows a change of the notes: the project list and the tab lists (the graph is drawn again only by `refreshAll` and by new event notes). */
  private async refreshLists(): Promise<void> {
    await this.loadProjects();
    this.renderProjects();
    const project = this.current();
    if (!project) {
      this.renderMain();
      return;
    }
    if (this.tab !== "prs") this.renderPanel(project);
  }

  // ---------------------------------------------------------------- projects list

  private renderProjects(): void {
    this.projectsEl.empty();
    if (this.projects.length === 0) return;
    for (const project of this.projects) {
      const row = this.projectsEl.createDiv({ cls: "aigt-project" });
      if (project.name === this.selected) {
        row.addClass("is-active");
        row.setAttribute("aria-current", "true");
      }
      const hasClone = project.clonePath !== undefined;
      setIcon(row.createSpan({ cls: "aigt-project-icon" }), hasClone ? "folder-git-2" : "folder-x");
      const label = row.createDiv({ cls: "aigt-project-label" });
      label.createDiv({ cls: "aigt-project-name", text: project.name });
      if (!hasClone) label.createDiv({ cls: "aigt-project-note aigt-muted", text: tr("noClone") });
      activate(row, () => this.select(project.name));
    }
  }

  // ---------------------------------------------------------------- main area

  private renderMain(): void {
    this.mainEl.empty();
    const project = this.current();
    if (this.projects.length === 0) {
      this.emptyState(this.mainEl, "folder-search", tr("noProjects", { root: this.plugin.settings.projectsRoot }));
      return;
    }
    if (!project) {
      this.emptyState(this.mainEl, "mouse-pointer-click", tr("pickProject"));
      return;
    }

    const card = this.mainEl.createDiv({ cls: "aigt-graph-card" });
    const head = card.createDiv({ cls: "aigt-section-head" });
    setIcon(head.createSpan({ cls: "aigt-section-icon" }), "git-branch");
    head.createSpan({ cls: "aigt-section-title", text: tr("graph") });
    this.graphEl = card.createDiv({ cls: "aigt-graph-block" });

    this.tabsEl = this.mainEl.createDiv({ cls: "aigt-tabs", attr: { role: "tablist" } });
    this.panelEl = this.mainEl.createDiv({ cls: "aigt-panel", attr: { role: "tabpanel" } });
    this.renderTabs();
    this.renderPanel(project);
    void this.drawGraph(project);
  }

  private renderTabs(): void {
    this.tabsEl.empty();
    for (const tab of TABS) {
      const button = this.tabsEl.createEl("button", { cls: "aigt-tab", attr: { role: "tab", "aria-selected": String(tab === this.tab) } });
      if (tab === this.tab) button.addClass("is-active");
      setIcon(button.createSpan({ cls: "aigt-tab-icon" }), TAB_ICON[tab]);
      button.createSpan({ text: tr(`tab.${tab}`) });
      button.addEventListener("click", () => {
        if (tab === this.tab) return;
        this.tab = tab;
        this.eventsPage = 1;
        this.logsPage = 1;
        this.renderTabs();
        const project = this.current();
        if (project) this.renderPanel(project);
      });
    }
  }

  private renderPanel(project: ProjectInfo): void {
    this.panelEl.empty();
    if (this.tab === "events") this.renderEvents(project);
    else if (this.tab === "logs") this.renderLogs(project);
    else void this.renderPrs(project);
  }

  private emptyState(parent: HTMLElement, icon: string, message: string): HTMLElement {
    const box = parent.createDiv({ cls: "aigt-state" });
    setIcon(box.createSpan({ cls: "aigt-state-icon" }), icon);
    box.createDiv({ cls: "aigt-state-text", text: message });
    return box;
  }

  // ---------------------------------------------------------------- graph

  private graphWidth(): number {
    const width = Math.round(this.mainEl.clientWidth) - 32;
    return Number.isFinite(width) && width > 0 ? Math.min(1200, Math.max(320, width)) : 640;
  }

  /**
   * Draws the graph of the project. Draws run one after the other and a newer request replaces the
   * ones still waiting, so a slow `git log` never paints over a newer graph.
   */
  private drawGraph(project: ProjectInfo): Promise<void> {
    const seq = ++this.graphSeq;
    this.graphTail = this.graphTail.then(async () => {
      if (seq !== this.graphSeq) return;
      const el = this.graphEl;
      if (el.children.length === 0) el.createDiv({ cls: "aigt-graph-empty aigt-muted", text: tr("loading") });
      await renderGraphInto(el, { history: this.plugin.history, projects: this.plugin.projects }, { projeto: project.name, width: this.graphWidth() });
    });
    return this.graphTail;
  }

  // ---------------------------------------------------------------- events tab

  private eventsOf(project: ProjectInfo): EventRow[] {
    const prefix = `${this.plugin.history.eventsFolder(project)}/`;
    const rows: EventRow[] = [];
    for (const file of this.app.vault.getMarkdownFiles()) {
      if (!file.path.startsWith(prefix)) continue;
      const fm: Record<string, unknown> = this.app.metadataCache.getFileCache(file)?.frontmatter ?? {};
      const stamp = Date.parse(text(fm.data));
      rows.push({
        path: file.path,
        titulo: file.basename,
        tipo: text(fm.evento),
        branch: text(fm.branch),
        data: Number.isFinite(stamp) ? stamp : file.stat.ctime,
      });
    }
    return rows.sort((a, b) => b.data - a.data).slice(0, EVENT_LIMIT);
  }

  private renderEvents(project: ProjectInfo): void {
    const rows = this.eventsOf(project);
    if (rows.length === 0) {
      this.emptyState(this.panelEl, "list", tr("events.empty"));
      return;
    }
    const paginated = paginate(rows, this.eventsPage, 50);
    const list = this.panelEl.createDiv({ cls: "aigt-list" });
    for (const r of paginated.pageItems) {
      const row = list.createDiv({ cls: "aigt-row" });
      setIcon(row.createSpan({ cls: "aigt-row-icon" }), EVENT_ICON[r.tipo] ?? "circle-dot");
      const body = row.createDiv({ cls: "aigt-row-body" });
      body.createDiv({ cls: "aigt-row-title", text: r.titulo });
      const meta = body.createDiv({ cls: "aigt-row-meta aigt-muted" });
      meta.createSpan({ text: tr(`events.type.${r.tipo in EVENT_ICON ? r.tipo : "other"}`) });
      if (r.branch !== "") meta.createSpan({ cls: "aigt-mono", text: r.branch });
      meta.createSpan({ text: dateLabel(r.data) });
      activate(row, () => this.openNote(r.path));
    }

    renderPaginationControls(
      this.panelEl,
      paginated.hasMore,
      paginated.shownCount,
      paginated.total,
      () => {
        this.eventsPage++;
        this.panelEl.empty();
        this.renderEvents(project);
      },
      { showMore: "Carregar mais" },
    );
  }

  // ---------------------------------------------------------------- logs tab

  private renderLogs(project: ProjectInfo): void {
    const logs = logsDoProjeto(this.app, project.name);
    if (logs.length === 0) {
      this.emptyState(this.panelEl, "scroll-text", tr("logs.empty"));
      return;
    }
    const paginated = paginate(logs, this.logsPage, 50);
    const list = this.panelEl.createDiv({ cls: "aigt-list" });
    for (const log of paginated.pageItems) {
      const row = list.createDiv({ cls: "aigt-row" });
      setIcon(row.createSpan({ cls: "aigt-row-icon" }), "scroll-text");
      const body = row.createDiv({ cls: "aigt-row-body" });
      body.createDiv({ cls: "aigt-row-title", text: log.titulo });
      const meta = body.createDiv({ cls: "aigt-row-meta aigt-muted" });
      meta.createSpan({ text: dateLabel(log.data) });
      meta.createSpan({ text: log.status === "ativo" ? tr("logs.active") : log.status === "arquivado" ? tr("logs.archived") : log.status });
      activate(row, () => this.openNote(log.path));
    }

    renderPaginationControls(
      this.panelEl,
      paginated.hasMore,
      paginated.shownCount,
      paginated.total,
      () => {
        this.logsPage++;
        this.panelEl.empty();
        this.renderLogs(project);
      },
      { showMore: "Carregar mais" },
    );
  }

  // ---------------------------------------------------------------- PRs tab

  private async renderPrs(project: ProjectInfo): Promise<void> {
    const seq = ++this.prSeq;
    const panel = this.panelEl;
    const stale = (): boolean => seq !== this.prSeq || this.current()?.name !== project.name || this.tab !== "prs";
    const state = (icon: string, message: string): void => {
      if (stale()) return;
      panel.empty();
      this.emptyState(panel, icon, message);
    };

    if (project.clonePath === undefined) return state("folder-x", tr("prs.noClone"));
    panel.createDiv({ cls: "aigt-muted aigt-loading", text: tr("loading") });
    const ref = await remoteOf(this.services.git, project.clonePath);
    if (stale()) return;
    if (!ref) return state("unlink", tr("prs.noRemote"));
    const s = this.plugin.settings;
    if ((ref.provider === "github" ? s.secretGithub : s.secretBitbucket).trim() === "") {
      return state("key-round", tr("prs.noSecret", { provider: nomeDoProvedor(ref.provider) }));
    }
    try {
      const provider = await this.services.providerFor(ref);
      if (stale()) return;
      if (!provider) return state("key-round", tr("prs.noService"));
      const result = await provider.listarPrs({ estado: "todos", limite: PR_LIMIT });
      if (stale()) return;
      panel.empty();
      if (result.itens.length === 0) {
        this.emptyState(panel, "git-pull-request", tr("prs.empty", { repo: ref.repo }));
        return;
      }
      const list = panel.createDiv({ cls: "aigt-list" });
      for (const pr of result.itens) this.renderPr(list, pr);
      if (result.truncado) panel.createDiv({ cls: "aigt-muted aigt-note", text: tr("prs.truncated", { n: result.itens.length }) });
    } catch (err) {
      state("circle-alert", tr("prs.failed", { reason: reasonOf(err) }));
    }
  }

  private renderPr(list: HTMLElement, pr: PrInfo): void {
    const secure = pr.url.startsWith("https://");
    const row = secure
      ? list.createEl("a", { cls: "aigt-row aigt-row-link", attr: { href: pr.url, target: "_blank", rel: "noopener" } })
      : list.createDiv({ cls: "aigt-row" });
    setIcon(row.createSpan({ cls: `aigt-row-icon aigt-pr-${pr.estado}` }), pr.estado === "mesclado" ? "git-merge" : "git-pull-request");
    const body = row.createDiv({ cls: "aigt-row-body" });
    body.createDiv({ cls: "aigt-row-title", text: `#${pr.numero} ${pr.titulo}` });
    const meta = body.createDiv({ cls: "aigt-row-meta aigt-muted" });
    meta.createSpan({ text: pr.estado === "aberto" ? tr("prs.open") : pr.estado === "mesclado" ? tr("prs.merged") : tr("prs.closed") });
    meta.createSpan({ cls: "aigt-mono", text: tr("prs.branches", { from: pr.origem, to: pr.destino }) });
    if (pr.autor !== "") meta.createSpan({ text: pr.autor });
    const created = Date.parse(pr.criadoEm);
    if (Number.isFinite(created)) meta.createSpan({ text: dateLabel(created) });
  }

  // ---------------------------------------------------------------- notes

  private openNote(path: string): void {
    this.app.workspace.openLinkText(path, "", false).catch((err: unknown) => {
      console.debug("[AI Git Tools] could not open the note", err);
      new Notice(tr("openFailed"));
    });
  }
}

/** Registers the screen. The plugin entry point calls it in `onload`. */
export function registerGitView(plugin: AiGitToolsPlugin): void {
  plugin.registerView(GIT_VIEW_TYPE, (leaf) => new GitToolsView(leaf, plugin));
}
