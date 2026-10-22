// Entry point of the AI Git Tools plugin. It connects to the AI Ecosystem core; the tools arrive in later phases.
import { Notice, Plugin, debounce, normalizePath } from "obsidian";
import { ObsidianVaultPort } from "./adapters/obsidian-vault";
import { createNodeGit } from "./core/git-runner";
import { CheckpointStore, createFileStorage } from "./core/history/checkpoints";
import { HistoryService } from "./core/history/history-service";
import { ProjectTracker } from "./core/history/project-tracker";
import { Recorder } from "./core/history/recorder";
import { RemoteSync, createProviderResolver } from "./core/history/remote-sync";
import { HistoryWatcher } from "./core/history/watcher";
import type { ProjectInfo, ProjectLookup } from "./core/ports";
import { createSecureHttp } from "./core/providers/http";
import { inspectSecrets, redactWith } from "./core/providers/secrets";
import type { SecretListing, SecretsGetter } from "./core/providers/secrets";
import type { SecureHttp } from "./core/ports";
import { EcosystemConnector } from "./ecosystem/connector";
import { MissingEcosystemModal } from "./ecosystem/dependency-modal";
import { createSetupHandler, registerSetupHandler } from "./ecosystem/setup";
import { AI_ECOSYSTEM_API_VERSION, SECRETS_SERVICE } from "./ecosystem/types";
import type { AIEcosystemAPI, HubTool, SecretVaultService } from "./ecosystem/types";
import { buildGitTools } from "./tools/git-tools";
import type { GitToolDeps } from "./tools/git-tools";
import { t } from "./i18n";
import { AiGitToolsSettingTab } from "./ui/settings-tab";
import type { SettingsHost, SyncAllSummary } from "./ui/settings-tab";
import { registerGraphBlock } from "./ui/graph-block";
import { registerGitView } from "./ui/git-view";
import { DEFAULT_SETTINGS, normalizeSettings } from "./types";
import type { Settings } from "./types";

export const MODULE_ID = "ai-git-tools";
const MODULE_NAME = "AI Git Tools";
/** View type of the module screen (`src/ui/git-view.ts` registers the view with this same string). */
const VIEW_TYPE = "ai-git-tools-view";

/** Text appended to the MCP instructions of the AI Ecosystem. */
export const GIT_INSTRUCTIONS =
  "AI Git Tools runs git and reads GitHub or Bitbucket pull requests and pipelines for you. " +
  "Use its tools instead of running git or the provider APIs from the shell, so every repository action is recorded in the project history.";

/** Service other modules read. The AI Log Manager draws the repository graph through it. */
export interface GitToolsService {
  version: string;
  hasProject(name: string): boolean;
  /**
   * The SVG of the repository graph of a project, or undefined when the project is unknown, has no
   * clone, has no commits or the repository cannot be read. `largura` is the width in pixels.
   */
  renderGraphSvg(project: string, options?: { branch?: string; hash?: string; limite?: number; largura?: number }): Promise<string | undefined>;
}

export interface GitToolsServiceDeps {
  version: string;
  history: Pick<HistoryService, "graph">;
  projects: Pick<ProjectLookup, "byName">;
  /** Projects as last listed (synchronous cache, kept fresh by the plugin). */
  knownProjects: () => readonly Pick<ProjectInfo, "name">[];
}

/**
 * The real `ai-git-tools` service. `hasProject` answers from the cache of the last listing (it must
 * be synchronous); `renderGraphSvg` always asks the tracker, so it is right even when the cache is stale.
 */
export function createGitToolsService(deps: GitToolsServiceDeps): GitToolsService {
  return {
    version: deps.version,
    hasProject: (name) => {
      const key = name.trim().toLowerCase();
      return key !== "" && deps.knownProjects().some((p) => p.name.toLowerCase() === key);
    },
    renderGraphSvg: async (name, options = {}) => {
      try {
        const project = await deps.projects.byName(name);
        if (!project?.clonePath) return undefined;
        const g = await deps.history.graph(project, {
          limit: options.limite,
          width: options.largura,
          highlight: { branch: options.branch, hash: options.hash },
        });
        return g.rows.length > 0 ? g.svg : undefined;
      } catch (err) {
        console.debug("[AI Git Tools] could not draw the graph", err);
        return undefined;
      }
    },
  };
}

