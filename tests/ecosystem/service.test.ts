import { afterAll, describe, expect, it, vi } from "vitest";
import { createNodeGit } from "../../src/core/git-runner";
import { CheckpointStore } from "../../src/core/history/checkpoints";
import { HistoryService } from "../../src/core/history/history-service";
import type { ProjectInfo } from "../../src/core/ports";
import { createGitToolsService } from "../../src/main";
import { cleanupTemp, makeRepo, makeTempDir, sh, writeFile } from "../helpers/git-repos";
import { MemoryVault } from "../helpers/memory-ports";

afterAll(cleanupTemp);

function commit(dir: string, file: string, message: string): void {
  writeFile(dir, file, `${message}\n`);
  sh(dir, "add", ".");
  sh(dir, "commit", "-q", "-m", message);
}

function harness(projects: ProjectInfo[]) {
  const history = new HistoryService(createNodeGit(), new MemoryVault(), new CheckpointStore({ load: async () => undefined, save: async () => undefined }), () => ({ eventsFolder: "Eventos" }));
  let known = projects;
  const service = createGitToolsService({
    version: "9.9.9",
    history,
    projects: { byName: async (n) => known.find((p) => p.name.toLowerCase() === n.trim().toLowerCase()) },
    knownProjects: () => known,
  });
  return { service, setKnown: (p: ProjectInfo[]) => (known = p) };
}

describe("ai-git-tools service", () => {
  it("exposes the version", () => {
    expect(harness([]).service.version).toBe("9.9.9");
  });

  it("hasProject is synchronous, case-insensitive and follows the cache of the projects", () => {
    const { service, setKnown } = harness([{ name: "App", folder: "Projetos/App", clonePath: undefined }]);
    expect(service.hasProject("app")).toBe(true);
    expect(service.hasProject(" App ")).toBe(true);
    expect(service.hasProject("Outro")).toBe(false);
    expect(service.hasProject("")).toBe(false);
    setKnown([{ name: "Outro", folder: "Projetos/Outro", clonePath: undefined }]);
    expect(service.hasProject("Outro")).toBe(true);
    expect(service.hasProject("App")).toBe(false);
  });

  it("renders the svg of the graph of a project with a clone", async () => {
    const repo = makeRepo();
    sh(repo, "checkout", "-q", "-b", "feature/x");
    commit(repo, "b", "na feature");
    sh(repo, "checkout", "-q", "main");
    const { service } = harness([{ name: "App", folder: "Projetos/App", clonePath: repo }]);
    const svg = await service.renderGraphSvg("app");
    expect(svg?.startsWith("<svg")).toBe(true);
    expect(svg).toContain("na feature");
    expect(svg).toContain("commit inicial");
    const narrow = await service.renderGraphSvg("App", { branch: "feature/x", limite: 1, largura: 260 });
    expect(narrow).toContain('width="260"');
    expect(narrow).toContain('class="hl"');
    expect(narrow).not.toContain("commit inicial");
  });

  it("returns undefined for an unknown project, a project without clone and a folder that is not a repository", async () => {
    const notRepo = makeTempDir();
    const { service } = harness([
      { name: "Sem Clone", folder: "Projetos/Sem Clone", clonePath: undefined },
      { name: "Sem Git", folder: "Projetos/Sem Git", clonePath: notRepo },
    ]);
    const debug = vi.spyOn(console, "debug").mockImplementation(() => undefined);
    expect(await service.renderGraphSvg("Nada")).toBeUndefined();
    expect(await service.renderGraphSvg("Sem Clone")).toBeUndefined();
    expect(await service.renderGraphSvg("Sem Git")).toBeUndefined();
    debug.mockRestore();
  });
});
