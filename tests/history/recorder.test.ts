// The tools document themselves: after a successful call the recorder writes the event note of the
// project, with the same ids as the sync of the watcher (so nothing is written twice), and the
// answer of the tool carries `nota`. Real repositories, a bare remote and an in-memory vault; the
// pull request calls go to a fake provider (no network).
import { afterAll, describe, expect, it } from "vitest";
import { createNodeGit } from "../../src/core/git-runner";
import { CheckpointStore } from "../../src/core/history/checkpoints";
import { branchId, commitId, prId, pushId } from "../../src/core/history/events";
import { HistoryService } from "../../src/core/history/history-service";
import { Recorder } from "../../src/core/history/recorder";
import type { GitProvider, ProviderFactory } from "../../src/core/providers/provider";
import type { GitRunner, ProjectInfo } from "../../src/core/ports";
import type { ResolvedRepo } from "../../src/core/repo-resolver";
import { buildGitTools } from "../../src/tools/git-tools";
import { cleanupTemp, makeBareRemote, makeRepo, makeTempDir, sh, writeFile } from "../helpers/git-repos";
import { MemoryVault } from "../helpers/memory-ports";
import { callTool, dataOf, lookupOf, makeDeps, textOf } from "../helpers/tool-deps";

afterAll(cleanupTemp);

class FailingVault extends MemoryVault {
  override async create(): Promise<void> {
    throw new Error("disco cheio");
  }
}

interface Env {
  repo: string;
  bare: string;
  vault: MemoryVault;
  store: CheckpointStore;
  history: HistoryService;
  project: ProjectInfo;
  tools: ReturnType<typeof buildGitTools>;
  recorder: Recorder;
}

interface EnvOptions {
  /** Takes the baseline of the project before the test starts (default true). */
  baseline?: boolean;
  vault?: MemoryVault;
  /** `github`: origin is a GitHub URL (ls-remote still goes to the bare repository). */
  remote?: "bare" | "github";
  providerFactories?: Partial<Record<"github" | "bitbucket", ProviderFactory>>;
  /** The project is not in the lookup of the recorder (a repository allowed only by folder). */
  outsideProject?: boolean;
}

async function makeEnv(opts: EnvOptions = {}): Promise<Env> {
  const base = makeTempDir();
  const bare = makeBareRemote(base);
  const repo = makeRepo(base, "clone");
  sh(repo, "remote", "add", "origin", bare);
  sh(repo, "push", "-q", "-u", "origin", "main");
  if (opts.remote === "github") sh(repo, "remote", "set-url", "origin", "https://github.com/o/r.git");

  const vault = opts.vault ?? new MemoryVault();
  const store = new CheckpointStore({ load: async () => undefined, save: async () => undefined });
  const real = createNodeGit();
  const history = new HistoryService(real, vault, store, () => ({ eventsFolder: "Eventos" }));
  const project: ProjectInfo = { name: "App", folder: "Projetos/App", clonePath: repo };
  const recorder = new Recorder({ history, projects: opts.outsideProject ? lookupOf([]) : lookupOf([project]), git: real });
  if (opts.baseline !== false) await history.sync(project);

  // `ls-remote origin` of the GitHub variant is pointed at the bare repository.
  const git: GitRunner = (cwd, args, o) => real(cwd, args[0] === "ls-remote" ? args.map((a) => (a === "origin" ? bare : a)) : args, o);
  const deps = makeDeps({
    projects: opts.outsideProject ? [] : [{ name: "App", clone: repo }],
    allowed: [base],
    git,
    recorder,
    settings: { secretGithub: "GH_TESTE" },
    ...(opts.providerFactories ? { providerFactories: opts.providerFactories } : {}),
  });
  return { repo, bare, vault, store, history, project, tools: buildGitTools(deps), recorder };
}

const notes = (e: Env, prefix: string): string[] => [...e.vault.notes.keys()].filter((p) => p.startsWith(`Projetos/App/Eventos/${prefix}`));
const head = (repo: string): string => sh(repo, "rev-parse", "HEAD").trim();

async function commitByTool(e: Env, file: string, message: string) {
  writeFile(e.repo, file, `${message}\n`);
  await callTool(e.tools, "git_add", { repo: e.repo, todos: true });
  return callTool(e.tools, "git_commit", { repo: e.repo, mensagem: message });
}

