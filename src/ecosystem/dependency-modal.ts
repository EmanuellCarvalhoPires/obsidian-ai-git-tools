// Shown when the AI Ecosystem is not installed or not enabled once the layout is ready.
// One click installs and enables it; if Obsidian's internal installer is unavailable or the
// network fails, the plugin page opens instead.
import { Modal, Notice, Setting, requestUrl, setIcon } from "obsidian";
import type { App } from "obsidian";
import { t } from "../i18n";
import { ECOSYSTEM_ID } from "./types";

export const ECOSYSTEM_REPO = "EmanuellCarvalhoPires/obsidian-ai-ecosystem";

interface InternalPlugins {
  installPlugin(repo: string, version: string, manifest: unknown): Promise<void>;
  loadManifests(): Promise<void>;
  enablePluginAndSave(id: string): Promise<boolean | void>;
  manifests?: Record<string, unknown>;
}

function internalPlugins(app: App): InternalPlugins | undefined {
  return (app as unknown as { plugins?: InternalPlugins }).plugins;
}

/** True when the AI Ecosystem is installed (enabled or not). */
export function isEcosystemInstalled(app: App): boolean {
  return Boolean(internalPlugins(app)?.manifests?.[ECOSYSTEM_ID]);
}

function pluginPageUrl(): string {
  return `obsidian://show-plugin?id=${ECOSYSTEM_ID}`;
}

/** Downloads the latest release (when needed), installs and enables the AI Ecosystem. */
export async function installEcosystem(app: App): Promise<void> {
  const plugins = internalPlugins(app);
  if (!plugins) throw new Error("The internal plugin installer is not available.");
  if (!isEcosystemInstalled(app)) {
    const releaseText = (await requestUrl(`https://api.github.com/repos/${ECOSYSTEM_REPO}/releases/latest`)).text;
    const release = JSON.parse(releaseText) as { tag_name?: unknown };
    if (typeof release.tag_name !== "string" || release.tag_name === "") throw new Error("No release found.");
    const manifestText = (
      await requestUrl(`https://github.com/${ECOSYSTEM_REPO}/releases/download/${release.tag_name}/manifest.json`)
    ).text;
    await plugins.installPlugin(ECOSYSTEM_REPO, release.tag_name, JSON.parse(manifestText));
  }
  await plugins.loadManifests();
  await plugins.enablePluginAndSave(ECOSYSTEM_ID);
}

export class MissingEcosystemModal extends Modal {
  private installing = false;

  onOpen(): void {
    const { contentEl, titleEl } = this;
    contentEl.addClass("aigt-modal");
    const icon = titleEl.createSpan({ cls: "aigt-modal-icon" });
    setIcon(icon, "alert-triangle");
    titleEl.appendText(t("dependency.title"));
    contentEl.createEl("p", { text: t("dependency.body") });
    contentEl.createEl("p", { text: t("dependency.standby"), cls: "aigt-muted" });

    new Setting(contentEl)
      .addButton((btn) =>
        btn
          .setButtonText(t("dependency.install"))
          .setIcon("download")
          .setCta()
          .onClick(() => void this.install(btn)),
      )
      .addButton((btn) =>
        btn
          .setButtonText(t("dependency.openPage"))
          .setIcon("external-link")
          .onClick(() => {
            activeWindow.open(pluginPageUrl());
            this.close();
          }),
      );
  }

  private async install(button: { setDisabled(disabled: boolean): unknown }): Promise<void> {
    if (this.installing) return;
    this.installing = true;
    button.setDisabled(true);
    try {
      await installEcosystem(this.app);
      new Notice(t("dependency.installed"));
      this.close();
    } catch {
      new Notice(t("dependency.failed"));
      activeWindow.open(pluginPageUrl());
      button.setDisabled(false);
    } finally {
      this.installing = false;
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
