// The polling of pull requests and deploys: baseline, new and changed PRs, deploys, projects without a
// secret, failures. A fake provider and real repositories (the remote URL is fictitious); no network.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createNodeGit } from "../../src/core/git-runner";
import { CheckpointStore } from "../../src/core/history/checkpoints";
import { prId } from "../../src/core/history/events";
import { HistoryService } from "../../src/core/history/history-service";
import { REMOTE_BASELINE_KEY, RemoteSync, createProviderResolver, deployId } from "../../src/core/history/remote-sync";
import type { ProviderResolver } from "../../src/core/history/remote-sync";
import type { GitRunner, ProjectInfo } from "../../src/core/ports";
import type { GitProvider, PipelineInfo, PrInfo, ProviderContext, RemoteRef } from "../../src/core/providers/provider";
import { cleanupTemp, makeRepo, sh } from "../helpers/git-repos";
import { MemoryVault } from "../helpers/memory-ports";
import { makeFakeSecrets, secretInfo } from "../helpers/fake-secrets";
import { DEFAULT_SETTINGS } from "../../src/types";
import type { Settings } from "../../src/types";

afterAll(cleanupTemp);

const REF: RemoteRef = { provider: "github", owner: "o", slug: "r", repo: "o/r" };
const HASH = "c".repeat(40);

const pr = (numero: number, estado: PrInfo["estado"], criadoEm: string, over: Partial<PrInfo> = {}): PrInfo => ({
  numero,
  titulo: `PR numero ${numero}`,
  estado,
  origem: `feature/p${numero}`,
  destino: "main",
  url: `https://github.com/o/r/pull/${numero}`,
  autor: "ana",
  criadoEm,
  headSha: "a".repeat(40),
  ...over,
});

const run = (id: string, estado: PipelineInfo["estado"], criadoEm: string, over: Partial<PipelineInfo> = {}): PipelineInfo => ({
  id,
  estado,
  branch: "main",
  commit: HASH,
  url: `https://github.com/o/r/actions/runs/${id}`,
  criadoEm,
  steps: [],
  ...over,
});

class FakeProvider {
  prs: PrInfo[] = [];
  runs: PipelineInfo[] = [];
  prError: Error | undefined;
  runError: Error | undefined;
  listarPrs = vi.fn(async (_p: unknown) => {
    if (this.prError) throw this.prError;
    return { itens: this.prs, truncado: false };
  });
  statusPipelines = vi.fn(async (_p: unknown) => {
    if (this.runError) throw this.runError;
    return { itens: this.runs, truncado: false };
  });
  asProvider(): GitProvider {
    return { id: "github", listarPrs: this.listarPrs, statusPipelines: this.statusPipelines } as unknown as GitProvider;
  }
}

interface Env {
  repo: string;
  vault: MemoryVault;
  store: CheckpointStore;
  history: HistoryService;
  project: ProjectInfo;
  provider: FakeProvider;
  remote: RemoteSync;
  settings: Settings;
  providerFor: ReturnType<typeof vi.fn>;
  clock: { now: number };
  log: ReturnType<typeof vi.fn>;
}

function makeEnv(opts: { remoteUrl?: string | null; secret?: boolean; mainRef?: boolean } = {}): Env {
  const repo = makeRepo();
  if (opts.remoteUrl !== null) sh(repo, "remote", "add", "origin", opts.remoteUrl ?? "https://github.com/o/r.git");
  if (opts.mainRef !== false) sh(repo, "update-ref", "refs/remotes/origin/main", "HEAD");
  const vault = new MemoryVault();
  const store = new CheckpointStore({ load: async () => undefined, save: async () => undefined });
  const history = new HistoryService(createNodeGit(), vault, store, () => ({ eventsFolder: "Eventos" }));
  const project: ProjectInfo = { name: "App", folder: "Projetos/App", clonePath: repo };
  const provider = new FakeProvider();
  const settings: Settings = { ...DEFAULT_SETTINGS, secretGithub: opts.secret === false ? "" : "GH_TESTE" };
  const providerFor = vi.fn(async (_ref: RemoteRef) => (opts.secret === false ? undefined : provider.asProvider()));
  const clock = { now: Date.parse("2026-10-10T12:00:00Z") };
  const log = vi.fn();
  const remote = new RemoteSync({
    history,
    projects: { list: async () => [project] },
    git: createNodeGit(),
    settings: () => settings,
    providerFor: providerFor as unknown as ProviderResolver,
    now: () => clock.now,
    log,
  });
  return { repo, vault, store, history, project, provider, remote, settings, providerFor, clock, log };
}

