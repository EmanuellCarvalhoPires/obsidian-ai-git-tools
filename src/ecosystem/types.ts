// Public contracts of the AI Ecosystem plugin that a module needs.
//
// Vendored from obsidian-ai-ecosystem (src/types/index.ts, Provider API version 1).
// A module must not depend on the AI Ecosystem source, so this file is a copy of the
// public part only: keep it in sync with the AI Ecosystem whenever AI_ECOSYSTEM_API_VERSION
// changes or a contract below is extended. Do not add module-specific code here.

/** Provider API version implemented by the AI Ecosystem this file was copied from. */
export const AI_ECOSYSTEM_API_VERSION = 1;

/** Plugin id of the AI Ecosystem. */
export const ECOSYSTEM_ID = "ai-ecosystem";

/**
 * Workspace events (app.workspace.trigger / app.workspace.on).
 * - ready: the Provider API accepts registrations. Payload: AIEcosystemAPI. Fired on every
 *   load of the AI Ecosystem, so modules register again after a reload.
 * - unloading: the AI Ecosystem is being disabled or reloaded. No payload. Modules mark
 *   themselves as disconnected and wait for the next "ready".
 * - module-registered / module-unregistered: payload is the module id.
 * - service-changed: payload is (serviceName, available).
 * - server-status: payload is the server status.
 */
export const ECOSYSTEM_EVENTS = {
  ready: "ai-ecosystem:ready",
  unloading: "ai-ecosystem:unloading",
  moduleRegistered: "ai-ecosystem:module-registered",
  moduleUnregistered: "ai-ecosystem:module-unregistered",
  serviceChanged: "ai-ecosystem:service-changed",
  serverStatus: "ai-ecosystem:server-status",
} as const;

// ---------------------------------------------------------------------------
// Clients (who called)
// ---------------------------------------------------------------------------

/** The authenticated caller of an HTTP route, MCP tool or prompt. */
export interface ClientContext {
  id: string;
  /** Display name, e.g. "Claude Code". */
  name: string;
}

// ---------------------------------------------------------------------------
// HTTP routes
// ---------------------------------------------------------------------------

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface HubRequest {
  method: HttpMethod;
  /** Path relative to the module prefix, starting with "/" (for /api/v1/my-module/items/1 it is "/items/1"). */
  path: string;
  /** Full request path, without the query string. */
  fullPath: string;
  /** Values of ":name" segments of the route pattern. */
  params: Record<string, string>;
  /** Query string values (last value wins). */
  query: Record<string, string>;
  /** Request headers with lowercase names. The Authorization header is removed. */
  headers: Record<string, string>;
  /** Parsed JSON body when Content-Type is JSON, otherwise the raw text ("" when empty). */
  body: unknown;
  rawBody: string;
  client: ClientContext;
}

export interface HubResponse {
  status: number;
  headers?: Record<string, string>;
  /** Objects and arrays are sent as JSON; strings as text/plain unless a Content-Type is set. */
  body?: unknown;
}

export interface HubRoute {
  method: HttpMethod;
  /** Module route: path relative to /api/v1/<module-id>, e.g. "/render" or "/items/:id". */
  path: string;
  description?: string;
  handler: (req: HubRequest) => Promise<HubResponse> | HubResponse;
}

// ---------------------------------------------------------------------------
// MCP tools and prompts
// ---------------------------------------------------------------------------

export type HubToolContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

