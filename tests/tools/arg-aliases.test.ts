// Synonyms of arguments, the git_diff target and project matching, as the agents use them.
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { matchProject, normalizeProjectName } from "../../src/core/project-match";
import { buildReadTools, buildWriteTools, diffTarget } from "../../src/tools/git-tools";
import { normalizeArgs } from "../../src/tools/arg-aliases";
import { GIT_ADD_SCHEMA, GIT_BLAME_SCHEMA, GIT_DIFF_SCHEMA, GIT_GRAPH_SCHEMA, GIT_LOG_SCHEMA, GIT_PR_COMENTAR_SCHEMA, GIT_STATUS_SCHEMA } from "../../src/tools/schemas";
import { cleanupTemp, makeRepo, makeTempDir, sh, writeFile } from "../helpers/git-repos";
import { callTool, dataOf, makeDeps, textOf } from "../helpers/tool-deps";

afterAll(cleanupTemp);

describe("normalizeArgs", () => {
  it("maps path to the repository when the tool has no file argument (git_status)", () => {
    expect(normalizeArgs({ path: "C:\\x\\repo" }, GIT_STATUS_SCHEMA)).toEqual({ repo: "C:\\x\\repo" });
    expect(normalizeArgs({ projeto: "App" }, GIT_STATUS_SCHEMA)).toEqual({ repo: "App" });
    expect(normalizeArgs({ repositorio: "App", remote: true }, GIT_STATUS_SCHEMA)).toEqual({ repo: "App", remoto: true });
  });

  it("maps path to the file when the repository is already given (git_blame)", () => {
    expect(normalizeArgs({ repo: "App", path: "src/a.ts" }, GIT_BLAME_SCHEMA)).toEqual({ repo: "App", caminho: "src/a.ts" });
    expect(normalizeArgs({ repo: "App", arquivo: "src/a.ts" }, GIT_BLAME_SCHEMA)).toEqual({ repo: "App", caminho: "src/a.ts" });
  });

  it("a lone path decides by the value: absolute is the repository, relative is the file", () => {
    expect(normalizeArgs({ path: "C:\\x\\repo" }, GIT_BLAME_SCHEMA)).toEqual({ repo: "C:\\x\\repo" });
    expect(normalizeArgs({ path: "src/a.ts" }, GIT_BLAME_SCHEMA)).toEqual({ caminho: "src/a.ts" });
  });

  it("turns a single path into a list and a list of one into a single path", () => {
    expect(normalizeArgs({ repo: "App", caminho: "a.ts" }, GIT_DIFF_SCHEMA)).toEqual({ repo: "App", caminhos: ["a.ts"] });
    expect(normalizeArgs({ repo: "App", path: "a.ts" }, GIT_ADD_SCHEMA)).toEqual({ repo: "App", caminhos: ["a.ts"] });
    expect(normalizeArgs({ repo: "App", caminhos: ["a.ts"] }, GIT_LOG_SCHEMA)).toEqual({ repo: "App", caminho: "a.ts" });
  });

  it("accepts the case, hyphen and camelCase variants and the projeto of the documentation tools", () => {
    expect(normalizeArgs({ Repo: "App", maxBytes: 10, "max-bytes": 10 }, GIT_DIFF_SCHEMA)).toEqual({ repo: "App", max_bytes: 10 });
    expect(normalizeArgs({ repo: "App" }, GIT_GRAPH_SCHEMA)).toEqual({ projeto: "App" });
    expect(normalizeArgs({ repo: "App", pr: 3, body: "oi" }, GIT_PR_COMENTAR_SCHEMA)).toEqual({ repo: "App", numero: 3, texto: "oi" });
  });

  it("a name the schema declares wins over a synonym; conflicting values are an error", () => {
    expect(normalizeArgs({ repo: "A", projeto: "A" }, GIT_STATUS_SCHEMA)).toEqual({ repo: "A" });
    expect(() => normalizeArgs({ repo: "A", projeto: "B" }, GIT_STATUS_SCHEMA)).toThrow(/mesmo parâmetro/);
  });

  it("an unknown argument is still an error and the message lists the accepted ones", () => {
    expect(() => normalizeArgs({ repo: "A", surpresa: 1 }, GIT_STATUS_SCHEMA)).toThrow(/surpresa.*Argumentos aceitos: repo, remoto/);
  });
});

describe("diffTarget", () => {
  it.each([
    ["stage", "staged"],
    ["staged", "staged"],
    ["cached", "staged"],
    ["index", "staged"],
    ["unstaged", "worktree"],
    ["working", "worktree"],
    ["worktree", "worktree"],
    ["Working-Tree", "worktree"],
    ["refs", "refs"],
  ])("%s -> %s", (raw, expected) => {
    expect(diffTarget(raw, false)).toBe(expected);
  });

  it("without a target: refs when base or head came, otherwise worktree", () => {
    expect(diffTarget(undefined, false)).toBe("worktree");
    expect(diffTarget(undefined, true)).toBe("refs");
  });

  it("an unknown target is refused", () => {
    expect(() => diffTarget("lua", false)).toThrow(/alvo inválido: lua/);
  });
});