const BEFORE = "2026-10-01T10:00:00Z"; // before the baseline
const AFTER = "2026-10-11T10:00:00Z"; // after it
const eventNotes = (e: Env, prefix: string): string[] => [...e.vault.notes.keys()].filter((p) => p.includes(`/Eventos/${prefix}`));

describe("baseline", () => {
  it("the first read only stores what exists: no notes, and the git baseline comes first", async () => {
    const e = makeEnv();
    e.provider.prs = [pr(1, "aberto", BEFORE), pr(2, "mesclado", BEFORE)];
    e.provider.runs = [run("100", "sucesso", BEFORE)];
    expect(e.history.hasBaseline(e.project)).toBe(false);
    const res = await e.remote.syncProject(e.project);
    expect(res).toMatchObject({ project: "App", baseline: true, created: [], updated: [], errors: [] });
    expect(res.skipped).toBeUndefined();
    expect(e.history.hasBaseline(e.project)).toBe(true);
    expect(e.vault.notes.size).toBe(0);
    const marks = e.history.remoteMarks(e.project)!;
    expect(marks[REMOTE_BASELINE_KEY]).toBe("2026-10-10T12:00:00.000Z");
    expect(marks[prId("github", "o/r", 1)]).toBe("open");
    expect(marks[prId("github", "o/r", 2)]).toBe("merged");
    expect(marks[deployId(REF, "100")]).toBe("sucesso");
    // the second read finds nothing new
    const again = await e.remote.syncProject(e.project);
    expect(again).toMatchObject({ baseline: false, created: [], updated: [] });
    expect(e.vault.notes.size).toBe(0);
  });

  it("asks for the recent PRs of every state and the pipelines of the default branch", async () => {
    const e = makeEnv();
    await e.remote.syncProject(e.project);
    expect(e.provider.listarPrs).toHaveBeenCalledWith({ estado: "todos", limite: 20 });
    expect(e.provider.statusPipelines).toHaveBeenCalledWith({ branch: "main", limite: 10, incluirSteps: false });
  });

  it("a baseline that read nothing does not count: the next successful read is the baseline", async () => {
    const e = makeEnv();
    e.provider.prError = new Error("sem rede");
    e.provider.runError = new Error("sem rede");
    const failed = await e.remote.syncProject(e.project);
    expect(failed.errors).toHaveLength(2);
    expect(failed.baseline).toBe(false);
    expect(e.history.remoteMarks(e.project)?.[REMOTE_BASELINE_KEY]).toBeUndefined();
    e.provider.prError = undefined;
    e.provider.runError = undefined;
    e.provider.prs = [pr(1, "aberto", AFTER)];
    const res = await e.remote.syncProject(e.project);
    expect(res.baseline).toBe(true);
    expect(e.vault.notes.size).toBe(0);
  });
});