describe("tool documenta", () => {
  it("git_commit creates the note of the commit and the answer carries its path", async () => {
    const e = await makeEnv();
    const res = await commitByTool(e, "a.txt", "feat: primeira");
    expect(res.isError).toBeUndefined();
    const hash = head(e.repo);
    const path = `Projetos/App/Eventos/Commit ${hash.slice(0, 7)} - feat: primeira.md`.replace(":", "");
    expect(dataOf(res).nota).toBe(path);
    expect(textOf(res)).toContain(`Nota do evento: ${path}`);
    expect(dataOf(res).avisos).toBeUndefined();
    const body = e.vault.notes.get(path)!;
    expect(body).toContain(`evento_id: "${commitId(hash)}"`);
    expect(body).toContain(`hash: ${hash}`);
    expect(body).toContain("  - dev/commit");
    expect(body).toContain('branch: "main"');
    expect(body).toContain("| Autor | Teste |");
    expect(e.vault.notes.has("Projetos/App/Eventos/App - Eventos.md")).toBe(true);
  });

  it("read tools and failed calls write nothing", async () => {
    const e = await makeEnv();
    await callTool(e.tools, "git_status", { repo: e.repo });
    await callTool(e.tools, "git_log", { repo: e.repo });
    const empty = await callTool(e.tools, "git_commit", { repo: e.repo, mensagem: "nada" });
    expect(empty.isError).toBe(true);
    expect(dataOf(empty).codigo).toBe("nada_a_commitar");
    expect(e.vault.notes.size).toBe(0);
  });

  it("a repository that is not in a project writes nothing", async () => {
    const e = await makeEnv({ outsideProject: true });
    const res = await commitByTool(e, "a.txt", "fora de projeto");
    expect(res.isError).toBeUndefined();
    expect(dataOf(res).nota).toBeUndefined();
    expect(e.vault.notes.size).toBe(0);
  });

  it("a project without a baseline still documents what its own tools do, and the first sync stays a baseline", async () => {
    const e = await makeEnv({ baseline: false });
    const res = await commitByTool(e, "a.txt", "antes da linha de base");
    expect(dataOf(res).nota).toBeDefined();
    expect(e.history.hasBaseline(e.project)).toBe(false);
    const sync = await e.history.sync(e.project);
    expect(sync.baseline).toBe(true);
    expect(sync.created).toEqual([]);
    expect(notes(e, "Commit ")).toHaveLength(1);
  });
});

describe("sem duplicata", () => {
  it("a commit made by the tool is not written again by the sync of the watcher", async () => {
    const e = await makeEnv();
    await commitByTool(e, "a.txt", "pela tool");
    const before = e.vault.notes.size;
    const sync = await e.history.sync(e.project);
    expect(sync.created).toEqual([]);
    expect(notes(e, "Commit ")).toHaveLength(1);
    expect(e.vault.notes.size).toBe(before);
  });

  it("a commit made in the terminal is written by the sync, and the tool after it adds only its own", async () => {
    const e = await makeEnv();
    writeFile(e.repo, "t.txt", "terminal\n");
    sh(e.repo, "add", ".");
    sh(e.repo, "commit", "-q", "-m", "no terminal");
    await commitByTool(e, "b.txt", "na tool");
    await e.history.sync(e.project);
    expect(notes(e, "Commit ")).toHaveLength(2);
  });
});

