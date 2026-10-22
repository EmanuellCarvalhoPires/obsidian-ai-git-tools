import { afterEach, describe, expect, it, vi } from "vitest";
import AiGitToolsPlugin, { MODULE_ID } from "../../src/main";
import { MissingEcosystemModal } from "../../src/ecosystem/dependency-modal";
import type { HubModuleRegistration } from "../../src/ecosystem/types";

type Listener = (...args: unknown[]) => void;

/** Fake Obsidian app: records the workspace events and lets the test fire the layout-ready callback. */
function fakeApp(ecosystemApi?: unknown) {
  const listeners = new Map<string, Listener>();
  let layoutReady: (() => void) | undefined;
  const app = {
    workspace: {
      onLayoutReady: (cb: () => void) => {
        layoutReady = cb;
      },
      on: (name: string, cb: Listener) => {
        listeners.set(name, cb);
        return { name };
      },
    },
    plugins: {
      getPlugin: (id: string) => (id === "ai-ecosystem" && ecosystemApi ? { api: ecosystemApi } : null),
    },
    vault: { getFolderByPath: () => null },
    metadataCache: { on: () => ({}) },
  };
  return { app, fireLayoutReady: () => layoutReady?.(), fireReady: (api: unknown) => listeners.get("ai-ecosystem:ready")?.(api) };
}

/** Fake AI Ecosystem core: records what the module registers and unregisters. */
function fakeCore(hooks?: { registered: string[] }) {
  const registrations: HubModuleRegistration[] = [];
  const unregistered: string[] = [];
  const services = new Map<string, { owner: string; instance: unknown }>();
  const api = {
    apiVersion: 1,
    isReady: () => true,
    registerModule: (m: HubModuleRegistration) => {
      registrations.push(m);
      return { ok: true as const };
    },
    unregisterModule: (id: string) => {
      unregistered.push(id);
      return true;
    },
    registerService: (name: string, owner: string, instance: unknown) => {
      services.set(name, { owner, instance });
    },
    getService: (name: string) =>
      name === "hooks" && hooks
        ? { registerSetupHandler: (id: string) => (hooks.registered.push(id), () => undefined) }
        : undefined,
  };
  return { api, registrations, unregistered, services };
}

function makePlugin(app: unknown): AiGitToolsPlugin {
  const manifest = { id: "ai-git-tools", name: "AI Git Tools", version: "0.1.0" };
  return new AiGitToolsPlugin(app as never, manifest as never);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("AI Git Tools connection to the AI Ecosystem", () => {
  it("registers the module with the id, the version and the 29 tools, and its service", async () => {
    const core = fakeCore();
    const { app, fireLayoutReady } = fakeApp(core.api);
    const plugin = makePlugin(app);
    await plugin.onload();
    fireLayoutReady();

    expect(core.registrations).toHaveLength(1);
    const registration = core.registrations[0]!;
    expect(registration).toMatchObject({ id: MODULE_ID, name: "AI Git Tools", version: "0.1.0", apiVersion: 1 });
    expect(registration.tools?.map((t) => t.name)).toEqual(["git_status", "git_diff", "git_log", "git_blame", "git_branches", "git_remote_info", "git_fetch", "git_checkout", "git_add", "git_commit", "git_push", "git_pull", "git_merge", "git_revert", "git_stash", "git_tag", "git_clone", "git_pr_criar", "git_pr_listar", "git_pr_obter", "git_pr_comentar", "git_pr_merge", "git_pipeline_status", "git_repo_criar", "git_release_criar", "git_graph", "git_changelog", "git_sync", "git_registrar_evento"]);
    expect(core.services.get("ai-git-tools")).toMatchObject({ owner: MODULE_ID });
  });

  it("registers the guided setup handler when the hooks service exists", async () => {
    const hooks = { registered: [] as string[] };
    const core = fakeCore(hooks);
    const { app, fireLayoutReady } = fakeApp(core.api);
    const plugin = makePlugin(app);
    await plugin.onload();
    fireLayoutReady();

    expect(hooks.registered).toEqual([MODULE_ID]);
  });

  it("registers again when the AI Ecosystem fires ready, and removes the module on unload", async () => {
    const core = fakeCore();
    const { app, fireLayoutReady, fireReady } = fakeApp(undefined);
    const plugin = makePlugin(app);
    await plugin.onload();
    fireLayoutReady();
    fireReady(core.api);
    expect(core.registrations).toHaveLength(1);

    plugin.onunload();
    expect(core.unregistered).toEqual([MODULE_ID]);
  });

  it("without the AI Ecosystem opens the dependency modal and throws nothing", async () => {
    const open = vi.spyOn(MissingEcosystemModal.prototype, "open").mockImplementation(() => undefined);
    const { app, fireLayoutReady } = fakeApp(undefined);
    const plugin = makePlugin(app);
    await plugin.onload();

    expect(() => fireLayoutReady()).not.toThrow();
    expect(open).toHaveBeenCalledTimes(1);
  });
});
