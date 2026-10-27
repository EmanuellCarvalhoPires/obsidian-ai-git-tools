import { afterAll, describe, expect, it } from "vitest";
import type { HubTool } from "../../src/ecosystem/types";
import { buildGitTools } from "../../src/tools/git-tools";
import type { GitToolDeps } from "../../src/tools/git-tools";
import { cleanupTemp, makeRepo, makeRepoWithRemote, makeTempDir, sh, writeFile } from "../helpers/git-repos";
import { MUTATING, configureClone, spyGit } from "../helpers/spy-git";
import type { SpyGit } from "../helpers/spy-git";
import { callTool, dataOf, makeDeps, textOf } from "../helpers/tool-deps";

afterAll(cleanupTemp);

const WRITE_TOOLS = ["git_fetch", "git_checkout", "git_add", "git_commit", "git_push", "git_pull"];

interface Env {
  base: string;
  repo: string;
  remote: string;
  tools: HubTool[];
  spy: SpyGit;
}

/** Project "Alpha" (clone with a bare remote), its tools wired to a recording git runner. */
function env(redact?: (text: string) => string): Env {
  const { base, repo, remote } = makeRepoWithRemote();
  const spy = spyGit();
  const deps: GitToolDeps = { ...makeDeps({ projects: [{ name: "Alpha", clone: repo }], redact }), git: spy.git };
  return { base, repo, remote, tools: buildGitTools(deps), spy };
}

const heads = (remote: string): string => sh(remote, "for-each-ref", "--format=%(refname) %(objectname)", "refs/heads");

describe("registro", () => {
  it("expõe as 6 tools de escrita depois das de leitura, com annotations e schema fechado", () => {
    const tools = buildGitTools(makeDeps());
    const names = tools.map((t) => t.name);
    expect(names.slice(0, 5)).toEqual(["git_status", "git_diff", "git_log", "git_blame", "git_branches"]);
    expect(names.slice(5, 11)).toEqual(WRITE_TOOLS);
    for (const name of WRITE_TOOLS) {
      const t = tools.find((x) => x.name === name);
      expect(t?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false });
      expect(t?.annotations?.openWorldHint).toBe(["git_fetch", "git_push", "git_pull"].includes(name));
      expect(t?.inputSchema).toMatchObject({ type: "object", additionalProperties: false });
      expect((t?.inputSchema.required as string[]).includes("repo")).toBe(true);
    }
    expect(tools.find((t) => t.name === "git_fetch")?.annotations?.idempotentHint).toBe(true);
    const required = (n: string): unknown => tools.find((t) => t.name === n)?.inputSchema.required;
    expect(required("git_checkout")).toEqual(["repo", "branch"]);
    expect(required("git_commit")).toEqual(["repo", "mensagem"]);
    const pull = tools.find((t) => t.name === "git_pull")?.inputSchema.properties as Record<string, { enum?: string[] }>;
    expect(pull.modo?.enum).toEqual(["ff-only", "merge"]);
  });
});

describe("erros comuns", () => {
  it.each(WRITE_TOOLS)("%s: repositório fora da lista -> repo_nao_permitido e nada é executado", async (name) => {
    const e = env();
    const fora = makeRepo(makeTempDir(), "fora");
    const args: Record<string, unknown> = { repo: fora, branch: "x", mensagem: "m", todos: true };
    for (const k of Object.keys(args)) if (!(k in (e.tools.find((t) => t.name === name)?.inputSchema.properties as object))) delete args[k];
    e.spy.reset();
    const res = await callTool(e.tools, name, args);
    expect(dataOf(res)).toMatchObject({ ok: false, codigo: "repo_nao_permitido" });
    expect(e.spy.callsTo(...MUTATING)).toEqual([]);
  });

  it.each(WRITE_TOOLS)("%s: argumento desconhecido -> argumento_invalido", async (name) => {
    const e = env();
    const res = await callTool(e.tools, name, { repo: "Alpha", surpresa: 1 });
    expect(dataOf(res)).toMatchObject({ ok: false, codigo: "argumento_invalido" });
    expect(textOf(res)).toContain("surpresa");
  });

  it("aplica o redact do Environment Keys no texto de erro", async () => {
    const e = env((t) => t.replace(/naoexiste/g, "[oculto]"));
    const res = await callTool(e.tools, "git_fetch", { repo: "Alpha", remoto: "naoexiste" });
    expect(dataOf(res).codigo).toBe("argumento_invalido");
    expect(textOf(res)).toContain("[oculto]");
    expect(textOf(res)).not.toContain("naoexiste");
  });
});

