// Settings tab of the AI Git Tools plugin (imperative, Obsidian-standard).
//
// CSS classes used here (the stylesheet belongs to the screen task): `aigt-mono` (monospace text
// area for the folder list).
import { Notice, PluginSettingTab, Setting, debounce } from "obsidian";
import type { App, Plugin } from "obsidian";
import type { SecretListing } from "../core/providers/secrets";
import { t } from "../i18n";
import { DEFAULT_SETTINGS } from "../types";
import type { Settings } from "../types";

/** Result of "synchronize now" over every project. */
export interface SyncAllSummary {
  /** Projects read (the ones with a usable clone). */
  projects: number;
  /** Event notes created. */
  created: number;
  /** Projects whose first read only stored the baseline. */
  baselines: number;
  /** Errors reported by the reads. */
  errors: number;
}

/** What the tab needs from the plugin (the plugin itself implements it). */
export interface SettingsHost {
  settings: Settings;
  saveSettings(): Promise<void>;
  /** Starts or stops the watcher and the remote polling according to the settings. */
  refreshAutomation(): void;
  /** Names and types of the secrets of Environment Keys (no values) and why a list may be empty. */
  listSecrets(): Promise<SecretListing>;
  syncAllProjects(): Promise<SyncAllSummary>;
}

/** Minutes between remote reads: accepted range. */
export const MIN_INTERVAL_MIN = 1;
export const MAX_INTERVAL_MIN = 120;

const cleanFolder = (v: string, fallback: string): string => v.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "") || fallback;

export class AiGitToolsSettingTab extends PluginSettingTab {
  /** Bumped at every `display`, so a slow secrets listing of an older render is dropped. */
  private renderToken = 0;

  constructor(
    app: App,
    plugin: Plugin,
    private readonly host: SettingsHost,
  ) {
    super(app, plugin);
    this.icon = "git-branch";
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    this.renderToken += 1;
    this.renderFolders(containerEl);
    this.renderProviders(containerEl);
    this.renderAutomation(containerEl);
    this.renderHookNote(containerEl);
  }

  private renderFolders(el: HTMLElement): void {
    new Setting(el).setHeading().setName(t("settings.folders.heading"));
    const s = this.host.settings;
    const folder = (name: string, desc: string, key: "projectsRoot" | "eventsFolder" | "changelogsFolder"): void => {
      new Setting(el)
        .setName(t(name))
        .setDesc(t(desc))
        .addText((tx) =>
          tx.setValue(s[key]).onChange((v) => {
            s[key] = cleanFolder(v, DEFAULT_SETTINGS[key]);
            void this.host.saveSettings();
          }),
        );
    };
    folder("settings.projectsRoot", "settings.projectsRootDesc", "projectsRoot");
    folder("settings.eventsFolder", "settings.eventsFolderDesc", "eventsFolder");
    folder("settings.changelogsFolder", "settings.changelogsFolderDesc", "changelogsFolder");

    new Setting(el)
      .setName(t("settings.allowedFolders"))
      .setDesc(t("settings.allowedFoldersDesc"))
      .addTextArea((ta) => {
        ta.setValue(s.allowedFolders.join("\n")).onChange((v) => {
          s.allowedFolders = v
            .split("\n")
            .map((l) => l.trim())
            .filter((l) => l !== "");
          void this.host.saveSettings();
        });
        ta.inputEl.rows = 3;
        ta.inputEl.addClass("aigt-mono");
      });

    new Setting(el)
      .setName(t("settings.allowAnyFolder"))
      .setDesc(t("settings.allowAnyFolderDesc"))
      .addToggle((tg) =>
        tg.setValue(s.allowAnyFolder).onChange((v) => {
          s.allowAnyFolder = v;
          void this.host.saveSettings();
        }),
      );
  }