export interface HubToolResult {
  content: HubToolContent[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export interface HubCallContext {
  client: ClientContext;
  /** Module that owns the tool or prompt. */
  moduleId: string;
  /** Aborted when the client cancels the call or closes the connection. */
  signal?: AbortSignal;
  /** Detected from the MCP client name. */
  clientKind?: "claude-code" | "antigravity" | "other";
}

export interface HubTool {
  /** Unique across all modules. */
  name: string;
  title?: string;
  description: string;
  /** JSON Schema of the arguments (type "object"). */
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: {
    title?: string;
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
  /** Stays visible while the module still waits for its guided setup. */
  availableDuringSetup?: boolean;
  handler: (args: Record<string, unknown>, ctx: HubCallContext) => Promise<HubToolResult>;
}

export interface HubPromptMessage {
  role: "user" | "assistant";
  content: { type: "text"; text: string };
}

export interface HubPrompt {
  /** Unique across all modules. */
  name: string;
  title?: string;
  description?: string;
  arguments?: Array<{ name: string; description?: string; required?: boolean }>;
  handler: (
    args: Record<string, string>,
    ctx: HubCallContext,
  ) => Promise<{ description?: string; messages: HubPromptMessage[] }>;
}

// ---------------------------------------------------------------------------
// Modules
// ---------------------------------------------------------------------------

export interface HubModuleRegistration {
  /** Plugin id of the module. Lowercase letters, digits and "-". */
  id: string;
  name: string;
  version: string;
  /** Provider API version the module was written for. */
  apiVersion: number;
  routes?: HubRoute[];
  /** Routes at the root, for backward compatibility. */
  legacyAliases?: HubRoute[];
  tools?: HubTool[];
  prompts?: HubPrompt[];
  /** Text appended to the MCP server instructions sent on "initialize". Plain text, a few sentences. */
  instructions?: string;
  /** Called when the AI Ecosystem drops the module (unregister or AI Ecosystem unload). */
  onUnload?: () => void;
}

/** Name of the service Environment Keys registers. */
export const SECRETS_SERVICE = "secrets";

/** One authenticated HTTP request through Environment Keys. Placeholders ({{bearer:NAME}}...) go in headers. */
export interface SecretRequest {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  url: string;
  headers?: Record<string, string>;
  /** A string is sent as is; an object is sent as JSON with Content-Type application/json. */
  body?: string | Record<string, unknown>;
  timeoutMs?: number;
  /** Sends a string body exactly as given: placeholders in it are not resolved, and a body with a stored secret value is refused. */
  rawBody?: boolean;
}

export interface SecretResponse {
  status: number;
  /** Header names in lower case. */
  headers: Record<string, string>;
  body: string;
}

export type SecretType = "token" | "basic" | "bearer" | "header" | "env";

/** What Environment Keys (2.2.0+) tells about a secret: never the value, the id or the username. */
export interface SecretInfo {
  name: string;
  type: SecretType;
  hasUsername: boolean;
  allowedHosts: string[];
  allowAnyHost: boolean;
  approval: "never" | "writes" | "always";
}

export interface SecretVaultService {
  isLocked?(): boolean;
  /**
   * Sends the request with the placeholders resolved and the answer redacted. Rejects with
   * `VaultLockedError` (vault locked) or `PolicyError` (with a `code`: unknown_secret,
   * host_not_allowed, insecure_scheme, placement_not_allowed, secret_not_permitted,
   * invalid_placeholder).
   */
  request(req: SecretRequest, callerModuleId: string): Promise<SecretResponse>;
  /** Replaces the values of known secrets and values with [REDACTED]. */
  redact(text: string): string;
  /** Resolves {{secret:NAME}} of VALUES (not secrets) inside template data. */
  resolveTemplateData?(data: unknown, callerModuleId: string): Promise<unknown>;
  /** Names, types and hosts of the secrets, without values. Environment Keys 2.2.0 or newer; rejects with `VaultLockedError` while locked. */
  listSecretMetadata?(callerModuleId: string): Promise<SecretInfo[]>;
}

/** Name of the service the AI Ecosystem registers for hooks and guided setup. */
export const HOOKS_SERVICE = "hooks";

export interface HookRuleData {
  /** environment-variables: allowed host patterns of secrets WITHOUT full access / any host. */
  hosts?: string[];
  /** ai-scripts: vault-relative folders whose scripts must run through the plugin. */
  scriptFolders?: string[];
  /** ai-templates: vault-relative target path patterns of the templates ({{...}} becomes *). */
  templateTargets?: string[];
  /** environment-variables: vault-relative folders of tool notes (Grep stays allowed there). */
  toolNoteFolders?: string[];
}

export interface SetupHandler {
  /** Facts the module detects by itself (never secret values). */
  detect?(): Promise<Record<string, unknown>>;
  /** Applies one answer. Returns an error message to refuse it. */
  save?(key: string, value: unknown): Promise<string | void>;
  /** Called by ecosystem_setup_complete. ok:false blocks completion and lists what is missing. */
  validate?(): Promise<{ ok: boolean; missing?: string[] }>;
}

export interface HooksService {
  setRuleData(moduleId: string, data: HookRuleData): void;
  /** Returns an unregister function. */
  registerSetupHandler(moduleId: string, handler: SetupHandler): () => void;
  getModuleState(moduleId: string): "pendente_configuracao" | "configurado" | "desativado" | undefined;
}

export type RegisterResult = { ok: true; warnings?: string[] } | { ok: false; reason: string };

// ---------------------------------------------------------------------------
// Service Bus
// ---------------------------------------------------------------------------

export type ServiceChangeListener = (name: string, available: boolean) => void;

// ---------------------------------------------------------------------------
// Provider API (what modules call)
// ---------------------------------------------------------------------------

/**
 * The Provider API. The AI Ecosystem also has `importClients` and `runScript`, which this
 * module does not use and which are left out of this copy on purpose.
 */
export interface AIEcosystemAPI {
  readonly apiVersion: number;
  isReady(): boolean;

  registerModule(module: HubModuleRegistration): RegisterResult;
  unregisterModule(moduleId: string): boolean;
  /** Replaces the tools of a registered module (dynamic tools). */
  updateTools(moduleId: string, tools: HubTool[]): void;
  /** Replaces the prompts of a registered module. */
  updatePrompts(moduleId: string, prompts: HubPrompt[]): void;

  /** Throws when the owner is not registered or another module owns the name. */
  registerService<T>(serviceName: string, ownerModuleId: string, instance: T): void;
  unregisterService(serviceName: string): void;
  getService<T>(serviceName: string): T | undefined;
  /** Returns an unsubscribe function. */
  onServiceChange(cb: ServiceChangeListener): () => void;

  logActivity(entry: {
    moduleId: string;
    client?: string;
    type: string;
    target: string;
    status: number;
    durationMs: number;
    payload?: unknown;
    response?: unknown;
    output?: string;
    alert?: boolean;
  }): void;

  getServerStatus(): { running: boolean; port: number; activeModules: string[] };
}