describe("pull requests", () => {
  it("a new PR becomes a note; a PR that was open at the baseline and is merged later becomes a note in the merged state", async () => {
    const e = makeEnv();
    e.provider.prs = [pr(1, "aberto", BEFORE)];
    await e.remote.syncProject(e.project);

    e.provider.prs = [pr(2, "aberto", AFTER), pr(1, "mesclado", BEFORE)];
    const res = await e.remote.syncProject(e.project);
    expect(res.errors).toEqual([]);
    expect(res.created).toHaveLength(2);
    const two = eventNotes(e, "PR 2 ")[0]!;
    expect(two).toBe("Projetos/App/Eventos/PR 2 - PR numero 2.md");
    expect(e.vault.notes.get(two)).toContain(`evento_id: "${prId("github", "o/r", 2)}"`);
    expect(e.vault.notes.get(two)).toContain('estado: "open"');
    expect(e.vault.notes.get(two)).toContain("| Autor | ana |");
    expect(e.vault.notes.get(eventNotes(e, "PR 1 ")[0]!)).toContain('estado: "merged"');

    // the same data again: nothing
    const again = await e.remote.syncProject(e.project);
    expect(again).toMatchObject({ created: [], updated: [] });
  });

  it("a PR whose note exists and whose state changed gets the note updated, not a second note", async () => {
    const e = makeEnv();
    await e.remote.syncProject(e.project);
    e.provider.prs = [pr(3, "aberto", AFTER)];
    await e.remote.syncProject(e.project);
    const path = eventNotes(e, "PR 3 ")[0]!;
    expect(e.vault.notes.get(path)).toContain('estado: "open"');
    e.provider.prs = [pr(3, "mesclado", AFTER)];
    const res = await e.remote.syncProject(e.project);
    expect(res.updated).toEqual([path]);
    expect(res.created).toEqual([]);
    expect(e.vault.notes.get(path)).toContain('estado: "merged"');
    expect(e.vault.notes.get(path)).toContain("| Estado | merged |");
    expect(eventNotes(e, "PR ")).toHaveLength(1);
    e.provider.prs = [pr(3, "fechado", AFTER)];
    await e.remote.syncProject(e.project);
    expect(e.vault.notes.get(path)).toContain('estado: "declined"');
  });

  it("an old PR that was never seen and comes back into the window is not an event", async () => {
    const e = makeEnv();
    await e.remote.syncProject(e.project);
    e.provider.prs = [pr(9, "mesclado", BEFORE)];
    const res = await e.remote.syncProject(e.project);
    expect(res.created).toEqual([]);
    expect(e.vault.notes.size).toBe(0);
    expect(e.history.remoteMarks(e.project)?.[prId("github", "o/r", 9)]).toBe("merged");
  });

  it("a PR already documented by a tool is recognized (no second note), and its merge updates the note", async () => {
    const e = makeEnv();
    await e.remote.syncProject(e.project);
    await e.history.recordRemote(e.project, {
      tipo: "pr",
      projeto: "App",
      id: prId("github", "o/r", 4),
      titulo: "PR numero 4",
      data: new Date(AFTER),
      estado: "open",
    });
    e.provider.prs = [pr(4, "aberto", AFTER)];
    expect(await e.remote.syncProject(e.project)).toMatchObject({ created: [], updated: [] });
    e.provider.prs = [pr(4, "mesclado", AFTER)];
    const res = await e.remote.syncProject(e.project);
    expect(res.updated).toHaveLength(1);
    expect(eventNotes(e, "PR ")).toHaveLength(1);
  });
});

