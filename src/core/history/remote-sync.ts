// Pull requests and deploys of the remote (GitHub or Bitbucket) as event notes. Port of the idea of
// `remote.ts` of the AI Log Manager, on top of the provider layer of this plugin (Fase 4): the
// secrets stay inside Environment Keys, this file only holds their names.
//
// Every `remoteIntervalMin` minutes, for each project whose clone has a GitHub or Bitbucket remote AND
// whose provider has a secret chosen in the settings:
//   - the recent pull requests (state "todos", the newest 20) are compared with what was seen: a PR
//     that is new, or whose state changed (open -> merged), becomes `pr-<host>-<repo>-<n>` through
//     `HistoryService.recordRemote` (which also brings the state of an existing note up to date);
//   - the recent pipelines of the default branch (the newest 10) that ended with success are
//     deploys: `deploy-<host>-<repo>-<run id or uuid>` (the id format of the AI Log Manager), with the
//     branch as the environment.
// The first read of a project is its baseline: everything that exists is only marked as seen, no
// notes. Later, something that was never seen is recorded only if it was created after the baseline
// (an old PR that comes back into the window is not an event). The marks live in the `prStates` of
// the project in the checkpoints (id -> last known state; the key REMOTE_BASELINE_KEY holds the time
// of the baseline). Failures (network, locked vault, missing secret) never break anything: they are
// logged and tried again at the next tick.
import { gitRemoteInfo } from "../git/remote-info";
import type { GitRunner, ProjectInfo, ProjectLookup, SecureHttp } from "../ports";
import { createBitbucketProvider } from "../providers/bitbucket";
import { createGithubProvider } from "../providers/github";
import { createSecureHttp } from "../providers/http";
import { parseRemoteUrl } from "../providers/provider";
import type { GitProvider, PipelineInfo, PrEstado, PrInfo, ProviderContext, ProviderFactory, ProviderId, RemoteRef } from "../providers/provider";
import { findSecret, redactWith } from "../providers/secrets";
import type { SecretsGetter } from "../providers/secrets";
import { prId } from "./events";
import type { DevEvent } from "./events";
import type { HistoryService } from "./history-service";
import type { Settings } from "../../types";

/** Key of the baseline time among the remote marks. */
export const REMOTE_BASELINE_KEY = "remote-baseline";
/** Pull requests read per project and tick. */
export const PR_LIMIT = 20;
/** Pipelines read per project and tick. */
export const PIPELINE_LIMIT = 10;

/** States of a PR in the notes (the ones of the AI Log Manager). */
const NOTE_STATE: Record<PrEstado, string> = { aberto: "open", mesclado: "merged", fechado: "declined" };

export type ProviderResolver = (ref: RemoteRef) => Promise<GitProvider | undefined>;

export interface RemoteSyncResult {
  project: string;
  /** Why nothing was read (no clone, no remote, no secret...). */
  skipped?: string;
  /** First read: only the baseline was stored. */
  baseline: boolean;
  /** Paths of the notes created by this read. */
  created: string[];
  /** Paths of the notes whose state changed (a PR that was merged). */
  updated: string[];
  errors: string[];
}

export interface RemoteSyncDeps {
  history: Pick<HistoryService, "hasBaseline" | "sync" | "remoteMarks" | "setRemoteMarks" | "recordRemote">;
  projects: Pick<ProjectLookup, "list">;
  git: GitRunner;
  settings: () => Pick<Settings, "remotePolling" | "remoteIntervalMin">;
  /** Builds the provider of a repository; undefined when its provider has no secret. See `createProviderResolver`. */
  providerFor: ProviderResolver;
  now?: () => number;
  log?: (message: string, err?: unknown) => void;
}

const DEFAULT_FACTORIES: Record<ProviderId, ProviderFactory> = { github: createGithubProvider, bitbucket: createBitbucketProvider };

export interface ProviderResolverDeps {
  settings: () => Pick<Settings, "secretGithub" | "secretBitbucket">;
  getSecrets: SecretsGetter;
  /** Default: `createSecureHttp(getSecrets)`. */
  http?: SecureHttp;
  /** Tests replace the implementation of a provider. */
  factories?: Partial<Record<ProviderId, ProviderFactory>>;
}

/**
 * The provider of a repository for the polling: undefined when no secret is chosen for the provider,
 * when Environment Keys is not there or when its vault is locked (nothing is asked then).
 */
