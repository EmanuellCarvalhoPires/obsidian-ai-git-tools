import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { HubTool } from "../../src/ecosystem/types";
import { buildGitTools, buildReadTools } from "../../src/tools/git-tools";
import { cleanupTemp, makeRepo, makeRepoWithRemote, makeTempDir, sh, writeFile } from "../helpers/git-repos";
import { callTool, dataOf, makeDeps, textOf } from "../helpers/tool-deps";

afterAll(cleanupTemp);

const READ_TOOLS = ["git_status", "git_diff", "git_log", "git_blame", "git_branches"];

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
  it("expõe as 5 tools de leitura com annotations e schema fechado", () => {
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

  it("corta lista de não rastreados acima do teto com repositório próprio", async () => {
    const repo = makeRepo();
    for (let i = 1; i <= 150; i++) {
      writeFile(repo, `lixo${i}.txt`, "x");
    }
    const myTools = buildReadTools(makeDeps({ allowed: [repo] }));
    const res = await callTool(myTools, "git_status", { repo });
    const d = dataOf(res);
    expect(d.untracked).toHaveLength(100);
    expect(d.untracked_total).toBe(150);
    expect(d.untracked_truncado).toBe(true);
    expect(textOf(res)).toContain("e mais 120");
    const lixoLines = textOf(res).split("\n").filter((l) => l.startsWith("  lixo"));
    expect(lixoLines).toHaveLength(30);

    const repo2 = makeRepo();
    writeFile(repo2, "lixo1.txt", "x");
    const myTools2 = buildReadTools(makeDeps({ allowed: [repo2] }));
    const res2 = await callTool(myTools2, "git_status", { repo: repo2 });
    const d2 = dataOf(res2);
    expect(d2.untracked_truncado).toBe(false);
    expect(d2.untracked_total).toBe(1);
  });

  it("git_status com remoto=true de URL do github, sem expor credencial, com secret só como booleano", async () => {
    const repo = makeRepo();
    sh(repo, "remote", "add", "origin", "https://u:tokensecreto@github.com/dono/proj.git");
    const withSecret = buildGitTools(makeDeps({ allowed: [repo], settings: { secretGithub: "NOME_DA_SECRET" } }));
    const semRemoto = await callTool(withSecret, "git_status", { repo });
    expect(dataOf(semRemoto).principal).toBeUndefined();
    expect(dataOf(semRemoto).provedor).toBeUndefined();
    const res = await callTool(withSecret, "git_status", { repo, remoto: true });
    expect(dataOf(res)).toMatchObject({ ok: true, provedor: "github", dono: "dono", slug: "proj", principal: "origin", secret_configurada: true });
    const dump = JSON.stringify(res);
    expect(dump).not.toContain("tokensecreto");
    expect(dump).not.toContain("NOME_DA_SECRET");
    const without = buildGitTools(makeDeps({ allowed: [repo] }));
    expect(dataOf(await callTool(without, "git_status", { repo, remoto: true }))).toMatchObject({ secret_configurada: false });
  });

  it("git_status com remoto=true de URL do bitbucket e de repositório sem remoto", async () => {
    const repo = makeRepo();
    const t = buildGitTools(makeDeps({ allowed: [repo], settings: { secretBitbucket: "BB" } }));
    expect(dataOf(await callTool(t, "git_status", { repo, remoto: true }))).toMatchObject({ ok: true, remotos: [], principal: null, secret_configurada: false });
    sh(repo, "remote", "add", "origin", "git@bitbucket.org:meu-ws/meu-repo.git");
    expect(dataOf(await callTool(t, "git_status", { repo, remoto: true }))).toMatchObject({
      provedor: "bitbucket",
      dono: "meu-ws",
      slug: "meu-repo",
      secret_configurada: true,
    });
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

  it("diff lista arquivos omitidos no texto e no structured quando cortado", async () => {
    const repo = makeRepo();
    writeFile(repo, "a.txt", "a\n");
    writeFile(repo, "b.txt", "b\n");
    sh(repo, "add", ".");
    sh(repo, "commit", "-m", "inicial");

    writeFile(repo, "README.md", "readme alterado\n");
    writeFile(repo, "a.txt", "a alterado\n");
    writeFile(repo, "b.txt", "b alterado\n");

    const repoTools = buildReadTools(makeDeps({ allowed: [repo] }));

    const cutRes = await callTool(repoTools, "git_diff", { repo, alvo: "worktree", max_bytes: 80 });
    const cutData = dataOf(cutRes);
    expect((cutData.omitidos as unknown[]).length).toBeGreaterThanOrEqual(1);
    expect(textOf(cutRes)).toContain("Arquivos que ficaram de fora");

    const fullRes = await callTool(repoTools, "git_diff", { repo, alvo: "worktree" });
    const fullData = dataOf(fullRes);
    expect(fullData.omitidos).toEqual([]);
    expect(textOf(fullRes)).not.toContain("ficaram de fora");
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
    const res = await callTool(tools, "git_log", { repo: "Alpha", limite: 5, completo: true });
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

  it("git_log sem completo devolve formato compacto", async () => {
    const res = await callTool(tools, "git_log", { repo: "Alpha" });
    const commits = dataOf(res).commits as Record<string, unknown>[];
    expect(commits.length).toBeGreaterThan(0);
    expect(Object.keys(commits[0]!).sort()).toEqual(["assunto", "autor", "data", "hash_curto"]);
    expect(String(commits[0]!["data"])).toHaveLength(10);
  });

  it("git_log com completo=true inclui hash de 40 caracteres, email e pais", async () => {
    const res = await callTool(tools, "git_log", { repo: "Alpha", completo: true });
    const commits = dataOf(res).commits as Record<string, unknown>[];
    expect(commits.length).toBeGreaterThan(0);
    const c = commits[0]!;
    expect(c).toHaveProperty("hash");
    expect(String(c["hash"])).toHaveLength(40);
    expect(c).toHaveProperty("email");
    expect(c).toHaveProperty("pais");
  });

  it("git_log padrão traz 10 commits e pode_haver_mais true em repo com 12 commits", async () => {
    const repo = makeRepo();
    for (let i = 1; i <= 11; i++) {
      writeFile(repo, `arq${i}.txt`, `c${i}\n`);
      sh(repo, "add", `arq${i}.txt`);
      sh(repo, "commit", "-m", `c${i}`);
    }
    const myTools = buildReadTools(makeDeps({ allowed: [repo] }));
    const res = await callTool(myTools, "git_log", { repo });
    const d = dataOf(res);
    expect(d.total).toBe(10);
    expect(d.pode_haver_mais).toBe(true);
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

  it("git_blame agrupa texto por commit e structuredContent traz commits sem repetição", async () => {
    const repo = makeRepo();
    writeFile(repo, "dois.txt", "a\nb\n");
    sh(repo, "add", "dois.txt");
    sh(repo, "commit", "-m", "um");
    writeFile(repo, "dois.txt", "a\nc\n");
    sh(repo, "add", "dois.txt");
    sh(repo, "commit", "-m", "dois");

    const myTools = buildReadTools(makeDeps({ allowed: [repo] }));
    const res = await callTool(myTools, "git_blame", { repo, caminho: "dois.txt" });
    const textLines = textOf(res).split("\n");
    const atLines = textLines.filter((l) => l.startsWith("@ "));
    expect(atLines).toHaveLength(2);

    const d = dataOf(res);
    const commits = d.commits as { autor: string }[];
    expect(commits).toHaveLength(2);
    expect(commits.every((c) => c.autor === "Teste")).toBe(true);

    const linhas = d.linhas as { commit: string }[];
    expect(linhas).toHaveLength(2);
    expect(linhas.every((l) => l.commit.length === 7)).toBe(true);

    writeFile(repo, "tres_linhas.txt", "1\n2\n3\n");
    sh(repo, "add", "tres_linhas.txt");
    sh(repo, "commit", "-m", "tres");

    const res2 = await callTool(myTools, "git_blame", { repo, caminho: "tres_linhas.txt" });
    const atLines2 = textOf(res2).split("\n").filter((l) => l.startsWith("@ "));
    expect(atLines2).toHaveLength(1);
    const commits2 = dataOf(res2).commits as unknown[];
    expect(commits2).toHaveLength(1);
  });
});

describe("git_branches", () => {
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

  it("git_branches lista somente branches do remoto não buscadas e compacta remotas", async () => {
    const r = makeRepoWithRemote();
    const tmp = makeTempDir();
    sh(tmp, "clone", "-q", r.remote, "outro");
    const outro = join(tmp, "outro");
    sh(outro, "config", "user.name", "O");
    sh(outro, "config", "user.email", "o@example.com");
    sh(outro, "checkout", "-q", "-b", "nova");
    writeFile(outro, "n.txt", "n");
    sh(outro, "add", "-A");
    sh(outro, "commit", "-q", "-m", "n");
    sh(outro, "push", "-q", "origin", "nova");

    const myTools = buildReadTools(makeDeps({ allowed: [r.repo] }));
    const res = await callTool(myTools, "git_branches", { repo: r.repo, remotas: true });
    const d = dataOf(res);
    const rv = d.remoto_vivo as { somente_no_remoto: string[]; total: number; branches?: unknown };
    expect(rv.somente_no_remoto).toEqual(["nova"]);
    expect(rv.total).toBe(2);
    expect(rv.branches).toBeUndefined();

    const remotas = d.remotas as Record<string, unknown>[];
    expect(remotas.length).toBeGreaterThan(0);
    expect(Object.keys(remotas[0]!).sort()).toEqual(["assunto", "data", "hash", "nome"]);
    expect(textOf(res)).toContain("ainda não buscadas");

    sh(r.repo, "fetch", "-q");

    const resApos = await callTool(myTools, "git_branches", { repo: r.repo, remotas: true });
    const dApos = dataOf(resApos);
    const rvApos = dApos.remoto_vivo as { somente_no_remoto: string[] };
    expect(rvApos.somente_no_remoto).toEqual([]);
    expect(textOf(resApos)).not.toContain("ainda não buscadas");
  });

  it("git_branches marca branches que sumiram do remoto no texto e no structured", async () => {
    const r = makeRepoWithRemote();
    sh(r.repo, "branch", "x");
    sh(r.repo, "push", "-q", "-u", "origin", "x");

    const tmp = makeTempDir();
    sh(tmp, "clone", "-q", r.remote, "outro");
    sh(join(tmp, "outro"), "push", "-q", "origin", "--delete", "x");

    const myTools = buildReadTools(makeDeps({ allowed: [r.repo] }));
    const res = await callTool(myTools, "git_branches", { repo: r.repo, remotas: true });
    const text = textOf(res);
    const d = dataOf(res);

    const lines = text.split("\n");
    const originLine = lines.find((l) => l.trimStart().startsWith("origin/x"));
    expect(originLine).toBeDefined();
    expect(originLine).toContain("(sumiu do remoto)");

    const localLine = lines.find((l) => l.trimStart().startsWith("x "));
    expect(localLine).toBeDefined();
    expect(localLine).toContain("(sumiu do remoto)");

    const remotas = d.remotas as Record<string, unknown>[];
    const originX = remotas.find((b) => b["nome"] === "origin/x");
    const originMain = remotas.find((b) => b["nome"] === "origin/main");
    expect(originX).toBeDefined();
    expect(originX!["sumiu_do_remoto"]).toBe(true);
    expect(originMain).toBeDefined();
    expect(Object.keys(originMain!)).not.toContain("sumiu_do_remoto");
  });

  it("o redact configurado limpa a mensagem de erro", async () => {
    const t = buildGitTools(makeDeps({ projects: [], redact: (s) => s.replace(/Projeto/g, "[REDACTED]") }));
    const res = await callTool(t, "git_status", { repo: "Qualquer" });
    expect(textOf(res)).toContain("[REDACTED]");
  });
});