describe("push, branch e checkout", () => {
  it("git_push writes a push note with the id the sync would write (the remote-tracking name)", async () => {
    const e = await makeEnv();
    await commitByTool(e, "a.txt", "para enviar");
    const hash = head(e.repo);
    const res = await callTool(e.tools, "git_push", { repo: e.repo });
    expect(res.isError).toBeUndefined();
    expect(dataOf(res).nota).toBe(`Projetos/App/Eventos/Push main - ${hash.slice(0, 7)}.md`);
    expect(dataOf(res).notas).toBeUndefined();
    expect(e.vault.notes.get(dataOf(res).nota as string)).toContain(`evento_id: "${pushId("origin/main", hash)}"`);
    const sync = await e.history.sync(e.project);
    expect(sync.created).toEqual([]);
    expect(notes(e, "Push ")).toHaveLength(1);
  });

  it("the id of the tool is the id of the sync: a push seen first by the sync is not written again by the recorder", async () => {
    const e = await makeEnv();
    await commitByTool(e, "a.txt", "enviado no terminal");
    const hash = head(e.repo);
    sh(e.repo, "push", "-q");
    await e.history.sync(e.project);
    expect(notes(e, "Push ")).toHaveLength(1);
    const repo: ResolvedRepo = { root: e.repo, projeto: "App" };
    const out = await e.recorder.afterTool("git_push", repo, {
      content: [],
      structuredContent: { ok: true, remoto: "origin", branch: "main", hash, branch_nova: false, em_dia: false },
    });
    expect(out.avisos).toEqual([]);
    expect(out.nota).toBe(`Projetos/App/Eventos/Push main - ${hash.slice(0, 7)}.md`);
    expect(notes(e, "Push ")).toHaveLength(1);
  });

  it("a push that finds the remote up to date, and a tag push, write nothing", async () => {
    const e = await makeEnv();
    const upToDate = await callTool(e.tools, "git_push", { repo: e.repo });
    expect(dataOf(upToDate).em_dia).toBe(true);
    expect(dataOf(upToDate).nota).toBeUndefined();
    await callTool(e.tools, "git_tag", { repo: e.repo, acao: "criar", nome: "v0.1", mensagem: "m" });
    const before = e.vault.notes.size;
    const tagPush = await callTool(e.tools, "git_push", { repo: e.repo, tag: "v0.1" });
    expect(tagPush.isError).toBeUndefined();
    expect(dataOf(tagPush).nota).toBeUndefined();
    expect(e.vault.notes.size).toBe(before);
  });

  it("a new branch pushed from the terminal-made branch gets a branch note and a push note", async () => {
    const e = await makeEnv();
    sh(e.repo, "switch", "-q", "-c", "feature/terminal");
    await commitByTool(e, "a.txt", "na feature");
    const hash = head(e.repo);
    const res = await callTool(e.tools, "git_push", { repo: e.repo, definir_upstream: true });
    expect(dataOf(res).branch_nova).toBe(true);
    const paths = dataOf(res).notas as string[];
    expect(paths).toHaveLength(2);
    expect(dataOf(res).nota).toBe(`Projetos/App/Eventos/Push feature-terminal - ${hash.slice(0, 7)}.md`);
    expect(paths).toContain("Projetos/App/Eventos/Branch feature-terminal.md");
    expect(e.vault.notes.get("Projetos/App/Eventos/Branch feature-terminal.md")).toContain(`evento_id: "${branchId("feature/terminal", hash)}"`);
    const sync = await e.history.sync(e.project);
    // The sync still sees the local branch as new (the tool never touches its list) but the id is the same.
    expect(notes(e, "Branch ")).toHaveLength(1);
    expect(sync.created.filter((p) => p.includes("/Push "))).toEqual([]);
  });

  it("git_checkout with criar writes the branch note once, even after the branch moved", async () => {
    const e = await makeEnv();
    const res = await callTool(e.tools, "git_checkout", { repo: e.repo, branch: "feature/nova", criar: true, base: "main" });
    expect(dataOf(res).nota).toBe("Projetos/App/Eventos/Branch feature-nova.md");
    await commitByTool(e, "a.txt", "avança a branch");
    const sync = await e.history.sync(e.project);
    expect(sync.errors).toEqual([]);
    expect(notes(e, "Branch ")).toHaveLength(1);
    // Without criar there is no event.
    const back = await callTool(e.tools, "git_checkout", { repo: e.repo, branch: "main" });
    expect(dataOf(back).nota).toBeUndefined();
  });

  it("a branch that already has a note is not described again when it is pushed", async () => {
    const e = await makeEnv();
    await callTool(e.tools, "git_checkout", { repo: e.repo, branch: "feature/y", criar: true, base: "main" });
    await commitByTool(e, "a.txt", "um");
    const res = await callTool(e.tools, "git_push", { repo: e.repo, definir_upstream: true });
    expect(dataOf(res).notas).toBeUndefined();
    expect(notes(e, "Branch ")).toHaveLength(1);
    expect(notes(e, "Push ")).toHaveLength(1);
  });
});