describe("fluxo add -> commit -> push", () => {
  it("com definir_upstream: branch nova no remoto, hash, upstream e structuredContent do contrato", async () => {
    const e = env();
    expect(dataOf(await callTool(e.tools, "git_checkout", { repo: "Alpha", branch: "feature/login", criar: true }))).toMatchObject({ ok: true, criada: true });
    writeFile(e.repo, "login.txt", "login\n");
    const add = await callTool(e.tools, "git_add", { repo: "Alpha", caminhos: ["login.txt"] });
    expect(dataOf(add)).toMatchObject({ ok: true, adicionados: ["login.txt"] });
    expect((dataOf(add).staged as { caminho: string }[]).map((s) => s.caminho)).toEqual(["login.txt"]);

    const commit = await callTool(e.tools, "git_commit", { repo: "Alpha", mensagem: "feat: login", descricao: "Detalhe 1\nDetalhe 2" });
    const c = dataOf(commit);
    expect(c).toMatchObject({ ok: true, branch: "feature/login", titulo: "feat: login", arquivos: ["login.txt"] });
    expect(c.hash).toBe(sh(e.repo, "rev-parse", "HEAD").trim());
    expect(c.hash_curto).toBe((c.hash as string).slice(0, 7));
    expect(textOf(commit)).toContain("feat: login");

    const push = await callTool(e.tools, "git_push", { repo: "Alpha", definir_upstream: true });
    expect(dataOf(push)).toMatchObject({
      ok: true,
      remoto: "origin",
      branch: "feature/login",
      hash: c.hash,
      branch_nova: true,
      upstream_definido: true,
    });
    expect(heads(e.remote)).toContain(`refs/heads/feature/login ${c.hash as string}`);
    expect(sh(e.repo, "rev-parse", "--abbrev-ref", "@{upstream}").trim()).toBe("origin/feature/login");
  });

  it("sem definir_upstream: envia e não liga o upstream", async () => {
    const e = env();
    sh(e.repo, "switch", "-c", "sem-up");
    writeFile(e.repo, "s.txt", "s\n");
    await callTool(e.tools, "git_add", { repo: "Alpha", todos: true });
    await callTool(e.tools, "git_commit", { repo: "Alpha", mensagem: "s" });
    const push = await callTool(e.tools, "git_push", { repo: "Alpha", branch: "sem-up" });
    expect(dataOf(push)).toMatchObject({ ok: true, branch_nova: true, upstream_definido: false });
    expect(() => sh(e.repo, "rev-parse", "--abbrev-ref", "@{upstream}")).toThrow();
  });

  it("commit com mensagem de 3 linhas: o commit tem as 3 linhas e a resposta traz o hash", async () => {
    const e = env();
    writeFile(e.repo, "t.txt", "t\n");
    await callTool(e.tools, "git_add", { repo: "Alpha", caminhos: ["t.txt"] });
    const res = await callTool(e.tools, "git_commit", { repo: "Alpha", mensagem: "Primeira linha\n\nTerceira linha" });
    expect(dataOf(res).hash).toBe(sh(e.repo, "rev-parse", "HEAD").trim());
    expect(sh(e.repo, "log", "-1", "--format=%B").trimEnd().split("\n")).toEqual(["Primeira linha", "", "Terceira linha"]);
  });
});

