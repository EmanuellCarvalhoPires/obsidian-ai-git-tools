import "./shim";
// Entrada "app" do AI Git Tools: roda como processo filho do app AI Ecosystem 2.0 e fala JSON-RPC 2.0 por stdio.
import * as fs from "fs";
import * as path from "path";
import { NodeVaultPort } from "../adapters/node-vault";
import { createNodeFileAdapter } from "../adapters/node-file-adapter";
import { createNodeGit } from "../core/git-runner";
import { CheckpointStore, createFileStorage } from "../core/history/checkpoints";
import { HistoryService } from "../core/history/history-service";
import { ProjectTracker } from "../core/history/project-tracker";
import { Recorder } from "../core/history/recorder";
import { RemoteSync, createProviderResolver } from "../core/history/remote-sync";
import { HistoryWatcher } from "../core/history/watcher";
import { createRemoteCache } from "../core/repo-resolver";
import { createSecureHttp } from "../core/providers/http";
import type { SecretsGetter } from "../core/providers/secrets";
import type { SecureHttp } from "../core/ports";
import type { HubTool, HubToolResult } from "../ecosystem/types";
import { buildGitTools } from "../tools/git-tools";
import type { GitToolDeps } from "../tools/git-tools";
import { normalizeSettings } from "../types";
import type { Settings } from "../types";
import { RpcChannel, RpcRemoteError } from "./rpc";
import { createSecretsProxy } from "./secrets-proxy";

declare const __PLUGIN_VERSION__: string;

const MODULE_ID = "ai-git-tools";
const PROTOCOL = 1;

type Route = "plugin" | "sombra" | "servico";

/** Tudo o que existe depois de "inicializar". */
interface Runtime {
  tools: Map<string, HubTool>;
  watcher: HistoryWatcher;
  remoteSync: RemoteSync;
}

let route: Route = "plugin";
let settings: Settings = normalizeSettings({});
let runtime: Runtime | undefined;
const calls = new Map<number, AbortController>();

function log(message: string): void {
  process.stderr.write(`[AI Git Tools app] ${message}\n`);
}

function isRoute(value: unknown): value is Route {
  return value === "plugin" || value === "sombra" || value === "servico";
}

/** Só as leituras comparáveis entram na sombra; git_graph e git_pipeline_aguardar não (escrevem notas / demoram). */
function compareInShadow(tool: HubTool): boolean {
  return (tool.efeito ?? "externo") === "leitura" && !["git_graph", "git_pipeline_aguardar"].includes(tool.name);
}

function readSettings(stateDir: string): Settings {
  try {
    return normalizeSettings(JSON.parse(fs.readFileSync(path.join(stateDir, "config.json"), "utf8")) as unknown);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") log(`config.json ilegível, usando o padrão: ${String(err)}`);
    return normalizeSettings({});
  }
}

/** Liga o watcher e o RemoteSync só na rota "servico" (as automações gravam notas e só rodam num lugar). */
function refreshAutomation(): void {
  if (!runtime) return;
  const { watcher, remoteSync } = runtime;
  if (route === "servico") {
    if (settings.watch) void watcher.start().catch((err: unknown) => log(`watcher: ${String(err)}`));
    else watcher.stop();
    if (settings.remotePolling) remoteSync.start();
    else remoteSync.stop();
  } else {
    watcher.stop();
    remoteSync.stop();
  }
}

function stopAutomation(): void {
  runtime?.watcher.stop();
  runtime?.remoteSync.stop();
}

const rpc: RpcChannel = new RpcChannel(process.stdin, process.stdout, {
  onRequest: (method, params, id) => handleRequest(method, params, id),
  onNotification: (method, params) => handleNotification(method, params),
  onClose: () => {
    stopAutomation();
    process.exit(0);
  },
});