  private renderProviders(el: HTMLElement): void {
    new Setting(el).setHeading().setName(t("settings.providers.heading"));
    // The list comes from Environment Keys and can take a moment (or fail): the box keeps its place.
    const box = el.createDiv();
    const token = this.renderToken;
    box.createDiv({ text: t("settings.secret.loading") });
    void this.host
      .listSecrets()
      .catch((): SecretListing => ({ status: "erro", secrets: [] }))
      .then((listing) => {
        if (token !== this.renderToken) return;
        box.empty();
        this.renderSecretChoice(box, "settings.secretBitbucket", "secretBitbucket", listing);
        this.renderSecretChoice(box, "settings.secretGithub", "secretGithub", listing);
      });
  }

  private renderSecretChoice(box: HTMLElement, nameKey: string, key: "secretGithub" | "secretBitbucket", listing: SecretListing): void {
    const s = this.host.settings;
    const current = s[key];
    const known = listing.secrets.some((x) => x.name === current);
    const desc = listing.status === "ok" ? t("settings.secretDesc") : `${t("settings.secretDesc")} ${t(`settings.secret.status.${listing.status}`)}`;
    new Setting(box)
      .setName(t(nameKey))
      .setDesc(desc)
      .addDropdown((dd) => {
        dd.addOption("", t("settings.secret.none"));
        for (const secret of listing.secrets) dd.addOption(secret.name, secret.name);
        // A saved choice is never lost just because the list could not be read (or no longer has it).
        if (current !== "" && !known) dd.addOption(current, listing.status === "ok" ? `${current} (${t("settings.secret.missing")})` : current);
        dd.setValue(current).onChange((v) => {
          s[key] = v;
          void this.host.saveSettings();
        });
      });
  }

  private renderAutomation(el: HTMLElement): void {
    new Setting(el).setHeading().setName(t("settings.automation.heading"));
    const s = this.host.settings;
    const apply = (): void => {
      void this.host.saveSettings();
      this.host.refreshAutomation();
    };
    // The interval field fires on every keystroke: the automation restarts once, after typing stops.
    const applyLater = debounce(apply, 800, true);

    new Setting(el)
      .setName(t("settings.watch"))
      .setDesc(t("settings.watchDesc"))
      .addToggle((tg) =>
        tg.setValue(s.watch).onChange((v) => {
          s.watch = v;
          apply();
        }),
      );

    new Setting(el)
      .setName(t("settings.remotePolling"))
      .setDesc(t("settings.remotePollingDesc"))
      .addToggle((tg) =>
        tg.setValue(s.remotePolling).onChange((v) => {
          s.remotePolling = v;
          apply();
        }),
      );

    new Setting(el)
      .setName(t("settings.remoteInterval"))
      .setDesc(t("settings.remoteIntervalDesc"))
      .addText((tx) =>
        tx.setValue(String(s.remoteIntervalMin)).onChange((v) => {
          const n = Number(v);
          if (!Number.isInteger(n) || n < MIN_INTERVAL_MIN || n > MAX_INTERVAL_MIN) return;
          s.remoteIntervalMin = n;
          applyLater();
        }),
      );

    new Setting(el)
      .setName(t("settings.sync"))
      .setDesc(t("settings.syncDesc"))
      .addButton((btn) =>
        btn
          .setButtonText(t("settings.syncButton"))
          .setIcon("refresh-cw")
          .onClick(() => {
            btn.setDisabled(true);
            new Notice(t("settings.sync.running"));
            void this.host
              .syncAllProjects()
              .then((r) => new Notice(t("settings.sync.done", { projects: r.projects, notes: r.created, baselines: r.baselines, errors: r.errors })))
              .catch((err: unknown) => new Notice(t("settings.sync.failed", { reason: err instanceof Error ? err.message : String(err) })))
              .finally(() => btn.setDisabled(false));
          }),
      );
  }

  private renderHookNote(el: HTMLElement): void {
    new Setting(el).setHeading().setName(t("settings.hook.heading"));
    new Setting(el).setName(t("settings.hook.name")).setDesc(t("settings.hook.desc"));
  }
}