describe("git_commit: nada para commitar", () => {
  it("devolve nada_a_commitar e não cria commit", async () => {
    const e = env();
    const before = sh(e.repo, "rev-parse", "HEAD");
    const res = await callTool(e.tools, "git_commit", { repo: "Alpha", mensagem: "nada" });
    expect(res.isError).toBe(true);
    expect(dataOf(res)).toMatchObject({ ok: false, codigo: "nada_a_commitar" });
    expect(sh(e.repo, "rev-parse", "HEAD")).toBe(before);
    expect(e.spy.callsTo("commit")).toEqual([]);
  });

  it("permitir_vazio cria o commit", async () => {
    const e = env();
    const res = await callTool(e.tools, "git_commit", { repo: "Alpha", mensagem: "vazio", permitir_vazio: true });
    expect(dataOf(res)).toMatchObject({ ok: true, arquivos: [] });
  });

  it("mensagem vazia -> argumento_invalido", async () => {
    const e = env();
    const res = await callTool(e.tools, "git_commit", { repo: "Alpha", mensagem: "  " });
    expect(dataOf(res)).toMatchObject({ codigo: "argumento_invalido" });
  });
});

describe("git_push", () => {
  it("remoto à frente: git_falhou com dica de git_pull e nada é sobrescrito", async () => {
    const e = env();
    sh(e.base, "clone", e.remote, "outro");
    const outro = `${e.base}/outro`;
    configureClone(sh, outro);
    writeFile(outro, "remoto.txt", "r\n");
    sh(outro, "add", "remoto.txt");
    sh(outro, "commit", "-m", "remoto");
    sh(outro, "push", "origin", "main");
    const remoteTip = sh(outro, "rev-parse", "HEAD").trim();
    writeFile(e.repo, "local.txt", "l\n");
    await callTool(e.tools, "git_add", { repo: "Alpha", todos: true });
    await callTool(e.tools, "git_commit", { repo: "Alpha", mensagem: "local" });

    const res = await callTool(e.tools, "git_push", { repo: "Alpha" });
    expect(res.isError).toBe(true);
    expect(dataOf(res)).toMatchObject({ ok: false, codigo: "git_falhou" });
    expect(String(dataOf(res).dica)).toContain("git_pull");
    expect(heads(e.remote)).toContain(`refs/heads/main ${remoteTip}`);

    // the hint works: pull in merge mode, then the push goes through
    expect(dataOf(await callTool(e.tools, "git_pull", { repo: "Alpha", modo: "merge" }))).toMatchObject({ ok: true, atualizado: true });
    expect(dataOf(await callTool(e.tools, "git_push", { repo: "Alpha" }))).toMatchObject({ ok: true, branch_nova: false });
  });

  it("push de tag", async () => {
    const e = env();
    sh(e.repo, "tag", "-a", "v0.1.0", "-m", "primeira");
    const res = await callTool(e.tools, "git_push", { repo: "Alpha", tag: "v0.1.0" });
    expect(dataOf(res)).toMatchObject({ ok: true, tag: "v0.1.0", branch: null, tag_nova: true });
    expect(sh(e.remote, "tag", "--list")).toContain("v0.1.0");
  });

  it("HEAD solto sem branch -> argumento_invalido", async () => {
    const e = env();
    sh(e.repo, "switch", "--detach", "HEAD");
    expect(dataOf(await callTool(e.tools, "git_push", { repo: "Alpha" }))).toMatchObject({ ok: false, codigo: "argumento_invalido" });
  });

  it.each([
    [{ branch: "--force" }],
    [{ branch: "-f" }],
    [{ branch: "+main" }],
    [{ branch: ":main" }],
    [{ branch: "main:" }],
    [{ branch: "-D" }],
    [{ branch: "--delete" }],
    [{ tag: "--force" }],
    [{ tag: "+v1" }],
    [{ tag: ":v1" }],
    [{ remoto: "--force" }],
    [{ remoto: "--all" }],
    [{ remoto: "https://example.com/x.git" }],
    [{ branch: "main", tag: "v1" }],
  ])("recusa %j: argumento_invalido, o git de escrita não é chamado e o remoto fica igual", async (extra) => {
    const e = env();
    const before = heads(e.remote);
    e.spy.reset();
    const res = await callTool(e.tools, "git_push", { repo: "Alpha", ...extra });
    expect(dataOf(res)).toMatchObject({ ok: false, codigo: "argumento_invalido" });
    expect(e.spy.callsTo(...MUTATING)).toEqual([]);
    expect(heads(e.remote)).toBe(before);
  });
});