async function initialize(params: unknown): Promise<unknown> {
  const p = (typeof params === "object" && params !== null ? params : {}) as Record<string, unknown>;
  if (typeof p.pasta_cofre !== "string" || typeof p.pasta_estado !== "string") {
    throw new RpcRemoteError(-32602, "inicializar exige pasta_cofre e pasta_estado");
  }
  stopAutomation();
  const vaultDir = p.pasta_cofre;
  const stateDir = p.pasta_estado;
  route = isRoute(p.rota) ? p.rota : "plugin";
  settings = readSettings(stateDir);

  // Os segredos ficam no app: o filho só tem o proxy (nunca recebe valor secreto).
  const secrets = createSecretsProxy(rpc);
  const getSecrets: SecretsGetter = () => secrets;
  const http: SecureHttp = createSecureHttp(getSecrets);

  const git = createNodeGit();
  const vault = new NodeVaultPort(vaultDir);
  const projects = new ProjectTracker(vault, () => settings, { cacheMs: 60_000 });
  const checkpoints = await CheckpointStore.open(createFileStorage(createNodeFileAdapter(), path.join(stateDir, "checkpoints.json")));
  const history = new HistoryService(git, vault, checkpoints, () => settings);
  const recorder = new Recorder({ history, projects, git });
  const watcher = new HistoryWatcher({ history, projects });
  const remoteSync = new RemoteSync({
    history,
    projects,
    git,
    settings: () => settings,
    providerFor: createProviderResolver({ settings: () => settings, getSecrets, http }),
  });
  const gitDeps: GitToolDeps = {
    git,
    projects,
    allowedFolders: () => settings.allowedFolders,
    allowAnyFolder: () => settings.allowAnyFolder,
    settings: () => settings,
    redact: (text) => secrets.redact(text),
    getSecrets,
    http,
    recorder,
    history,
    tracker: projects,
    remoteSync,
    remoteCache: createRemoteCache(),
    onPipelineFinished: (info) => notifyPipeline(info),
  };
  const tools = buildGitTools(gitDeps);
  runtime = { tools: new Map(tools.map((t) => [t.name, t])), watcher, remoteSync };
  refreshAutomation();

  return {
    protocolo: PROTOCOL,
    versao: __PLUGIN_VERSION__,
    tools: tools.map((t) => ({
      id: t.name,
      titulo: t.title,
      descricao: t.description,
      resumo: t.resumo,
      categoria: t.categoria,
      efeito: t.efeito ?? "externo",
      exposicao: t.exposicao,
      schema: t.inputSchema,
      comparar_na_sombra: compareInShadow(t),
    })),
  };
}

/** Avisa no Telegram (barramento do app) que o pipeline terminou. Só na rota "servico"; uma falha nunca derruba a tool. */
function notifyPipeline(info: Parameters<NonNullable<GitToolDeps["onPipelineFinished"]>>[0]): void {
  if (route !== "servico") return;
  const duracao = info.duracaoSegundos !== null ? ` em ${info.duracaoSegundos}s` : "";
  const mensagem = `Pipeline ${info.estado} em ${path.basename(info.repo)} (${info.branch})${duracao}: ${info.url}`;
  void rpc.request("barramento/telegram", { mensagem, urgente: false }, 30_000).catch((e: unknown) => {
    rpc.notify("inspector/registrar", { evento: "aviso_pipeline_falhou", detalhe: String((e as { message?: unknown } | null)?.message ?? e) });
  });
}

function errorResult(text: string): HubToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

async function callTool(id: number, params: unknown): Promise<HubToolResult> {
  if (!runtime) throw new RpcRemoteError(-32000, "Plugin não inicializado", { codigo: "nao_inicializado" });
  const p = (typeof params === "object" && params !== null ? params : {}) as Record<string, unknown>;
  const name = typeof p.tool === "string" ? p.tool : "";
  const tool = runtime.tools.get(name);
  if (!tool) return errorResult(`Tool desconhecida: ${name}`);
  const args = (typeof p.args === "object" && p.args !== null ? p.args : {}) as Record<string, unknown>;
  const ctx = (typeof p.contexto === "object" && p.contexto !== null ? p.contexto : {}) as { agente?: unknown };
  const agent = typeof ctx.agente === "string" ? ctx.agente : "desconhecido";
  const controller = new AbortController();
  calls.set(id, controller);
  try {
    return await tool.handler(args, { client: { id: agent, name: agent }, moduleId: MODULE_ID, signal: controller.signal });
  } catch (err) {
    return errorResult(err instanceof Error ? err.message : String(err));
  } finally {
    calls.delete(id);
  }
}

async function handleRequest(method: string, params: unknown, id: number): Promise<unknown> {
  switch (method) {
    case "inicializar":
      return initialize(params);
    case "tools/chamar":
      return callTool(id, params);
    case "encerrar":
      stopAutomation();
      setTimeout(() => process.exit(0), 50);
      return {};
    default:
      throw new RpcRemoteError(-32601, `Método desconhecido: ${method}`);
  }
}

function handleNotification(method: string, params: unknown): void {
  const p = (typeof params === "object" && params !== null ? params : {}) as Record<string, unknown>;
  switch (method) {
    case "cancelar":
      if (typeof p.id_chamada === "number") calls.get(p.id_chamada)?.abort();
      return;
    case "rota/mudou":
      if (isRoute(p.rota)) {
        route = p.rota;
        refreshAutomation();
      }
      return;
    case "sessao/encerrada":
    default:
      return;
  }
}

process.on("uncaughtException", (err) => {
  process.stderr.write(`[AI Git Tools app] uncaughtException: ${err.stack ?? err.message}\n`);
  process.exit(1);
});