export function createProviderResolver(deps: ProviderResolverDeps): ProviderResolver {
  return async (ref) => {
    const s = deps.settings();
    const secretName = (ref.provider === "github" ? s.secretGithub : s.secretBitbucket).trim();
    if (secretName === "") return undefined;
    const service = deps.getSecrets();
    if (!service) return undefined;
    try {
      if (service.isLocked?.() === true) return undefined;
    } catch {
      return undefined;
    }
    const secretInfo = await findSecret(deps.getSecrets, secretName);
    const ctx: ProviderContext = {
      http: deps.http ?? createSecureHttp(deps.getSecrets),
      ref,
      secretName,
      redact: (text) => redactWith(deps.getSecrets, text),
      ...(secretInfo ? { secretInfo } : {}),
    };
    return (deps.factories?.[ref.provider] ?? DEFAULT_FACTORIES[ref.provider])(ctx);
  };
}

const defaultLog = (message: string, err?: unknown): void => {
  console.debug(`[AI Git Tools] ${message}`, err ?? "");
};

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** `deploy-<host>-<owner/repo>-<id>`; the braces of a Bitbucket uuid are dropped (like the AI Log Manager). */
export function deployId(ref: RemoteRef, runId: string): string {
  return `deploy-${ref.provider}-${ref.repo}-${runId.replace(/[{}]/g, "")}`;
}

export class RemoteSync {
  private timer: number | undefined;
  private ticking: Promise<RemoteSyncResult[]> | undefined;

  constructor(private readonly deps: RemoteSyncDeps) {}

  get active(): boolean {
    return this.timer !== undefined;
  }

  /** Starts the polling: a first read now and one every `remoteIntervalMin` minutes. Idempotent. */
  start(): void {
    if (this.timer !== undefined) return;
    const minutes = this.deps.settings().remoteIntervalMin;
    const ms = Math.max(1, minutes > 0 ? minutes : 10) * 60_000;
    this.timer = window.setInterval(() => void this.tick(), ms);
    void this.tick();
  }