export default class AiGitToolsPlugin extends Plugin implements SettingsHost {
  settings: Settings = { ...DEFAULT_SETTINGS };
  private connector!: EcosystemConnector;
  private api: AIEcosystemAPI | undefined;
  private gitDeps!: GitToolDeps;
  /** Projects of the vault (notes tagged dev/projeto). */
  projects!: ProjectTracker;
  /**
   * The projects as last listed by the tracker (a synchronous cache for the screen and for the
   * service). It is filled when the plugin connects and refreshed a few seconds after any note
   * change; call `refreshProjects()` to read them anew.
   */
  lastProjects: ProjectInfo[] = [];
  /** Event notes, graph and the repository sync. The recorder, watcher and tools use it. */
  history!: HistoryService;
  private checkpoints: CheckpointStore | undefined;
  /** Writes the event note of what a tool did. */
  recorder!: Recorder;
  /** Watches the reflogs of the clones: what happens in the terminal becomes notes too. */
  watcher!: HistoryWatcher;
  /** Reads pull requests and deploys of the remote on a timer. */
  remoteSync!: RemoteSync;
  /** Interval the running remote polling was started with. */
  private appliedIntervalMin = 0;
  private unregisterSetupHandler: (() => void) | undefined;
  /**
   * The `secrets` service of Environment Keys, looked up at every call (never cached): it may appear
   * or go away while Obsidian runs.
   */
  readonly getSecrets: SecretsGetter = () => this.api?.getService<SecretVaultService>(SECRETS_SERVICE);
  /** Authenticated HTTP for the provider layer (GitHub and Bitbucket), through `getSecrets`. */
  readonly providerHttp: SecureHttp = createSecureHttp(this.getSecrets);

  async onload(): Promise<void> {
    this.settings = normalizeSettings(await this.loadData());
    const git = createNodeGit();
    const vault = new ObsidianVaultPort(this.app);
    this.projects = new ProjectTracker(vault, () => this.settings);
    // The checkpoints are a file of this plugin (never the state of the AI Log Manager).
    this.checkpoints = await CheckpointStore.open(createFileStorage(this.app.vault.adapter, normalizePath(`${this.manifest.dir ?? ""}/checkpoints.json`)));
    this.history = new HistoryService(git, vault, this.checkpoints, () => this.settings);
    this.recorder = new Recorder({ history: this.history, projects: this.projects, git });
    this.watcher = new HistoryWatcher({ history: this.history, projects: this.projects });
    this.remoteSync = new RemoteSync({
      history: this.history,
      projects: this.projects,
      git,
      settings: () => this.settings,
      providerFor: createProviderResolver({ settings: () => this.settings, getSecrets: this.getSecrets, http: this.providerHttp }),
    });
    this.gitDeps = {
      git,
      projects: this.projects,
      allowedFolders: () => this.settings.allowedFolders,
      allowAnyFolder: () => this.settings.allowAnyFolder,
      settings: () => this.settings,
      redact: (text) => redactWith(this.getSecrets, text),
      getSecrets: this.getSecrets,
      http: this.providerHttp,
      recorder: this.recorder,
      history: this.history,
      tracker: this.projects,
      remoteSync: this.remoteSync,
    };
    this.connector = new EcosystemConnector(this, {
      buildRegistration: () => ({
        id: MODULE_ID,
        name: MODULE_NAME,
        version: this.manifest.version,
        apiVersion: AI_ECOSYSTEM_API_VERSION,
        tools: this.buildTools(),
        instructions: GIT_INSTRUCTIONS,
        onUnload: () => this.dropSetupHandler(),
      }),
      onMissing: () => new MissingEcosystemModal(this.app).open(),
      onIncompatible: (reason) => new Notice(reason),
      onConnected: (api) => this.onConnected(api),
      onDisconnected: () => this.stopAutomation(),
    });
    registerGitView(this);
    this.registerSurfaces();
    this.connector.start();
  }

  onunload(): void {
    this.stopAutomation();
    this.dropSetupHandler();
    this.api = undefined;
    this.connector?.stop();
    void this.checkpoints?.flush().catch(() => undefined);
  }

  /** The graph block, the settings tab, the command and the ribbon icon that open the module screen. */
  private registerSurfaces(): void {
    registerGraphBlock(
      (language, handler) => this.registerMarkdownCodeBlockProcessor(language, (source, el) => handler(source, el)),
      () => ({ history: this.history, projects: this.projects }),
    );
    this.addSettingTab(new AiGitToolsSettingTab(this.app, this, this));
    this.addCommand({ id: "open-view", name: t("command.openView"), callback: () => void this.activateView() });
    this.addRibbonIcon("git-branch", t("ribbon.openView"), () => void this.activateView());
    const refresh = debounce(() => void this.refreshProjects(), 3000, true);
    this.registerEvent(this.app.metadataCache.on("changed", refresh));
    this.registerEvent(this.app.metadataCache.on("deleted", refresh));
  }