describe("deploys", () => {
  it("a pipeline of the default branch that ended with success after the baseline is a deploy; the others are not", async () => {
    const e = makeEnv();
    e.provider.runs = [run("100", "sucesso", BEFORE)];
    await e.remote.syncProject(e.project);

    e.provider.runs = [run("103", "executando", AFTER), run("102", "falha", AFTER), run("101", "sucesso", AFTER), run("100", "sucesso", BEFORE)];
    const res = await e.remote.syncProject(e.project);
    expect(res.errors).toEqual([]);
    expect(res.created).toEqual([`Projetos/App/Eventos/Deploy main - 101.md`]);
    const body = e.vault.notes.get(res.created[0]!)!;
    expect(body).toContain(`evento_id: "${deployId(REF, "101")}"`);
    expect(body).toContain('ambiente: "main"');
    expect(body).toContain(`hash: ${HASH}`);
    expect(body).toContain("  - dev/deploy");
    expect(body).toContain("| Link | https://github.com/o/r/actions/runs/101 |");

    // the running pipeline ends with success later
    e.provider.runs = [run("103", "sucesso", AFTER), run("101", "sucesso", AFTER)];
    const next = await e.remote.syncProject(e.project);
    expect(next.created).toEqual([`Projetos/App/Eventos/Deploy main - 103.md`]);
    expect(eventNotes(e, "Deploy ")).toHaveLength(2);
    expect((await e.remote.syncProject(e.project)).created).toEqual([]);
  });

  it("builds the id of the AI Log Manager (the braces of a Bitbucket uuid are dropped)", () => {
    expect(deployId({ provider: "bitbucket", owner: "w", slug: "r", repo: "w/r" }, "{1234-abcd}")).toBe("deploy-bitbucket-w/r-1234-abcd");
    expect(deployId(REF, "55")).toBe("deploy-github-o/r-55");
  });

  it("without origin/HEAD it falls back to main, and without main or master it reads no pipelines", async () => {
    const e = makeEnv({ mainRef: false });
    await e.remote.syncProject(e.project);
    expect(e.provider.statusPipelines).not.toHaveBeenCalled();
    expect(e.provider.listarPrs).toHaveBeenCalled();
    sh(e.repo, "update-ref", "refs/remotes/origin/master", "HEAD");
    await e.remote.syncProject(e.project);
    expect(e.provider.statusPipelines).toHaveBeenCalledWith({ branch: "master", limite: 10, incluirSteps: false });
  });
});

describe("what is not read", () => {
  it("a project whose provider has no secret is not asked anything", async () => {
    const e = makeEnv({ secret: false });
    const res = await e.remote.syncProject(e.project);
    expect(res.skipped).toContain("sem secret");
    expect(e.provider.listarPrs).not.toHaveBeenCalled();
    expect(e.provider.statusPipelines).not.toHaveBeenCalled();
    expect(e.history.hasBaseline(e.project)).toBe(false);
  });

  it("a remote that is not GitHub or Bitbucket, and a repository without remote, are skipped before any provider is built", async () => {
    const other = makeEnv({ remoteUrl: "https://git.exemplo.com/o/r.git" });
    expect((await other.remote.syncProject(other.project)).skipped).toContain("sem remoto");
    const none = makeEnv({ remoteUrl: null });
    expect((await none.remote.syncProject(none.project)).skipped).toContain("sem remoto");
    expect(other.providerFor).not.toHaveBeenCalled();
    expect(none.providerFor).not.toHaveBeenCalled();
  });

  it("a project without a clone is skipped", async () => {
    const e = makeEnv();
    const res = await e.remote.syncProject({ ...e.project, clonePath: undefined });
    expect(res.skipped).toBe("sem clone");
  });

  it("a failure of one source does not stop the other, and nothing is thrown", async () => {
    const e = makeEnv();
    await e.remote.syncProject(e.project);
    e.provider.prError = new Error("429 limite");
    e.provider.runs = [run("200", "sucesso", AFTER)];
    const res = await e.remote.syncProject(e.project);
    expect(res.errors).toEqual(["PRs: 429 limite"]);
    expect(res.created).toEqual(["Projetos/App/Eventos/Deploy main - 200.md"]);
    e.provider.runError = new Error("cofre bloqueado");
    const res2 = await e.remote.syncProject(e.project);
    expect(res2.errors).toHaveLength(2);
    expect(e.log).toHaveBeenCalled();
  });
});

/** A git runner that answers like a clone of github.com/o/r with origin/main, without touching the disk. */
const fakeGit = (calls: string[][]): GitRunner => async (_cwd, args) => {
  calls.push(args);
  if (args.join(" ") === "remote") return "origin\n";
  if (args[0] === "remote" && args[1] === "get-url") return "https://github.com/o/r.git\n";
  if (args[0] === "remote" && args[1] === "-v") return "origin\thttps://github.com/o/r.git (fetch)\norigin\thttps://github.com/o/r.git (push)\n";
  if (args[0] === "symbolic-ref") return "refs/remotes/origin/main\n";
  return "";
};

