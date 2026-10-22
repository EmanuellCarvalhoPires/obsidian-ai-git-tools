// Dependencies and a caller for the tool tests (shared by the read, write and provider tools).
import { createNodeGit } from "../../src/core/git-runner";
import type { GitRunner, ProjectInfo, ProjectLookup, SecureHttp } from "../../src/core/ports";
import type { HistoryService } from "../../src/core/history/history-service";
import type { ToolRecorder } from "../../src/core/history/recorder";
import type { ProviderFactory, ProviderId } from "../../src/core/providers/provider";
import type { SecretsGetter } from "../../src/core/providers/secrets";
import { isInside } from "../../src/core/repo-resolver";
import type { HubCallContext, HubTool, HubToolResult } from "../../src/ecosystem/types";
import type { GitToolDeps } from "../../src/tools/git-tools";
import { DEFAULT_SETTINGS } from "../../src/types";
import type { Settings } from "../../src/types";

export function lookupOf(projects: ProjectInfo[]): ProjectLookup {
  return {
    list: () => Promise.resolve(projects),
    byName: (name) => Promise.resolve(projects.find((p) => p.name.toLowerCase() === name.toLowerCase())),
    byClone: (path) => Promise.resolve(projects.find((p) => p.clonePath !== undefined && isInside(p.clonePath, path))),
  };
}

export interface MakeDepsOptions {
  /** Projects of the vault: name and clone. */
  projects?: { name: string; clone: string }[];
  allowed?: string[];
  settings?: Partial<Settings>;
  redact?: (text: string) => string;
  /** Replaces the real git runner (e.g. to point `ls-remote` at a local bare repository). */
  git?: GitRunner;
  /** Fake `secrets` service for the provider tools. */
  getSecrets?: SecretsGetter;
  http?: SecureHttp;
  providerFactories?: Partial<Record<ProviderId, ProviderFactory>>;
  /** Documents what the tools do as event notes (Fase 5). */
  recorder?: ToolRecorder;
  /** History of the projects: turns on the documentation tools. */
  history?: HistoryService;
  tracker?: ProjectLookup;
  remoteSync?: GitToolDeps["remoteSync"];
}

export function makeDeps(opts: MakeDepsOptions = {}): GitToolDeps {
  const projects: ProjectInfo[] = (opts.projects ?? []).map((p) => ({ name: p.name, folder: `Projetos/${p.name}`, clonePath: p.clone }));
  const settings: Settings = { ...DEFAULT_SETTINGS, ...opts.settings };
  const deps: GitToolDeps = {
    git: opts.git ?? createNodeGit(),
    projects: lookupOf(projects),
    allowedFolders: () => opts.allowed ?? [],
    settings: () => settings,
  };
  if (opts.redact) deps.redact = opts.redact;
  if (opts.getSecrets) deps.getSecrets = opts.getSecrets;
  if (opts.http) deps.http = opts.http;
  if (opts.providerFactories) deps.providerFactories = opts.providerFactories;
  if (opts.recorder) deps.recorder = opts.recorder;
  if (opts.history) deps.history = opts.history;
  if (opts.tracker) deps.tracker = opts.tracker;
  if (opts.remoteSync) deps.remoteSync = opts.remoteSync;
  return deps;
}

const CTX = { client: { id: "teste", name: "Teste" }, moduleId: "ai-git-tools" } as HubCallContext;

/** Calls a tool by name, like the hub does. */
export function callTool(tools: HubTool[], name: string, args: Record<string, unknown>): Promise<HubToolResult> {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`tool ${name} não registrada`);
  return tool.handler(args, CTX);
}

/** The structuredContent of a result, typed loosely for assertions. */
export function dataOf(result: HubToolResult): Record<string, unknown> {
  return result.structuredContent ?? {};
}

export function textOf(result: HubToolResult): string {
  return result.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
}
