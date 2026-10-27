import { beforeEach, describe, expect, it, vi } from "vitest";
import { notices, setMockLanguage } from "../mocks/obsidian";
import { AiGitToolsSettingTab } from "../../src/ui/settings-tab";
import type { SettingsHost, SyncAllSummary } from "../../src/ui/settings-tab";
import { DEFAULT_SETTINGS } from "../../src/types";
import type { SecretListing } from "../../src/core/providers/secrets";
import { secretInfo } from "../helpers/fake-secrets";

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

const OK_LIST: SecretListing = { status: "ok", secrets: [secretInfo("GH_TESTE"), secretInfo("BB_TESTE", "basic", { allowedHosts: ["api.bitbucket.org"] })] };

function setup(over: { listing?: SecretListing; sync?: () => Promise<SyncAllSummary> } = {}) {
  const host = {
    settings: { ...DEFAULT_SETTINGS, allowedFolders: [] as string[] },
    saveSettings: vi.fn(async () => undefined),
    refreshAutomation: vi.fn(),
    listSecrets: vi.fn(async () => over.listing ?? OK_LIST),
    syncAllProjects: vi.fn(over.sync ?? (async () => ({ projects: 2, created: 3, baselines: 1, errors: 0 }))),
  } satisfies SettingsHost;
  const tab = new AiGitToolsSettingTab({} as never, {} as never, host);
  return { host, tab };
}

function allSettings(tab: AiGitToolsSettingTab): any[] {
  const all: any[] = [];
  const walk = (el: any): void => {
    for (const c of el.children) {
      if (c.setting) all.push(c.setting);
      walk(c);
    }
  };
  walk(tab.containerEl);
  return all;
}

/** Finds a Setting rendered by the tab, by its name. */
function byName(tab: AiGitToolsSettingTab, name: string): any {
  const all = allSettings(tab);
  const found = all.find((s) => s.nameEl.textContent === name);
  if (!found) throw new Error(`no setting "${name}" among ${all.map((s) => s.nameEl.textContent).join(", ")}`);
  return found;
}

beforeEach(() => {
  setMockLanguage("en");
  notices.length = 0;
});

describe("settings tab: folders", () => {
  it("shows and saves the folders, trimming and falling back to the default when emptied", () => {
    const { host, tab } = setup();
    tab.display();
    const root = byName(tab, "Projects folder").components[0];
    expect(root.value).toBe("Projetos");
    root.changeFn("  /Meus Projetos/ ");
    expect(host.settings.projectsRoot).toBe("Meus Projetos");
    root.changeFn("   ");
    expect(host.settings.projectsRoot).toBe("Projetos");
    byName(tab, "Events subfolder").components[0].changeFn("Eventos2");
    byName(tab, "Changelogs subfolder").components[0].changeFn("Releases");
    expect(host.settings.eventsFolder).toBe("Eventos2");
    expect(host.settings.changelogsFolder).toBe("Releases");
    expect(host.saveSettings).toHaveBeenCalledTimes(4);
  });

  it("keeps the allowed folders one per line, without blanks", () => {
    const { host, tab } = setup();
    host.settings.allowedFolders = ["C:\\a", "D:\\b"];
    tab.display();
    const area = byName(tab, "Extra allowed folders").components[0];
    expect(area.value).toBe("C:\\a\nD:\\b");
    area.changeFn("C:\\x\n\n  D:\\y  \n");
    expect(host.settings.allowedFolders).toEqual(["C:\\x", "D:\\y"]);
  });
});

describe("settings tab: secrets", () => {
  it("lists the secret names plus None and saves the choice (empty string for None)", async () => {
    const { host, tab } = setup();
    host.settings.secretGithub = "GH_TESTE";
    tab.display();
    await flush();
    const gh = byName(tab, "GitHub secret").components[0];
    expect(gh.options).toEqual({ "": "None", GH_TESTE: "GH_TESTE", BB_TESTE: "BB_TESTE" });
    expect(gh.value).toBe("GH_TESTE");
    gh.changeFn("");
    expect(host.settings.secretGithub).toBe("");
    const bb = byName(tab, "Bitbucket secret").components[0];
    expect(bb.value).toBe("");
    bb.changeFn("BB_TESTE");
    expect(host.settings.secretBitbucket).toBe("BB_TESTE");
    expect(host.saveSettings).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["sem_servico", "Environment Keys is not active"],
    ["sem_listagem", "cannot list secrets"],
    ["cofre_bloqueado", "vault is locked"],
    ["erro", "Could not read the secrets"],
  ] as const)("when the list is unavailable (%s) it says so and keeps the saved choice", async (status, text) => {
    const { host, tab } = setup({ listing: { status, secrets: [] } });
    host.settings.secretBitbucket = "BB_SALVA";
    tab.display();
    await flush();
    const bb = byName(tab, "Bitbucket secret");
    expect(bb.descEl.textContent).toContain(text);
    expect(bb.components[0].options).toEqual({ "": "None", BB_SALVA: "BB_SALVA" });
    expect(bb.components[0].value).toBe("BB_SALVA");
    expect(host.settings.secretBitbucket).toBe("BB_SALVA");
  });

  it("marks a saved name that the vault no longer has", async () => {
    const { host, tab } = setup();
    host.settings.secretGithub = "VELHA";
    tab.display();
    await flush();
    expect(byName(tab, "GitHub secret").components[0].options.VELHA).toBe("VELHA (not found)");
  });

  it("treats a failure of the listing as an error state, not a crash", async () => {
    const { host, tab } = setup();
    host.listSecrets.mockRejectedValueOnce(new Error("x"));
    tab.display();
    await flush();
    expect(byName(tab, "GitHub secret").descEl.textContent).toContain("Could not read the secrets");
  });

  it("drops the answer of an older render", async () => {
    let resolveFirst!: (l: SecretListing) => void;
    const { host, tab } = setup();
    host.listSecrets.mockImplementationOnce(() => new Promise<SecretListing>((r) => (resolveFirst = r)));
    tab.display();
    tab.display();
    await flush();
    resolveFirst(OK_LIST);
    await flush();
    expect(allSettings(tab).filter((s) => s.nameEl.textContent === "GitHub secret")).toHaveLength(1);
  });
});

