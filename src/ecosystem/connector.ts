// Connects this plugin to the AI Ecosystem no matter which plugin Obsidian loads first, and
// again every time the AI Ecosystem reloads. Adapted from the reference connector in the AI
// Ecosystem repository (docs/module-connector.ts), with typed access to the Provider API.
import type { Plugin } from "obsidian";
import { ECOSYSTEM_EVENTS, ECOSYSTEM_ID } from "./types";
import type { AIEcosystemAPI, HubModuleRegistration } from "./types";

export type ConnectorStatus =
  /** Registered in the AI Ecosystem. */
  | "connected"
  /** The AI Ecosystem is installed but not ready yet; waiting for its "ready" event. */
  | "waiting"
  /** The AI Ecosystem is reloading or was disabled; the module registers again on "ready". */
  | "disconnected"
  /** The AI Ecosystem is not installed or not enabled. */
  | "missing"
  /** The AI Ecosystem refused the registration (for example an unsupported Provider API version). */
  | "incompatible";

export interface EcosystemConnectorOptions {
  /** Builds the registration. Called on every (re-)registration, so handlers see fresh state. */
  buildRegistration: () => HubModuleRegistration;
  onStatus?: (status: ConnectorStatus, detail?: string) => void;
  /** After the layout is ready the AI Ecosystem is not installed or enabled: show the dependency modal. */
  onMissing?: () => void;
  /** The AI Ecosystem refused the registration. */
  onIncompatible?: (reason: string) => void;
  /** Right after a successful registration: register services, read services of other modules. */
  onConnected?: (api: AIEcosystemAPI) => void;
  /** The connection dropped (the AI Ecosystem unloaded). */
  onDisconnected?: () => void;
}

type WorkspaceEvents = {
  on(name: string, cb: (...args: unknown[]) => unknown): Parameters<Plugin["registerEvent"]>[0];
};

export class EcosystemConnector {
  private moduleId: string | undefined;
  private api: AIEcosystemAPI | undefined;
  private stopped = false;
  private currentStatus: ConnectorStatus = "missing";
  private lastDetail: string | undefined;

  constructor(
    private readonly plugin: Plugin,
    private readonly options: EcosystemConnectorOptions,
  ) {}

  get status(): ConnectorStatus {
    return this.currentStatus;
  }

  get statusDetail(): string | undefined {
    return this.lastDetail;
  }

  /** The Provider API while registered, otherwise undefined. */
  getApi(): AIEcosystemAPI | undefined {
    return this.api;
  }

  isConnected(): boolean {
    return this.api !== undefined;
  }

  /** Call from onload(). Safe to call before the AI Ecosystem has loaded. */
  start(): void {
    const { app } = this.plugin;
    const workspace = app.workspace as unknown as WorkspaceEvents;

    // Obsidian does not guarantee the plugin load order, so wait for the layout first.
    app.workspace.onLayoutReady(() => {
      if (this.stopped) return;
      const api = this.findApi();
      if (api?.isReady()) {
        this.connect(api);
      } else if (api) {
        // Installed and enabled, but still starting: the "ready" event registers us.
        this.setStatus("waiting");
      } else {
        this.setStatus("missing");
        this.options.onMissing?.();
      }
    });

    // Fires on every load of the AI Ecosystem, including reloads: register again each time.
    this.plugin.registerEvent(workspace.on(ECOSYSTEM_EVENTS.ready, (api) => this.connect(api as AIEcosystemAPI)));

    // The AI Ecosystem drops the registration by itself when it unloads.
    this.plugin.registerEvent(
      workspace.on(ECOSYSTEM_EVENTS.unloading, () => {
        if (this.stopped) return;
        this.api = undefined;
        this.setStatus("disconnected");
        this.options.onDisconnected?.();
      }),
    );
  }

  /** Call from onunload(). Removes the module (and its services) from the AI Ecosystem. */
  stop(): void {
    this.stopped = true;
    if (this.api && this.moduleId) {
      try {
        this.api.unregisterModule(this.moduleId);
      } catch {
        // The AI Ecosystem may already be gone; nothing to clean up.
      }
    }
    this.api = undefined;
  }

  private findApi(): AIEcosystemAPI | undefined {
    const plugins = (this.plugin.app as unknown as {
      plugins?: { getPlugin(id: string): { api?: AIEcosystemAPI } | null };
    }).plugins;
    return plugins?.getPlugin(ECOSYSTEM_ID)?.api;
  }

  private setStatus(status: ConnectorStatus, detail?: string): void {
    this.currentStatus = status;
    this.lastDetail = detail;
    this.options.onStatus?.(status, detail);
  }

  private connect(api: AIEcosystemAPI): void {
    if (this.stopped) return;
    const registration = this.options.buildRegistration();
    this.moduleId = registration.id;

    const result = api.registerModule(registration);
    if (!result.ok) {
      this.api = undefined;
      this.setStatus("incompatible", result.reason);
      this.options.onIncompatible?.(result.reason);
      return;
    }

    this.api = api;
    this.setStatus("connected");
    this.options.onConnected?.(api);
  }
}