  stop(): void {
    if (this.timer !== undefined) window.clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Reads the remote of every project once. Reads that overlap share one run. Does nothing when `remotePolling` is off. */
  tick(): Promise<RemoteSyncResult[]> {
    this.ticking ??= this.tickNow().finally(() => {
      this.ticking = undefined;
    });
    return this.ticking;
  }

  /** Reads the remote of one project once (the same work of a tick, without looking at `remotePolling`). Never throws. */
  async syncProject(project: ProjectInfo): Promise<RemoteSyncResult> {
    const result: RemoteSyncResult = { project: project.name, baseline: false, created: [], updated: [], errors: [] };
    try {
      await this.readProject(project, result);
    } catch (err) {
      result.errors.push(message(err));
      this.log(`remote read of ${project.name} failed`, err);
    }
    return result;
  }

  // ---------------------------------------------------------------- internals

  private log(msg: string, err?: unknown): void {
    (this.deps.log ?? defaultLog)(msg, err);
  }

  private async tickNow(): Promise<RemoteSyncResult[]> {
    if (!this.deps.settings().remotePolling) return [];
    let projects: ProjectInfo[];
    try {
      projects = await this.deps.projects.list();
    } catch (err) {
      this.log("could not list the projects", err);
      return [];
    }
    const out: RemoteSyncResult[] = [];
    for (const project of projects) {
      if (project.clonePath) out.push(await this.syncProject(project));
    }
    return out;
  }

  private async readProject(project: ProjectInfo, result: RemoteSyncResult): Promise<void> {
    const { history, git } = this.deps;
    const clone = project.clonePath;
    if (!clone) {
      result.skipped = "sem clone";
      return;
    }
    const remote = await readRemote(git, clone);
    if (!remote) {
      result.skipped = "sem remoto do GitHub ou do Bitbucket";
      return;
    }
    const provider = await this.deps.providerFor(remote.ref);
    if (!provider) {
      result.skipped = `sem secret para o ${remote.ref.provider}`;
      return;
    }
    // The git baseline comes first: remote marks live in the same state, and a project never seen
    // by the sync would otherwise be read from the beginning of its history.
    if (!history.hasBaseline(project)) await history.sync(project);
    const marks = history.remoteMarks(project);
    if (!marks) {
      result.skipped = "o projeto ainda não tem linha de base do git";
      return;
    }
    const baselineAt = marks[REMOTE_BASELINE_KEY];
    const first = baselineAt === undefined;
    const baselineMs = first ? 0 : Date.parse(baselineAt);
    const nowIso = new Date((this.deps.now ?? Date.now)()).toISOString();
    const newMarks: Record<string, string> = {};
    let read = false;

    const isNew = (createdAt: string): boolean => {
      const t = Date.parse(createdAt);
      return !first && Number.isFinite(t) && t >= baselineMs;
    };

    // ---- pull requests
    try {
      const prs = await provider.listarPrs({ estado: "todos", limite: PR_LIMIT });
      read = true;
      // Oldest first, so the notes appear in the order things happened.
      for (const pr of [...prs.itens].reverse()) {
        const id = prId(remote.ref.provider, remote.ref.repo, pr.numero);
        const estado = NOTE_STATE[pr.estado];
        const seen = marks[id];
        const record = !first && (seen !== undefined ? seen !== estado : isNew(pr.criadoEm));
        newMarks[id] = estado;
        if (!record) continue;
        const r = await history.recordRemote(project, prEvent(project, pr, id, estado));
        if (r.created) result.created.push(r.path);
        else if (r.updated) result.updated.push(r.path);
      }
    } catch (err) {
      result.errors.push(`PRs: ${message(err)}`);
      this.log(`could not read the pull requests of ${project.name}`, err);
    }

    // ---- deploys: pipelines of the default branch that ended with success
    try {
      const branch = await defaultBranch(git, clone, remote.name);
      if (branch !== undefined) {
        const runs = await provider.statusPipelines({ branch, limite: PIPELINE_LIMIT, incluirSteps: false });
        read = true;
        for (const run of [...runs.itens].reverse()) {
          if (run.estado !== "sucesso" || run.id === "") continue;
          const id = deployId(remote.ref, run.id);
          const seen = marks[id] !== undefined;
          newMarks[id] = "sucesso";
          if (first || seen || !isNew(run.criadoEm)) continue;
          const r = await history.recordRemote(project, deployEvent(project, run, id));
          if (r.created) result.created.push(r.path);
        }
      }
    } catch (err) {
      result.errors.push(`Pipelines: ${message(err)}`);
      this.log(`could not read the pipelines of ${project.name}`, err);
    }

    // The baseline only counts when something was really read; otherwise the next tick is the first.
    if (read) {
      if (first) {
        result.baseline = true;
        newMarks[REMOTE_BASELINE_KEY] = nowIso;
      }
      history.setRemoteMarks(project, newMarks);
    }
  }
}

function prEvent(project: ProjectInfo, pr: PrInfo, id: string, estado: string): DevEvent {
  const created = Date.parse(pr.criadoEm);
  return {
    tipo: "pr",
    projeto: project.name,
    id,
    titulo: pr.titulo !== "" ? pr.titulo : `PR ${pr.numero}`,
    data: Number.isFinite(created) ? new Date(created) : new Date(),
    ...(pr.origem !== "" ? { branch: pr.origem } : {}),
    ...(pr.headSha !== undefined && pr.headSha !== "" ? { hash: pr.headSha } : {}),
    ...(pr.url !== "" ? { url: pr.url } : {}),
    ...(pr.autor !== "" ? { autor: pr.autor } : {}),
    estado,
    ...(pr.origem !== "" && pr.destino !== "" ? { detalhes: `Origem \`${pr.origem}\` para \`${pr.destino}\`.` } : {}),
  };
}

function deployEvent(project: ProjectInfo, run: PipelineInfo, id: string): DevEvent {
  const created = Date.parse(run.criadoEm);
  const short = run.commit.slice(0, 7);
  return {
    tipo: "deploy",
    projeto: project.name,
    id,
    titulo: `${run.branch !== "" ? run.branch : "pipeline"}${short !== "" ? ` ${short}` : ""}`,
    data: Number.isFinite(created) ? new Date(created) : new Date(),
    ...(run.branch !== "" ? { branch: run.branch, ambiente: run.branch } : {}),
    ...(run.commit !== "" ? { hash: run.commit } : {}),
    ...(run.url !== "" ? { url: run.url } : {}),
    estado: "sucesso",
  };
}

/** The remote of a clone (`origin`, or the first one) when it is on GitHub or Bitbucket. */
async function readRemote(git: GitRunner, clone: string): Promise<{ name: string; ref: RemoteRef } | undefined> {
  try {
    const names = (await git(clone, ["remote"])).split(/\r?\n/).map((s) => s.trim()).filter((s) => s !== "");
    const name = names.includes("origin") ? "origin" : names[0];
    if (!name) return undefined;
    const ref = parseRemoteUrl((await git(clone, ["remote", "get-url", name])).trim());
    return ref ? { name, ref } : undefined;
  } catch {
    return undefined;
  }
}

/** Default branch of the remote: `refs/remotes/<remote>/HEAD`, else main, else master. */
async function defaultBranch(git: GitRunner, clone: string, remote: string): Promise<string | undefined> {
  try {
    const info = await gitRemoteInfo(git, clone, { secrets: { github: false, bitbucket: false } });
    if (info.branchPadrao !== undefined) return info.branchPadrao;
  } catch {
    // fall through to the common names
  }
  for (const name of ["main", "master"]) {
    try {
      await git(clone, ["rev-parse", "--verify", "-q", `refs/remotes/${remote}/${name}`]);
      return name;
    } catch {
      // not there
    }
  }
  return undefined;
}