  /**
   * Opens the module screen: reuses the leaf of type `ai-git-tools-view` when there is one,
   * otherwise opens a new tab (the screen has a project list, the graph and tabs, so it wants the
   * width of the main area rather than a side panel). The view itself is registered by
   * `registerGitView` of `src/ui/git-view.ts`.
   */
  async activateView(): Promise<void> {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE)[0];
    if (!leaf) {
      leaf = workspace.getLeaf("tab");
      await leaf.setViewState({ type: VIEW_TYPE, active: true });
    }
    await workspace.revealLeaf(leaf);
  }

  /** Lists the projects again and updates `lastProjects`. Never throws (keeps the old list on a failure). */
  async refreshProjects(): Promise<ProjectInfo[]> {
    try {
      this.lastProjects = await this.projects.list();
    } catch (err) {
      console.debug("[AI Git Tools] could not list the projects", err);
    }
    return this.lastProjects;
  }

  /** `SettingsHost`: names and types of the secrets of Environment Keys, never values. */
  listSecrets(): Promise<SecretListing> {
    return inspectSecrets(this.getSecrets);
  }

  /** `SettingsHost`: reads every project with a clone once and records what is new. */
  async syncAllProjects(): Promise<SyncAllSummary> {
    const summary: SyncAllSummary = { projects: 0, created: 0, baselines: 0, errors: 0 };
    for (const project of await this.refreshProjects()) {
      if (!project.clonePath || (await this.history.repoOf(project)) === undefined) continue;
      const res = await this.history.sync(project);
      summary.projects += 1;
      summary.created += res.created.length;
      summary.errors += res.errors.length;
      if (res.baseline) summary.baselines += 1;
    }
    return summary;
  }

  /** The git tools, the provider tools (PR and pipeline) and the documentation tools (graph, changelog, sync, event). */
  private buildTools(): HubTool[] {
    return buildGitTools(this.gitDeps);
  }

  private onConnected(api: AIEcosystemAPI): void {
    this.api = api;
    void this.refreshProjects();
    this.refreshAutomation();
    this.dropSetupHandler();
    this.unregisterSetupHandler = registerSetupHandler(
      api,
      createSetupHandler({
        getSettings: () => this.settings,
        saveSettings: () => this.saveSettings(),
        folderExists: (path) => this.app.vault.getFolderByPath(path) !== null,
        listSecrets: () => inspectSecrets(this.getSecrets),
      }),
    );
    api.registerService<GitToolsService>(
      "ai-git-tools",
      MODULE_ID,
      createGitToolsService({
        version: this.manifest.version,
        history: this.history,
        projects: this.projects,
        knownProjects: () => this.lastProjects,
      }),
    );
  }

  /**
   * Starts or stops the automatic documentation according to the settings: the watcher of the
   * reflogs (`watch`; it also syncs every project once, which rebuilds what happened while Obsidian
   * was closed) and the polling of the remote (`remotePolling`, every `remoteIntervalMin` minutes).
   * Runs when the plugin connects to the AI Ecosystem; the settings screen calls it again after a change.
   */
  refreshAutomation(): void {
    if (!this.api) return;
    if (this.settings.watch) void this.watcher.start().catch((err: unknown) => console.debug("[AI Git Tools] watcher", err));
    else this.watcher.stop();
    // Restarted only when the polling was off or the interval changed (starting reads the remote right away).
    const { remotePolling, remoteIntervalMin } = this.settings;
    if (!remotePolling) {
      this.remoteSync.stop();
    } else if (!this.remoteSync.active || remoteIntervalMin !== this.appliedIntervalMin) {
      this.remoteSync.stop();
      this.appliedIntervalMin = remoteIntervalMin;
      this.remoteSync.start();
    }
  }

  /** Stops the watcher and the polling (unload, or the AI Ecosystem went away). */
  private stopAutomation(): void {
    this.watcher?.stop();
    this.remoteSync?.stop();
  }

  private dropSetupHandler(): void {
    this.unregisterSetupHandler?.();
    this.unregisterSetupHandler = undefined;
  }

  async saveSettings(): Promise<void> {
    try {
      await this.saveData(this.settings);
    } catch (err) {
      console.error("[AI Git Tools] Could not save settings", err);
    }
  }
}