describe("git_add: arquivos sensíveis", () => {
  it(".env sem confirmar_sensivel não é adicionado e a resposta explica e lista", async () => {
    const e = env();
    writeFile(e.repo, ".env", "TOKEN=abc\n");
    writeFile(e.repo, "ok.txt", "ok\n");
    for (const args of [{ caminhos: [".env"] }, { todos: true }]) {
      const res = await callTool(e.tools, "git_add", { repo: "Alpha", ...args });
      expect(res.isError).toBe(true);
      const d = dataOf(res);
      expect(d).toMatchObject({ ok: false, codigo: "argumento_invalido", arquivos_sensiveis: [".env"] });
      expect(textOf(res)).toContain(".env");
      expect(textOf(res)).toContain("confirmar_sensivel");
    }
    expect(sh(e.repo, "diff", "--cached", "--name-only").trim()).toBe("");
  });

  it("com confirmar_sensivel o arquivo é adicionado e vem um aviso", async () => {
    const e = env();
    writeFile(e.repo, ".env", "TOKEN=abc\n");
    const res = await callTool(e.tools, "git_add", { repo: "Alpha", caminhos: [".env"], confirmar_sensivel: true });
    expect(dataOf(res)).toMatchObject({ ok: true, adicionados: [".env"], sensiveis_confirmados: [".env"] });
    expect(String(dataOf(res).avisos)).toContain(".env");
    expect(sh(e.repo, "diff", "--cached", "--name-only").trim()).toBe(".env");
  });

  it("caminhos e todos juntos, ou nenhum dos dois -> argumento_invalido", async () => {
    const e = env();
    expect(dataOf(await callTool(e.tools, "git_add", { repo: "Alpha", caminhos: ["a"], todos: true }))).toMatchObject({ codigo: "argumento_invalido" });
    expect(dataOf(await callTool(e.tools, "git_add", { repo: "Alpha" }))).toMatchObject({ codigo: "argumento_invalido" });
    expect(dataOf(await callTool(e.tools, "git_add", { repo: "Alpha", caminhos: "a.txt" }))).toMatchObject({ codigo: "argumento_invalido" });
  });

  it.each([["--force"], ["-A"], [":(top)x"], ["../x"], ["-u"]])("recusa o caminho %j sem chamar o git de escrita", async (p) => {
    const e = env();
    e.spy.reset();
    const res = await callTool(e.tools, "git_add", { repo: "Alpha", caminhos: [p] });
    expect(dataOf(res)).toMatchObject({ codigo: "argumento_invalido" });
    expect(e.spy.callsTo(...MUTATING)).toEqual([]);
  });
});