describe("the timer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function timerEnv(remotePolling = true) {
    const settings = { remotePolling, remoteIntervalMin: 7 };
    const provider = new FakeProvider();
    const marks: Record<string, string> = {};
    const remote = new RemoteSync({
      history: {
        hasBaseline: () => true,
        sync: async () => ({ project: "App", baseline: false, created: [], errors: [] }),
        remoteMarks: () => ({ ...marks }),
        setRemoteMarks: (_p, m) => Object.assign(marks, m),
        recordRemote: async () => ({ path: "x", created: true, updated: false }),
      },
      projects: { list: async () => [{ name: "App", folder: "Projetos/App", clonePath: "C:/app" }] },
      git: fakeGit([]),
      settings: () => settings,
      providerFor: async () => provider.asProvider(),
      log: () => undefined,
    });
    return { remote, provider, settings };
  }

  it("reads once at the start and then every remoteIntervalMin minutes, and stops", async () => {
    const { remote, provider } = timerEnv();
    remote.start();
    remote.start(); // idempotent
    expect(remote.active).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(provider.listarPrs).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(7 * 60_000 - 1);
    expect(provider.listarPrs).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(provider.listarPrs).toHaveBeenCalledTimes(2);
    remote.stop();
    expect(remote.active).toBe(false);
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(provider.listarPrs).toHaveBeenCalledTimes(2);
  });

  it("remotePolling off reads nothing", async () => {
    const { remote, provider } = timerEnv(false);
    expect(await remote.tick()).toEqual([]);
    expect(provider.listarPrs).not.toHaveBeenCalled();
  });

  it("ticks that overlap share one run", async () => {
    const { remote, provider } = timerEnv();
    const [a, b] = [remote.tick(), remote.tick()];
    expect(a).toBe(b);
    expect(await a).toHaveLength(1);
    expect(provider.listarPrs).toHaveBeenCalledTimes(1);
  });
});

describe("createProviderResolver", () => {
  const settings = (over: Partial<Settings> = {}) => () => ({ ...DEFAULT_SETTINGS, ...over });

  it("is undefined without a secret chosen for the provider of the repository", async () => {
    const fake = makeFakeSecrets({ metadata: [secretInfo("GH_TESTE")] });
    const factory = vi.fn();
    const resolve = createProviderResolver({ settings: settings({ secretBitbucket: "BB" }), getSecrets: fake.getSecrets, factories: { github: factory } });
    expect(await resolve(REF)).toBeUndefined();
    expect(factory).not.toHaveBeenCalled();
  });

  it("is undefined without the secrets service and while the vault is locked", async () => {
    const factory = vi.fn();
    const none = createProviderResolver({ settings: settings({ secretGithub: "GH_TESTE" }), getSecrets: () => undefined, factories: { github: factory } });
    expect(await none(REF)).toBeUndefined();
    const fake = makeFakeSecrets({ metadata: [secretInfo("GH_TESTE")] });
    fake.lock();
    fake.service.isLocked = () => true;
    const locked = createProviderResolver({ settings: settings({ secretGithub: "GH_TESTE" }), getSecrets: fake.getSecrets, factories: { github: factory } });
    expect(await locked(REF)).toBeUndefined();
    expect(factory).not.toHaveBeenCalled();
  });

  it("builds the provider with the name and the metadata of the secret, never a value", async () => {
    const fake = makeFakeSecrets({ metadata: [secretInfo("GH_TESTE")] });
    let seen: ProviderContext | undefined;
    const resolve = createProviderResolver({
      settings: settings({ secretGithub: "GH_TESTE" }),
      getSecrets: fake.getSecrets,
      factories: {
        github: (ctx) => {
          seen = ctx;
          return {} as GitProvider;
        },
      },
    });
    expect(await resolve(REF)).toBeDefined();
    expect(seen?.secretName).toBe("GH_TESTE");
    expect(seen?.ref).toEqual(REF);
    expect(seen?.secretInfo?.type).toBe("bearer");
    expect(JSON.stringify(seen?.secretInfo)).not.toContain("valor");
  });
});
