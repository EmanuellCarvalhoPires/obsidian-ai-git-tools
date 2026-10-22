import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { HubTool } from "../../src/ecosystem/types";
import { buildGitTools, buildReadTools } from "../../src/tools/git-tools";
import { cleanupTemp, makeRepo, makeRepoWithRemote, makeTempDir, sh, writeFile } from "../helpers/git-repos";
import { callTool, dataOf, makeDeps, textOf } from "../helpers/tool-deps";

afterAll(cleanupTemp);

const READ_TOOLS = ["git_status", "git_diff", "git_log", "git_blame", "git_branches", "git_remote_info"];

// base/
//   alpha     repository of the project "Alpha" (origin = bare remote)
//   fora      repository nobody allowed
let alpha: string;
let fora: string;
let tools: HubTool[];

beforeAll(() => {
  const r = makeRepoWithRemote();
  alpha = r.repo;
  fora = makeRepo(makeTempDir(), "fora");
  tools = buildReadTools(makeDeps({ projects: [{ name: "Alpha", clone: alpha }] }));
});

describe("registro", () => {
  it("expõe as 6 tools de leitura com annotations e schema fechado", () => {
    expect(tools.map((t) => t.name)).toEqual(READ_TOOLS);
    for (const t of tools) {
      expect(t.annotations).toEqual({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
      expect(t.inputSchema).toMatchObject({ type: "object", additionalProperties: false });
      expect((t.inputSchema.required as string[]).includes("repo")).toBe(true);
      expect(t.description.length).toBeGreaterThan(20);
    }
  });

  it("alvo do git_diff é um enum e as obrigatórias estão declaradas", () => {
    const diff = tools.find((t) => t.name === "git_diff");
    const props = diff?.inputSchema.properties as Record<string, { enum?: string[] }>;
    expect(props.alvo?.enum).toEqual(["worktree", "staged", "refs"]);
    expect(diff?.inputSchema.required).toEqual(["repo", "alvo"]);
    expect(tools.find((t) => t.name === "git_blame")?.inputSchema.required).toEqual(["repo", "caminho"]);
  });
});

describe("erros comuns a todas as tools", () => {
  it.each(READ_TOOLS)("%s: repositório fora da lista -> repo_nao_permitido", async (name) => {
    const args: Record<string, unknown> = { repo: fora };
    if (name === "git_diff") args.alvo = "worktree";
    if (name === "git_blame") args.caminho = "README.md";
    const res = await callTool(tools, name, args);
    expect(res.isError).toBe(true);
    expect(dataOf(res)).toMatchObject({ ok: false, codigo: "repo_nao_permitido" });
  });

  it.each(READ_TOOLS)("%s: sem repo e com argumento desconhecido -> argumento_invalido", async (name) => {
    const noRepo = await callTool(tools, name, {});
    expect(dataOf(noRepo)).toMatchObject({ ok: false, codigo: "argumento_invalido" });
    const extra = await callTool(tools, name, { repo: "Alpha", surpresa: true });
    expect(dataOf(extra)).toMatchObject({ ok: false, codigo: "argumento_invalido" });
    expect(textOf(extra)).toContain("surpresa");
  });

  it("projeto inexistente -> repo_nao_permitido", async () => {
    const res = await callTool(tools, "git_status", { repo: "Nao Existe" });
    expect(dataOf(res)).toMatchObject({ codigo: "repo_nao_permitido" });
  });
});

describe("git_status", () => {
  it("devolve o formato de structuredContent do contrato", async () => {
    writeFile(alpha, "novo.txt", "n\n");
    sh(alpha, "add", "novo.txt");
    writeFile(alpha, "README.md", "# alterado\n");
    writeFile(alpha, "solto.txt", "s\n");
    const res = await callTool(tools, "git_status", { repo: "Alpha" });
    expect(res.isError).toBeUndefined();
    const d = dataOf(res);
    expect(d).toMatchObject({
      ok: true,
      projeto: "Alpha",
      branch: "main",
      upstream: "origin/main",
      ahead: 0,
      behind: 0,
      staged: [{ caminho: "novo.txt", status: "A", rotulo: "adicionado" }],
      unstaged: [{ caminho: "README.md", status: "M", rotulo: "modificado" }],
      untracked: ["solto.txt"],
      conflitos: [],
      limpo: false,
    });
    expect(textOf(res)).toContain("Branch main -> origin/main (0 à frente, 0 atrás).");
    expect(textOf(res)).toContain("No stage (1):");
    // clean the state for the next tests
    sh(alpha, "reset", "-q");
    sh(alpha, "checkout", "--", "README.md");
    writeFile(alpha, "solto.txt", "");
  });

  it("aceita o caminho absoluto de um repositório permitido", async () => {
    const res = await callTool(tools, "git_status", { repo: alpha });
    expect(dataOf(res)).toMatchObject({ ok: true, branch: "main" });
  });
});

describe("git_diff, git_log e git_blame", () => {
  it("diff de worktree com texto e truncamento", async () => {
    writeFile(alpha, "README.md", `# teste\n${"linha nova ção\n".repeat(400)}`);
    const res = await callTool(tools, "git_diff", { repo: "Alpha", alvo: "worktree", max_bytes: 500 });
    expect(dataOf(res)).toMatchObject({ ok: true, alvo: "worktree", truncado: true, vazio: false });
    expect(dataOf(res).bytes as number).toBeLessThanOrEqual(500);
    expect(textOf(res)).toContain("truncado");
    sh(alpha, "checkout", "--", "README.md");
    const clean = await callTool(tools, "git_diff", { repo: "Alpha", alvo: "worktree" });
    expect(dataOf(clean)).toMatchObject({ ok: true, vazio: true });
  });

  it("diff refs sem base -> argumento_invalido; alvo inválido também", async () => {
    expect(dataOf(await callTool(tools, "git_diff", { repo: "Alpha", alvo: "refs" }))).toMatchObject({ codigo: "argumento_invalido" });
    expect(dataOf(await callTool(tools, "git_diff", { repo: "Alpha", alvo: "tudo" }))).toMatchObject({ codigo: "argumento_invalido" });
    expect(dataOf(await callTool(tools, "git_diff", { repo: "Alpha", alvo: "refs", base: "--output=x" }))).toMatchObject({ codigo: "argumento_invalido" });
  });

  it("log com mensagem multilinha e acentos; depois o commit pelo hash", async () => {
    writeFile(alpha, "ação.txt", "x\n");
    sh(alpha, "add", "ação.txt");
    sh(alpha, "commit", "-m", "Inclui a ação\n\nCorpo da mensagem\ncom três linhas.");
    const res = await callTool(tools, "git_log", { repo: "Alpha", limite: 5 });
    const commits = dataOf(res).commits as { assunto: string; hash: string }[];
    expect(commits[0]?.assunto).toBe("Inclui a ação");
    expect(commits).toHaveLength(2);
    expect(textOf(res)).toContain("Inclui a ação");
    const one = await callTool(tools, "git_log", { repo: "Alpha", hash: commits[0]?.hash });
    const c = (dataOf(one).commits as { corpo?: string }[])[0];
    expect(c?.corpo).toBe("Corpo da mensagem\ncom três linhas.");
    expect(String(dataOf(one).estatistica)).toContain("ação.txt");
    expect(dataOf(await callTool(tools, "git_log", { repo: "Alpha", limite: 500 }))).toMatchObject({ codigo: "argumento_invalido" });
    expect(dataOf(await callTool(tools, "git_log", { repo: "Alpha", limite: "muitos" }))).toMatchObject({ codigo: "argumento_invalido" });
  });

  it("blame de um intervalo e arquivo inexistente -> git_falhou", async () => {
    writeFile(alpha, "tres.txt", "a\nb\nc\n");
    sh(alpha, "add", "tres.txt");
    sh(alpha, "commit", "-m", "tres linhas");
    const res = await callTool(tools, "git_blame", { repo: "Alpha", caminho: "tres.txt", linha_inicio: 2, linha_fim: 3 });
    const linhas = dataOf(res).linhas as { linha: number; conteudo: string }[];
    expect(linhas.map((l) => l.conteudo)).toEqual(["b", "c"]);
    expect(textOf(res)).toContain("2 linha(s) de tres.txt");
    expect(dataOf(await callTool(tools, "git_blame", { repo: "Alpha", caminho: "nao-existe.txt" }))).toMatchObject({ ok: false, codigo: "git_falhou" });
    expect(dataOf(await callTool(tools, "git_blame", { repo: "Alpha", caminho: "../fora.txt" }))).toMatchObject({ codigo: "argumento_invalido" });
  });
});

describe("git_branches e git_remote_info", () => {
  it("branches com remoto bare", async () => {
    sh(alpha, "push", "origin", "main");
    sh(alpha, "branch", "feature/z");
    const res = await callTool(tools, "git_branches", { repo: "Alpha", remotas: true });
    const d = dataOf(res);
    expect(d).toMatchObject({ ok: true, atual: "main" });
    expect((d.locais as { nome: string }[]).map((b) => b.nome).sort()).toEqual(["feature/z", "main"]);
    expect((d.remoto_vivo as { ok: boolean }).ok).toBe(true);
    expect(d.avisos).toBeUndefined();
    expect(dataOf(await callTool(tools, "git_branches", { repo: "Alpha", mescladas_em: "--all" }))).toMatchObject({ codigo: "argumento_invalido" });
  });

  it("branches com remoto inacessível devolve aviso e continua ok", async () => {
    const repo = makeRepo();
    sh(repo, "remote", "add", "origin", `${makeTempDir()}/nao-existe.git`);
    const local = buildGitTools(makeDeps({ allowed: [repo] }));
    const res = await callTool(local, "git_branches", { repo, remotas: true });
    expect(res.isError).toBeUndefined();
    expect(dataOf(res).avisos).toHaveLength(1);
  });

  it("remote_info de URL do github, sem expor credencial, com secret só como booleano", async () => {
    const repo = makeRepo();
    sh(repo, "remote", "add", "origin", "https://u:tokensecreto@github.com/dono/proj.git");
    const withSecret = buildGitTools(makeDeps({ allowed: [repo], settings: { secretGithub: "NOME_DA_SECRET" } }));
    const res = await callTool(withSecret, "git_remote_info", { repo });
    expect(dataOf(res)).toMatchObject({ ok: true, provedor: "github", dono: "dono", slug: "proj", principal: "origin", secret_configurada: true });
    const dump = JSON.stringify(res);
    expect(dump).not.toContain("tokensecreto");
    expect(dump).not.toContain("NOME_DA_SECRET");
    const without = buildGitTools(makeDeps({ allowed: [repo] }));
    expect(dataOf(await callTool(without, "git_remote_info", { repo }))).toMatchObject({ secret_configurada: false });
  });

  it("remote_info de URL do bitbucket e de repositório sem remoto", async () => {
    const repo = makeRepo();
    const t = buildGitTools(makeDeps({ allowed: [repo], settings: { secretBitbucket: "BB" } }));
    expect(dataOf(await callTool(t, "git_remote_info", { repo }))).toMatchObject({ ok: true, remotos: [], principal: null, secret_configurada: false });
    sh(repo, "remote", "add", "origin", "git@bitbucket.org:meu-ws/meu-repo.git");
    expect(dataOf(await callTool(t, "git_remote_info", { repo }))).toMatchObject({
      provedor: "bitbucket",
      dono: "meu-ws",
      slug: "meu-repo",
      secret_configurada: true,
    });
  });

  it("o redact configurado limpa a mensagem de erro", async () => {
    const t = buildGitTools(makeDeps({ projects: [], redact: (s) => s.replace(/Projeto/g, "[REDACTED]") }));
    const res = await callTool(t, "git_status", { repo: "Qualquer" });
    expect(textOf(res)).toContain("[REDACTED]");
  });
});