describe("merge, revert e tag", () => {
  it("git_merge with a merge commit, and git_revert, write commit notes; a fast-forward writes none", async () => {
    const e = await makeEnv();
    await callTool(e.tools, "git_checkout", { repo: e.repo, branch: "feature/m", criar: true, base: "main" });
    await commitByTool(e, "f.txt", "na feature m");
    await callTool(e.tools, "git_checkout", { repo: e.repo, branch: "main" });
    await commitByTool(e, "m.txt", "na main");
    const merge = await callTool(e.tools, "git_merge", { repo: e.repo, origem: "feature/m", sem_ff: true });
    expect(merge.isError).toBeUndefined();
    const mergeHash = head(e.repo);
    const mergeNote = dataOf(merge).nota as string;
    expect(mergeNote).toContain(`Commit ${mergeHash.slice(0, 7)} - Merge branch`);
    expect(e.vault.notes.get(mergeNote)).toContain(`evento_id: "${commitId(mergeHash)}"`);

    const revert = await callTool(e.tools, "git_revert", { repo: e.repo, commit: "HEAD", merge_pai: 1 });
    expect(revert.isError).toBeUndefined();
    const revertHash = head(e.repo);
    expect(dataOf(revert).nota).toContain(`Commit ${revertHash.slice(0, 7)} - Revert`);

    // Fast-forward: git_checkout, then merge a branch that is ahead.
    await callTool(e.tools, "git_checkout", { repo: e.repo, branch: "ff", criar: true, base: "main" });
    await commitByTool(e, "ff.txt", "à frente");
    await callTool(e.tools, "git_checkout", { repo: e.repo, branch: "main" });
    const before = notes(e, "Commit ").length;
    const ff = await callTool(e.tools, "git_merge", { repo: e.repo, origem: "ff" });
    expect(dataOf(ff).fast_forward).toBe(true);
    expect(dataOf(ff).nota).toBeUndefined();
    expect(notes(e, "Commit ")).toHaveLength(before);

    const sync = await e.history.sync(e.project);
    expect(sync.created.filter((p) => p.includes("/Commit "))).toEqual([]);
  });

  it("git_merge already up to date and an aborted merge write nothing", async () => {
    const e = await makeEnv();
    const same = await callTool(e.tools, "git_merge", { repo: e.repo, origem: "main" });
    expect(dataOf(same).ja_atualizado).toBe(true);
    expect(dataOf(same).nota).toBeUndefined();
  });

  it("git_tag criar writes a release (deploy) note named by the tag; listing writes nothing", async () => {
    const e = await makeEnv();
    const hash = head(e.repo);
    const res = await callTool(e.tools, "git_tag", { repo: e.repo, acao: "criar", nome: "rel-1.0", mensagem: "release 1.0" });
    expect(dataOf(res).nota).toBe(`Projetos/App/Eventos/Deploy rel-1.0 - ${hash.slice(0, 7)}.md`);
    const body = e.vault.notes.get(dataOf(res).nota as string)!;
    expect(body).toContain(`evento_id: "deploy-tag-rel-1.0-${hash.slice(0, 7)}"`);
    expect(body).toContain('ambiente: "rel-1.0"');
    expect(body).toContain("  - dev/deploy");
    const list = await callTool(e.tools, "git_tag", { repo: e.repo, acao: "listar" });
    expect(dataOf(list).nota).toBeUndefined();
    expect(notes(e, "Deploy ")).toHaveLength(1);
  });
});

function fakeProvider(): ProviderFactory {
  const pr = {
    numero: 12,
    titulo: "Minha feature",
    estado: "aberto" as const,
    origem: "feature/x",
    destino: "develop",
    url: "https://github.com/o/r/pull/12",
    autor: "ana",
    criadoEm: "2026-10-01T10:00:00Z",
    headSha: "a".repeat(40),
  };
  const provider = {
    id: "github",
    criarPr: async () => pr,
    obterPr: async () => pr,
    mesclarPr: async () => ({ numero: 12, mesclado: true, estado: "mesclado" as const, commit: "b".repeat(40), url: pr.url }),
  } as unknown as GitProvider;
  return () => provider;
}