describe("git_diff and git_status as the agents call them", () => {
  function setup() {
    const repo = makeRepo();
    writeFile(repo, "README.md", "mudou\n");
    const tools = buildReadTools(makeDeps({ projects: [{ name: "App", clone: repo }] }));
    return { repo, tools };
  }

  it("git_diff without alvo shows the working tree", async () => {
    const { repo, tools } = setup();
    const res = await callTool(tools, "git_diff", { repo });
    expect(res.isError).not.toBe(true);
    expect(dataOf(res)).toMatchObject({ alvo: "worktree", vazio: false });
  });

  it("git_diff accepts unstaged, stage and caminho (path)", async () => {
    const { repo, tools } = setup();
    const unstaged = await callTool(tools, "git_diff", { repo, alvo: "unstaged", path: "README.md" });
    expect(dataOf(unstaged)).toMatchObject({ alvo: "worktree", vazio: false });
    sh(repo, "add", "README.md");
    const stage = await callTool(tools, "git_diff", { repo, alvo: "stage", caminho: "README.md" });
    expect(dataOf(stage)).toMatchObject({ alvo: "staged", vazio: false });
  });

  it("git_diff with max_bytes 0 uses the default instead of failing", async () => {
    const { repo, tools } = setup();
    const res = await callTool(tools, "git_diff", { repo, max_bytes: 0 });
    expect(res.isError).not.toBe(true);
  });

  it("git_diff with only base compares references", async () => {
    const { repo, tools } = setup();
    const res = await callTool(tools, "git_diff", { repo, base: "HEAD" });
    expect(dataOf(res)).toMatchObject({ alvo: "refs", base: "HEAD" });
  });

  it("git_status takes path as the repository", async () => {
    const { repo, tools } = setup();
    const res = await callTool(tools, "git_status", { path: repo });
    expect(res.isError).not.toBe(true);
    expect(dataOf(res).repo).toBeDefined();
  });

  it("an unknown argument lists the accepted ones", async () => {
    const { repo, tools } = setup();
    const res = await callTool(tools, "git_status", { repo, surpresa: true });
    expect(dataOf(res)).toMatchObject({ ok: false, codigo: "argumento_invalido" });
    expect(textOf(res)).toContain("Argumentos aceitos: repo, remoto");
  });
});

describe("git_remote_info through git_status in a folder that is not a project", () => {
  it("reads the remotes of any git folder", async () => {
    const dir = makeTempDir();
    const repo = makeRepo(dir, "solto");
    sh(repo, "remote", "add", "origin", "https://github.com/o/r.git");
    const tools = buildReadTools(makeDeps({}));
    const res = await callTool(tools, "git_status", { repo, remoto: true });
    expect(res.isError).not.toBe(true);
    expect(dataOf(res)).toMatchObject({ provedor: "github", dono: "o", slug: "r" });
  });

  it("write tools keep the folder restriction", async () => {
    const repo = makeRepo(makeTempDir(), "solto2");
    writeFile(repo, "x.txt", "x");
    const tools = buildWriteTools(makeDeps({}));
    const res = await callTool(tools, "git_add", { repo, caminhos: ["x.txt"] });
    expect(dataOf(res)).toMatchObject({ ok: false, codigo: "repo_nao_permitido" });
    expect(join(repo)).toBeTruthy();
  });
});

describe("project matching", () => {
  const list = [
    { name: "Timesheet Reports App", folder: "Projetos/Timesheet Reports App", clonePath: "C:\\x" },
    { name: "Clonador de Projetos", folder: "Projetos/Clonador de Projetos", clonePath: "C:\\y" },
    { name: "Clonador de Tickets", folder: "Projetos/Clonador de Tickets", clonePath: undefined },
  ];

  it("normalizes [[ ]], aliases, case and accents", () => {
    expect(normalizeProjectName("[[Clonador de Projetos|clonador]]")).toBe("clonador de projetos");
    expect(normalizeProjectName("  CLONADOR   de Projétos ")).toBe("clonador de projetos");
  });

  it("matches with or without [[ ]], without case or accent differences", () => {
    expect(matchProject(list, "[[Timesheet Reports App]]").project?.name).toBe("Timesheet Reports App");
    expect(matchProject(list, "timesheet reports app").project?.name).toBe("Timesheet Reports App");
    expect(matchProject(list, "CLONADOR DE PROJÉTOS").project?.name).toBe("Clonador de Projetos");
  });

  it("matches a unique prefix", () => {
    expect(matchProject(list, "Timesheet Reports").project?.name).toBe("Timesheet Reports App");
  });

  it("an ambiguous prefix is not picked and suggests the candidates", () => {
    const m = matchProject(list, "Clonador");
    expect(m.project).toBeUndefined();
    expect(m.sugestoes).toEqual(["Clonador de Projetos", "Clonador de Tickets"]);
  });

  it("without a match suggests the closest name", () => {
    const m = matchProject(list, "Timesheet Repots App");
    expect(m.project).toBeUndefined();
    expect(m.sugestoes[0]).toBe("Timesheet Reports App");
  });

  it("a name that only contains the text is a suggestion, never a match", () => {
    const m = matchProject(list, "Reports");
    expect(m.project).toBeUndefined();
    expect(m.sugestoes).toContain("Timesheet Reports App");
  });
});