describe("settings tab: automation", () => {
  it("saves and refreshes the automation when a toggle changes", () => {
    const { host, tab } = setup();
    tab.display();
    byName(tab, "Watch the terminal").components[0].changeFn(false);
    expect(host.settings.watch).toBe(false);
    byName(tab, "Read the remote").components[0].changeFn(false);
    expect(host.settings.remotePolling).toBe(false);
    expect(host.refreshAutomation).toHaveBeenCalledTimes(2);
    expect(host.saveSettings).toHaveBeenCalledTimes(2);
  });

  it("accepts the interval from 1 to 120 only", () => {
    const { host, tab } = setup();
    tab.display();
    const field = byName(tab, "Minutes between remote reads").components[0];
    expect(field.value).toBe("30");
    for (const bad of ["0", "121", "abc", "1.5", "", "-3"]) field.changeFn(bad);
    expect(host.settings.remoteIntervalMin).toBe(30);
    field.changeFn("1");
    expect(host.settings.remoteIntervalMin).toBe(1);
    field.changeFn("120");
    expect(host.settings.remoteIntervalMin).toBe(120);
    expect(host.refreshAutomation).toHaveBeenCalled();
  });

  it("synchronizes every project from the button and reports the summary in a notice", async () => {
    const { host, tab } = setup();
    tab.display();
    const button = byName(tab, "Synchronize now").components[0];
    expect(button.buttonEl.textContent).toBe("Synchronize now");
    button.clickFn();
    expect(button.disabled).toBe(true);
    await flush();
    expect(host.syncAllProjects).toHaveBeenCalledOnce();
    expect(notices).toContain("Synchronized 2 project(s): 3 note(s) created, 1 first read(s), 0 error(s).");
    expect(button.disabled).toBe(false);
  });

  it("reports a failed synchronization and enables the button again", async () => {
    const { tab } = setup({ sync: () => Promise.reject(new Error("sem git")) });
    tab.display();
    const button = byName(tab, "Synchronize now").components[0];
    button.clickFn();
    await flush();
    expect(notices).toContain("Could not synchronize: sem git");
    expect(button.disabled).toBe(false);
  });
});

describe("settings tab: event notes", () => {
  it("shows initial states of the 5 toggles (Branch/PR/Deploy on, Commit/Push off)", () => {
    const { tab } = setup();
    tab.display();
    expect(byName(tab, "Branch notes").components[0].value).toBe(true);
    expect(byName(tab, "PR notes").components[0].value).toBe(true);
    expect(byName(tab, "Deploy notes").components[0].value).toBe(true);
    expect(byName(tab, "Commit notes").components[0].value).toBe(false);
    expect(byName(tab, "Push notes").components[0].value).toBe(false);
  });

  it("switching on Commit notes sets ['commit', 'branch', 'pr', 'deploy'] and saves", () => {
    const { host, tab } = setup();
    tab.display();
    byName(tab, "Commit notes").components[0].changeFn(true);
    expect(host.settings.eventTypes).toEqual(["commit", "branch", "pr", "deploy"]);
    expect(host.saveSettings).toHaveBeenCalledTimes(1);
  });

  it("switching off PR notes removes pr", () => {
    const { host, tab } = setup();
    tab.display();
    byName(tab, "PR notes").components[0].changeFn(false);
    expect(host.settings.eventTypes).toEqual(["branch", "deploy"]);
    expect(host.settings.eventTypes).not.toContain("pr");
    expect(host.saveSettings).toHaveBeenCalledTimes(1);
  });

  it("has 'Notas de commit' in Portuguese", () => {
    setMockLanguage("pt");
    const { tab } = setup();
    tab.display();
    expect(byName(tab, "Notas de commit")).toBeDefined();
  });
});

describe("settings tab: hook note", () => {
  it("explains that the hook mode lives in the AI Ecosystem configuration", () => {
    const { tab } = setup();
    tab.display();
    expect(byName(tab, "Hook mode").descEl.textContent).toContain("AI Ecosystem configuration");
  });

  it("is available in Portuguese", () => {
    setMockLanguage("pt-BR");
    const { tab } = setup();
    tab.display();
    expect(byName(tab, "Modo do hook").descEl.textContent).toContain("configuração do AI Ecosystem");
  });
});