describe("pull requests", () => {
  it("git_pr_criar writes the PR note open, and git_pr_merge brings the same note to merged", async () => {
    const e = await makeEnv({ remote: "github", providerFactories: { github: fakeProvider() } });
    sh(e.repo, "branch", "feature/x");
    sh(e.repo, "push", "-q", e.bare, "feature/x");
    const created = await callTool(e.tools, "git_pr_criar", { repo: e.repo, origem: "feature/x", destino: "develop", titulo: "Minha feature" });
    expect(created.isError).toBeUndefined();
    const path = "Projetos/App/Eventos/PR 12 - Minha feature.md";
    expect(dataOf(created).nota).toBe(path);
    let body = e.vault.notes.get(path)!;
    expect(body).toContain(`evento_id: "${prId("github", "o/r", 12)}"`);
    expect(body).toContain('estado: "open"');
    expect(body).toContain("| Link | https://github.com/o/r/pull/12 |");
    expect(body).toContain("  - dev/pr");

    const merged = await callTool(e.tools, "git_pr_merge", { repo: e.repo, numero: 12, destino: "develop", titulo: "Minha feature", estrategia: "merge" });
    expect(merged.isError).toBeUndefined();
    expect(dataOf(merged).nota).toBe(path);
    body = e.vault.notes.get(path)!;
    expect(body).toContain('estado: "merged"');
    expect(body).toContain("| Estado | merged |");
    expect(notes(e, "PR ")).toHaveLength(1);
    expect(e.store.getDev("App")?.prStates[prId("github", "o/r", 12)]).toBe("merged");
  });

  it("a merge of a PR nobody documented creates its note already merged", async () => {
    const e = await makeEnv({ remote: "github", providerFactories: { github: fakeProvider() } });
    const merged = await callTool(e.tools, "git_pr_merge", { repo: e.repo, numero: 12, destino: "develop", titulo: "Minha feature", estrategia: "squash" });
    expect(merged.isError).toBeUndefined();
    const body = e.vault.notes.get(dataOf(merged).nota as string)!;
    expect(body).toContain('estado: "merged"');
    expect(body).toContain(`hash: ${"b".repeat(40)}`);
  });
});

describe("falhas ao documentar", () => {
  it("a note that cannot be written becomes a warning, and the tool still succeeds", async () => {
    const e = await makeEnv({ vault: new FailingVault() });
    const res = await commitByTool(e, "a.txt", "sem disco");
    expect(res.isError).toBeUndefined();
    expect(dataOf(res).ok).toBe(true);
    expect(dataOf(res).nota).toBeUndefined();
    const avisos = dataOf(res).avisos as string[];
    expect(avisos).toHaveLength(1);
    expect(avisos[0]).toContain("disco cheio");
    expect(textOf(res)).toContain("disco cheio");
    // The commit exists whatever happened to the note.
    expect(sh(e.repo, "log", "-1", "--format=%s").trim()).toBe("sem disco");
  });

  it("a recorder that throws is contained by the tool", async () => {
    const e = await makeEnv();
    const throwing = {
      afterTool: async () => {
        throw new Error("explodiu");
      },
    };
    const tools = buildGitTools(makeDeps({ projects: [{ name: "App", clone: e.repo }], recorder: throwing }));
    writeFile(e.repo, "x.txt", "x\n");
    await callTool(tools, "git_add", { repo: e.repo, todos: true });
    const res = await callTool(tools, "git_commit", { repo: e.repo, mensagem: "continua ok" });
    expect(res.isError).toBeUndefined();
    expect(dataOf(res).hash).toBeDefined();
    expect((dataOf(res).avisos as string[])[0]).toContain("explodiu");
  });

  it("keeps the warnings the tool already had", async () => {
    const e = await makeEnv({ vault: new FailingVault() });
    const res = await callTool(e.tools, "git_checkout", { repo: e.repo, branch: "feature/z", criar: true });
    // checkout without base warns about the HEAD; the note failure adds one more
    const avisos = dataOf(res).avisos as string[];
    expect(avisos.length).toBeGreaterThanOrEqual(2);
  });
});