describe("git_checkout", () => {
  it("criar com base", async () => {
    const e = env();
    const first = sh(e.repo, "rev-parse", "HEAD").trim();
    writeFile(e.repo, "a.txt", "a\n");
    sh(e.repo, "add", "a.txt");
    sh(e.repo, "commit", "-m", "a");
    const res = await callTool(e.tools, "git_checkout", { repo: "Alpha", branch: "bugfix/z", criar: true, base: first });
    expect(dataOf(res)).toMatchObject({ ok: true, branch: "bugfix/z", anterior: "main", criada: true, base: first, hash: first });
    expect(dataOf(res).avisos).toBeUndefined();
  });

  it("criar sem base usa HEAD e devolve aviso", async () => {
    const e = env();
    const res = await callTool(e.tools, "git_checkout", { repo: "Alpha", branch: "nova", criar: true });
    expect(dataOf(res)).toMatchObject({ ok: true, criada: true, base: "HEAD" });
    expect((dataOf(res).avisos as string[]).join(" ")).toMatch(/HEAD/);
    expect(textOf(res)).toMatch(/HEAD/);
  });

  it("troca para uma branch existente", async () => {
    const e = env();
    sh(e.repo, "branch", "outra");
    expect(dataOf(await callTool(e.tools, "git_checkout", { repo: "Alpha", branch: "outra" }))).toMatchObject({ ok: true, branch: "outra", criada: false });
    expect(dataOf(await callTool(e.tools, "git_checkout", { repo: "Alpha", branch: "main" }))).toMatchObject({ ok: true, branch: "main", anterior: "outra" });
  });

  it.each([["--force"], ["-f"], ["--discard-changes"], ["-D"], ["a..b"], ["a b"], ["x~1"], ["@{-1}"], ["a:b"]])("recusa o nome %j sem chamar o git de escrita", async (branch) => {
    const e = env();
    e.spy.reset();
    for (const criar of [true, false]) {
      const res = await callTool(e.tools, "git_checkout", { repo: "Alpha", branch, criar });
      expect(dataOf(res)).toMatchObject({ ok: false, codigo: "argumento_invalido" });
    }
    expect(e.spy.callsTo(...MUTATING)).toEqual([]);
    expect(sh(e.repo, "branch", "--list").trim()).toBe("* main");
  });

  it("recusa base com flag ou base sem criar", async () => {
    const e = env();
    e.spy.reset();
    expect(dataOf(await callTool(e.tools, "git_checkout", { repo: "Alpha", branch: "ok", criar: true, base: "--force" }))).toMatchObject({ codigo: "argumento_invalido" });
    expect(dataOf(await callTool(e.tools, "git_checkout", { repo: "Alpha", branch: "ok", base: "main" }))).toMatchObject({ codigo: "argumento_invalido" });
    expect(e.spy.callsTo(...MUTATING)).toEqual([]);
  });

  it("não descarta alterações: troca que perderia trabalho vira git_falhou", async () => {
    const e = env();
    sh(e.repo, "switch", "-c", "b");
    writeFile(e.repo, "README.md", "# na b\n");
    sh(e.repo, "commit", "-am", "b");
    sh(e.repo, "switch", "main");
    writeFile(e.repo, "README.md", "# sujo\n");
    const res = await callTool(e.tools, "git_checkout", { repo: "Alpha", branch: "b" });
    expect(dataOf(res)).toMatchObject({ ok: false, codigo: "git_falhou" });
    expect(sh(e.repo, "branch", "--show-current").trim()).toBe("main");
  });
});

describe("git_pull", () => {
  function behind(e: Env, name: string, content = `${name}\n`): void {
    sh(e.base, "clone", e.remote, `outro-${name}`);
    const outro = `${e.base}/outro-${name}`;
    configureClone(sh, outro);
    writeFile(outro, name, content);
    sh(outro, "add", name);
    sh(outro, "commit", "-m", `outro ${name}`);
    sh(outro, "push", "origin", "main");
  }

  it("ff-only traz os commits novos", async () => {
    const e = env();
    behind(e, "novo.txt");
    const res = await callTool(e.tools, "git_pull", { repo: "Alpha" });
    expect(dataOf(res)).toMatchObject({ ok: true, modo: "ff-only", atualizado: true, commits_novos: 1 });
    expect(sh(e.repo, "ls-files")).toContain("novo.txt");
  });

  it("ff-only com divergência -> git_falhou com dica do modo merge", async () => {
    const e = env();
    behind(e, "r.txt");
    writeFile(e.repo, "l.txt", "l\n");
    sh(e.repo, "add", "l.txt");
    sh(e.repo, "commit", "-m", "local");
    const res = await callTool(e.tools, "git_pull", { repo: "Alpha" });
    expect(dataOf(res)).toMatchObject({ ok: false, codigo: "git_falhou" });
    expect(String(dataOf(res).dica)).toContain("merge");
  });

  it("modo merge com conflito -> conflito com a lista de arquivos", async () => {
    const e = env();
    behind(e, "f.txt", "do outro\n");
    writeFile(e.repo, "f.txt", "do local\n");
    sh(e.repo, "add", "f.txt");
    sh(e.repo, "commit", "-m", "local");
    const res = await callTool(e.tools, "git_pull", { repo: "Alpha", modo: "merge" });
    expect(res.isError).toBe(true);
    expect(dataOf(res)).toMatchObject({ ok: false, codigo: "conflito", conflitos: ["f.txt"] });
    expect(textOf(res)).toContain("f.txt");
  });

  it.each([["rebase"], ["--rebase"], [""]])("recusa o modo %j; rebase não existe", async (modo) => {
    const e = env();
    e.spy.reset();
    const res = await callTool(e.tools, "git_pull", { repo: "Alpha", modo });
    // "" is treated as not informed by optString: the default ff-only runs
    if (modo === "") expect(dataOf(res).ok).toBe(true);
    else expect(dataOf(res)).toMatchObject({ ok: false, codigo: "argumento_invalido" });
    expect(e.spy.callsTo("pull").every((c) => !c.join(" ").includes("--rebase"))).toBe(true);
  });

  it.each([[{ remoto: "--rebase" }], [{ remoto: "--force" }], [{ branch: "+main" }], [{ branch: "-f" }], [{ branch: ":main" }]])("recusa %j sem chamar o pull", async (extra) => {
    const e = env();
    e.spy.reset();
    const res = await callTool(e.tools, "git_pull", { repo: "Alpha", ...extra });
    expect(dataOf(res)).toMatchObject({ ok: false, codigo: "argumento_invalido" });
    expect(e.spy.callsTo(...MUTATING)).toEqual([]);
  });
});

describe("git_fetch", () => {
  it("traz branches e tags novas e informa", async () => {
    const e = env();
    sh(e.base, "clone", e.remote, "outro");
    const outro = `${e.base}/outro`;
    configureClone(sh, outro);
    sh(outro, "switch", "-c", "feature-y");
    writeFile(outro, "y.txt", "y\n");
    sh(outro, "add", "y.txt");
    sh(outro, "commit", "-m", "y");
    sh(outro, "tag", "v2.0");
    sh(outro, "push", "origin", "feature-y", "v2.0");

    const res = await callTool(e.tools, "git_fetch", { repo: "Alpha" });
    expect(dataOf(res)).toMatchObject({ ok: true, remoto: "origin" });
    expect(dataOf(res).novas).toEqual(expect.arrayContaining(["origin/feature-y", "tag v2.0"]));
    expect(sh(e.repo, "tag", "--list")).toContain("v2.0");
    expect(sh(e.repo, "branch", "--show-current").trim()).toBe("main");
  });

  it.each([[{ remoto: "--all" }], [{ remoto: "--prune" }], [{ remoto: "https://example.com/x.git" }], [{ remoto: "naoexiste" }]])("recusa %j sem chamar o fetch", async (extra) => {
    const e = env();
    e.spy.reset();
    const res = await callTool(e.tools, "git_fetch", { repo: "Alpha", ...extra });
    expect(dataOf(res)).toMatchObject({ ok: false, codigo: "argumento_invalido" });
    expect(e.spy.callsTo(...MUTATING)).toEqual([]);
  });
});

describe("D2: nada destrutivo", () => {
  it("nenhum comando executado pelas tools carrega flag proibida", async () => {
    const e = env();
    e.spy.reset();
    sh(e.repo, "switch", "-c", "d2");
    writeFile(e.repo, "d.txt", "d\n");
    await callTool(e.tools, "git_add", { repo: "Alpha", todos: true });
    await callTool(e.tools, "git_commit", { repo: "Alpha", mensagem: "d2" });
    await callTool(e.tools, "git_push", { repo: "Alpha", definir_upstream: true });
    await callTool(e.tools, "git_fetch", { repo: "Alpha" });
    await callTool(e.tools, "git_pull", { repo: "Alpha" });
    await callTool(e.tools, "git_checkout", { repo: "Alpha", branch: "main" });
    const all = e.spy.callsTo(...MUTATING).map((c) => c.join(" ")).join("\n");
    expect(all.length).toBeGreaterThan(0);
    expect(all).not.toMatch(/--force|--delete|--hard|--mirror|--prune|--amend|--no-verify|--rebase|--discard-changes| -f( |$)| -D( |$)|\+refs/);
  });
});
