import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { HubTool } from "../../src/ecosystem/types";
import { buildGitTools } from "../../src/tools/git-tools";
import type { GitToolDeps } from "../../src/tools/git-tools";
import { cleanupTemp, makeRepo, makeRepoWithRemote, makeTempDir, sh, writeFile } from "../helpers/git-repos";
import { MUTATING, spyGit } from "../helpers/spy-git";
import type { SpyGit } from "../helpers/spy-git";
import { callTool, dataOf, makeDeps, textOf } from "../helpers/tool-deps";

afterAll(cleanupTemp);

const HISTORY_TOOLS = ["git_merge", "git_revert", "git_stash", "git_tag"];

interface Env {
  base: string;
  repo: string;
  remote: string;
  tools: HubTool[];
  spy: SpyGit;
}

/** Project "Alpha" (clone with a bare remote), its tools wired to a recording git runner. */
function env(extra: Partial<GitToolDeps> = {}, redact?: (text: string) => string): Env {
  const { base, repo, remote } = makeRepoWithRemote();
  const spy = spyGit();
  const deps: GitToolDeps = { ...makeDeps({ projects: [{ name: "Alpha", clone: repo }], redact }), git: spy.git, ...extra };
  return { base, repo, remote, tools: buildGitTools(deps), spy };
}

function commitFile(repo: string, name: string, content = `${name}\n`, message = `add ${name}`): string {
  writeFile(repo, name, content);
  sh(repo, "add", name);
  sh(repo, "commit", "-m", message);
  return sh(repo, "rev-parse", "HEAD").trim();
}

function conflict(repo: string): void {
  sh(repo, "switch", "-c", "feature");
  commitFile(repo, "README.md", "# lado feature\n", "muda na feature");
  sh(repo, "switch", "main");
  commitFile(repo, "README.md", "# lado main\n", "muda na main");
}

const hasHead = (repo: string, name: string): boolean => {
  try {
    sh(repo, "rev-parse", "-q", "--verify", name);
    return true;
  } catch {
    return false;
  }
};

describe("registro das 17 tools", () => {
  it("as 17 tools, na ordem do contrato, com nomes únicos", () => {
    const all = buildGitTools(makeDeps()).map((t) => t.name);
    expect(all).toHaveLength(26); // + as 6 tools de provedor e as 2 de repositório e release (tests/tools/provider-tools.test.ts, repo-release-tools.test.ts)
    const names = all.slice(0, 17);
    expect(names).toEqual([
      "git_status", "git_diff", "git_log", "git_blame", "git_branches", "git_remote_info",
      "git_fetch", "git_checkout", "git_add", "git_commit", "git_push", "git_pull",
      "git_merge", "git_revert", "git_stash", "git_tag", "git_clone",
    ]);
    expect(new Set(names).size).toBe(17);
  });

  it("annotations: escrita local não destrutiva; só o clone tem openWorldHint", () => {
    const tools = buildGitTools(makeDeps());
    for (const name of [...HISTORY_TOOLS, "git_clone"]) {
      const t = tools.find((x) => x.name === name);
      expect(t?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false });
      expect(t?.annotations?.openWorldHint).toBe(name === "git_clone");
      expect(t?.inputSchema).toMatchObject({ type: "object", additionalProperties: false });
    }
  });

  it("schemas: obrigatórios, enums e tipos", () => {
    const tools = buildGitTools(makeDeps());
    const schema = (n: string) => tools.find((t) => t.name === n)?.inputSchema as { required?: string[]; properties: Record<string, { enum?: string[]; type?: string; minimum?: number }> };
    expect(schema("git_merge").required).toEqual(["repo"]);
    expect(Object.keys(schema("git_merge").properties)).toEqual(["repo", "origem", "mensagem", "sem_ff", "abortar"]);
    expect(schema("git_revert").required).toEqual(["repo"]);
    expect(schema("git_revert").properties.merge_pai).toMatchObject({ type: "integer", minimum: 1 });
    expect(schema("git_stash").required).toEqual(["repo", "acao"]);
    expect(schema("git_stash").properties.acao?.enum).toEqual(["salvar", "listar", "mostrar", "aplicar", "pop"]);
    expect(schema("git_stash").properties.indice).toMatchObject({ type: "integer", minimum: 0 });
    expect(schema("git_tag").required).toEqual(["repo", "acao"]);
    expect(schema("git_tag").properties.acao?.enum).toEqual(["listar", "criar"]);
    expect(schema("git_clone").required).toEqual(["url", "destino"]);
    expect(Object.keys(schema("git_clone").properties)).toEqual(["url", "destino", "branch", "profundidade"]);
  });
});

describe("erros comuns das tools de histórico", () => {
  it.each(HISTORY_TOOLS)("%s: repositório fora da lista -> repo_nao_permitido e nada é executado", async (name) => {
    const e = env();
    const fora = makeRepo(makeTempDir(), "fora");
    e.spy.reset();
    const extra: Record<string, Record<string, unknown>> = { git_merge: { origem: "main" }, git_revert: { commit: "HEAD" }, git_stash: { acao: "listar" }, git_tag: { acao: "listar" } };
    const res = await callTool(e.tools, name, { repo: fora, ...extra[name] });
    expect(dataOf(res)).toMatchObject({ ok: false, codigo: "repo_nao_permitido" });
    expect(e.spy.callsTo(...MUTATING, "revert", "stash", "tag")).toEqual([]);
  });

  it.each(HISTORY_TOOLS)("%s: argumento desconhecido -> argumento_invalido", async (name) => {
    const e = env();
    const res = await callTool(e.tools, name, { repo: "Alpha", surpresa: 1 });
    expect(dataOf(res)).toMatchObject({ ok: false, codigo: "argumento_invalido" });
    expect(textOf(res)).toContain("surpresa");
  });

  it("aplica o redact no texto de erro", async () => {
    const e = env({}, (t) => t.replace(/naoexiste/g, "[oculto]"));
    const res = await callTool(e.tools, "git_merge", { repo: "Alpha", origem: "naoexiste" });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("[oculto]");
    expect(textOf(res)).not.toContain("naoexiste");
  });
});

describe("git_merge", () => {
  it("fast-forward: hash, hash_curto, branch, fast_forward e origem", async () => {
    const e = env();
    sh(e.repo, "switch", "-c", "feature");
    const tip = commitFile(e.repo, "f.txt");
    sh(e.repo, "switch", "main");
    const res = await callTool(e.tools, "git_merge", { repo: "Alpha", origem: "feature" });
    expect(dataOf(res)).toMatchObject({ ok: true, hash: tip, hash_curto: tip.slice(0, 7), branch: "main", fast_forward: true, origem: "feature", ja_atualizado: false });
    expect(textOf(res)).toContain("fast-forward");
  });

  it("sem_ff cria o commit de merge com a mensagem", async () => {
    const e = env();
    sh(e.repo, "switch", "-c", "feature");
    commitFile(e.repo, "f.txt");
    sh(e.repo, "switch", "main");
    const res = await callTool(e.tools, "git_merge", { repo: "Alpha", origem: "feature", sem_ff: true, mensagem: "Junta a feature" });
    expect(dataOf(res)).toMatchObject({ ok: true, fast_forward: false });
    expect(sh(e.repo, "log", "-1", "--format=%s").trim()).toBe("Junta a feature");
  });

  it("conflito: isError, codigo conflito, conflitos[] e o estado de merge permanece", async () => {
    const e = env();
    conflict(e.repo);
    const res = await callTool(e.tools, "git_merge", { repo: "Alpha", origem: "feature" });
    expect(res.isError).toBe(true);
    expect(dataOf(res)).toMatchObject({ ok: false, codigo: "conflito", conflitos: ["README.md"], origem: "feature" });
    expect(textOf(res)).toContain("README.md");
    expect(hasHead(e.repo, "MERGE_HEAD")).toBe(true);
    // the conflict list also shows in git_status
    expect(dataOf(await callTool(e.tools, "git_status", { repo: "Alpha" })).conflitos).toEqual(["README.md"]);
  });

  it("abortar desfaz o merge; sem MERGE_HEAD -> argumento_invalido; com origem -> argumento_invalido", async () => {
    const e = env();
    conflict(e.repo);
    const before = sh(e.repo, "rev-parse", "HEAD").trim();
    expect(dataOf(await callTool(e.tools, "git_merge", { repo: "Alpha", abortar: true }))).toMatchObject({ ok: false, codigo: "argumento_invalido" });
    await callTool(e.tools, "git_merge", { repo: "Alpha", origem: "feature" });
    expect(dataOf(await callTool(e.tools, "git_merge", { repo: "Alpha", abortar: true, origem: "feature" }))).toMatchObject({ ok: false, codigo: "argumento_invalido" });
    expect(hasHead(e.repo, "MERGE_HEAD")).toBe(true);
    const res = await callTool(e.tools, "git_merge", { repo: "Alpha", abortar: true });
    expect(dataOf(res)).toMatchObject({ ok: true, abortado: true, branch: "main", hash: before });
    expect(hasHead(e.repo, "MERGE_HEAD")).toBe(false);
  });

  it.each([["--squash"], ["-s"], ["--abort"], ["a..b"], ["--strategy=ours"]])("origem %j é recusada sem chamar o git", async (origem) => {
    const e = env();
    e.spy.reset();
    const res = await callTool(e.tools, "git_merge", { repo: "Alpha", origem });
    expect(dataOf(res)).toMatchObject({ ok: false, codigo: "argumento_invalido" });
    expect(e.spy.callsTo("merge")).toEqual([]);
  });

  it("sem origem nem abortar -> argumento_invalido; tipos errados também", async () => {
    const e = env();
    expect(dataOf(await callTool(e.tools, "git_merge", { repo: "Alpha" }))).toMatchObject({ codigo: "argumento_invalido" });
    expect(dataOf(await callTool(e.tools, "git_merge", { repo: "Alpha", origem: "main", sem_ff: "sim" }))).toMatchObject({ codigo: "argumento_invalido" });
  });
});

describe("git_revert", () => {
  it("simples: devolve o hash do commit de revert", async () => {
    const e = env();
    const target = commitFile(e.repo, "a.txt");
    const res = await callTool(e.tools, "git_revert", { repo: "Alpha", commit: target });
    const d = dataOf(res);
    expect(d).toMatchObject({ ok: true, branch: "main", revertido: target });
    expect(d.hash).toBe(sh(e.repo, "rev-parse", "HEAD").trim());
    expect(String(d.titulo)).toMatch(/^Revert "add a\.txt"/);
  });

  it("de merge: sem merge_pai dá git_falhou com dica; com merge_pai funciona", async () => {
    const e = env();
    sh(e.repo, "switch", "-c", "feature");
    commitFile(e.repo, "f.txt");
    sh(e.repo, "switch", "main");
    commitFile(e.repo, "m.txt");
    sh(e.repo, "merge", "--no-ff", "-m", "junta", "feature");
    const merge = sh(e.repo, "rev-parse", "HEAD").trim();
    const semPai = await callTool(e.tools, "git_revert", { repo: "Alpha", commit: merge });
    expect(dataOf(semPai)).toMatchObject({ ok: false, codigo: "git_falhou" });
    expect(String(dataOf(semPai).dica)).toContain("merge_pai");
    const res = await callTool(e.tools, "git_revert", { repo: "Alpha", commit: merge, merge_pai: 1 });
    expect(dataOf(res)).toMatchObject({ ok: true });
    expect(sh(e.repo, "ls-files")).not.toContain("f.txt");
  });

  it("conflito e abortar", async () => {
    const e = env();
    const target = commitFile(e.repo, "README.md", "# segunda\n", "muda 1");
    commitFile(e.repo, "README.md", "# terceira\n", "muda 2");
    const before = sh(e.repo, "rev-parse", "HEAD").trim();
    const res = await callTool(e.tools, "git_revert", { repo: "Alpha", commit: target });
    expect(res.isError).toBe(true);
    expect(dataOf(res)).toMatchObject({ ok: false, codigo: "conflito", conflitos: ["README.md"], commit: target });
    expect(hasHead(e.repo, "REVERT_HEAD")).toBe(true);
    expect(dataOf(await callTool(e.tools, "git_revert", { repo: "Alpha", abortar: true }))).toMatchObject({ ok: true, abortado: true, hash: before });
    expect(hasHead(e.repo, "REVERT_HEAD")).toBe(false);
    expect(dataOf(await callTool(e.tools, "git_revert", { repo: "Alpha", abortar: true }))).toMatchObject({ ok: false, codigo: "argumento_invalido" });
  });

  it.each([[{ commit: "--no-commit" }], [{ commit: "a..b" }], [{ commit: "HEAD", merge_pai: 0 }], [{ commit: "HEAD", merge_pai: 1.5 }], [{ abortar: true, commit: "HEAD" }], [{}]])("%j -> argumento_invalido sem revert", async (extra) => {
    const e = env();
    e.spy.reset();
    expect(dataOf(await callTool(e.tools, "git_revert", { repo: "Alpha", ...extra }))).toMatchObject({ ok: false, codigo: "argumento_invalido" });
    expect(e.spy.callsTo("revert")).toEqual([]);
  });
});

describe("git_stash", () => {
  it("salvar, listar, mostrar, aplicar e pop", async () => {
    const e = env();
    writeFile(e.repo, "README.md", "# alterado\n");
    const salvar = await callTool(e.tools, "git_stash", { repo: "Alpha", acao: "salvar", mensagem: "meu trabalho" });
    expect(dataOf(salvar)).toMatchObject({ ok: true, salvo: true, indice: 0, ref: "stash@{0}", total: 1 });
    expect(sh(e.repo, "status", "--porcelain").trim()).toBe("");

    const listar = dataOf(await callTool(e.tools, "git_stash", { repo: "Alpha", acao: "listar" }));
    expect(listar).toMatchObject({ ok: true, total: 1 });
    expect(JSON.stringify(listar.stashes)).toContain("meu trabalho");

    const mostrar = await callTool(e.tools, "git_stash", { repo: "Alpha", acao: "mostrar" });
    expect(dataOf(mostrar)).toMatchObject({ ok: true, truncado: false, vazio: false });
    expect(textOf(mostrar)).toContain("+# alterado");

    expect(dataOf(await callTool(e.tools, "git_stash", { repo: "Alpha", acao: "aplicar" }))).toMatchObject({ ok: true, mantido: true, total: 1 });
    expect(sh(e.repo, "status", "--porcelain").trim()).toBe("M README.md");
    sh(e.repo, "checkout", "--", "README.md");
    expect(dataOf(await callTool(e.tools, "git_stash", { repo: "Alpha", acao: "pop" }))).toMatchObject({ ok: true, mantido: false, total: 0 });
    expect(sh(e.repo, "stash", "list").trim()).toBe("");
  });

  it("incluir_nao_rastreados e nada a guardar", async () => {
    const e = env();
    expect(dataOf(await callTool(e.tools, "git_stash", { repo: "Alpha", acao: "salvar" }))).toMatchObject({ ok: true, salvo: false });
    writeFile(e.repo, "novo.txt", "n\n");
    expect(dataOf(await callTool(e.tools, "git_stash", { repo: "Alpha", acao: "salvar", incluir_nao_rastreados: true }))).toMatchObject({ ok: true, salvo: true });
    expect(sh(e.repo, "status", "--porcelain").trim()).toBe("");
  });

  it("conflito ao aplicar: codigo conflito, arquivos e stash mantido", async () => {
    const e = env();
    writeFile(e.repo, "README.md", "# do stash\n");
    sh(e.repo, "stash", "push", "-m", "x");
    commitFile(e.repo, "README.md", "# commitado depois\n", "muda");
    const res = await callTool(e.tools, "git_stash", { repo: "Alpha", acao: "pop" });
    expect(res.isError).toBe(true);
    expect(dataOf(res)).toMatchObject({ ok: false, codigo: "conflito", conflitos: ["README.md"], stash_mantido: true });
    expect(sh(e.repo, "stash", "list")).toContain("x");
  });

  it.each([["drop"], ["clear"], ["branch"], ["push"], [""]])("acao %j é recusada (sem drop nem clear) e o git não é chamado", async (acao) => {
    const e = env();
    e.spy.reset();
    expect(dataOf(await callTool(e.tools, "git_stash", { repo: "Alpha", acao }))).toMatchObject({ ok: false, codigo: "argumento_invalido" });
    expect(e.spy.callsTo("stash")).toEqual([]);
  });

  it("índice inválido ou inexistente -> argumento_invalido", async () => {
    const e = env();
    for (const indice of [-1, 1.5, "0", 3]) {
      expect(dataOf(await callTool(e.tools, "git_stash", { repo: "Alpha", acao: "aplicar", indice }))).toMatchObject({ ok: false, codigo: "argumento_invalido" });
    }
  });

  it("a descrição da tool não promete apagar e o enum só tem as 5 ações", () => {
    const t = buildGitTools(makeDeps()).find((x) => x.name === "git_stash");
    expect(JSON.stringify(t?.inputSchema)).not.toMatch(/"drop"|"clear"/);
  });
});

describe("git_tag", () => {
  it("criar devolve nome, hash e mensagem; listar mostra; recusa existente", async () => {
    const e = env();
    const head = sh(e.repo, "rev-parse", "HEAD").trim();
    const res = await callTool(e.tools, "git_tag", { repo: "Alpha", acao: "criar", nome: "v0.1.0", mensagem: "Primeira release\n\ncorpo" });
    expect(dataOf(res)).toEqual({ ok: true, repo: e.repo, acao: "criar", nome: "v0.1.0", hash: head, mensagem: "Primeira release\n\ncorpo" });
    expect(sh(e.repo, "cat-file", "-t", "v0.1.0").trim()).toBe("tag");

    const listar = dataOf(await callTool(e.tools, "git_tag", { repo: "Alpha", acao: "listar" }));
    expect(listar).toMatchObject({ ok: true, total: 1, truncado: false });
    expect(listar.tags).toEqual([expect.objectContaining({ nome: "v0.1.0", hash: head, anotada: true, assunto: "Primeira release" })]);

    const dup = await callTool(e.tools, "git_tag", { repo: "Alpha", acao: "criar", nome: "v0.1.0", mensagem: "de novo" });
    expect(dup.isError).toBe(true);
    expect(dataOf(dup)).toMatchObject({ ok: false, codigo: "argumento_invalido" });
  });

  it("a tag criada vai para o remoto pelo git_push", async () => {
    const e = env();
    await callTool(e.tools, "git_tag", { repo: "Alpha", acao: "criar", nome: "v1", mensagem: "m" });
    expect(dataOf(await callTool(e.tools, "git_push", { repo: "Alpha", tag: "v1" }))).toMatchObject({ ok: true, tag: "v1" });
    expect(sh(e.remote, "tag", "--list")).toContain("v1");
  });

  it.each([["-d"], ["--delete"], ["a..b"], ["a b"], ["v1~1"], ["HEAD"]])("nome %j é recusado sem criar tag", async (nome) => {
    const e = env();
    e.spy.reset();
    expect(dataOf(await callTool(e.tools, "git_tag", { repo: "Alpha", acao: "criar", nome, mensagem: "m" }))).toMatchObject({ ok: false, codigo: "argumento_invalido" });
    expect(e.spy.callsTo("tag")).toEqual([]);
  });

  it.each([["deletar"], ["delete"], ["apagar"], [""]])("acao %j é recusada (sem deleção)", async (acao) => {
    const e = env();
    e.spy.reset();
    expect(dataOf(await callTool(e.tools, "git_tag", { repo: "Alpha", acao, nome: "v1" }))).toMatchObject({ ok: false, codigo: "argumento_invalido" });
    expect(e.spy.callsTo("tag")).toEqual([]);
  });
});

describe("git_clone", () => {
  it("é uma tool livre (sem repo): clona um remoto bare local pela via de injeção", async () => {
    const { base, remote } = makeRepoWithRemote();
    const tip = sh(remote, "rev-parse", "main").trim();
    const e = env({ allowedFolders: () => [base], validateCloneUrl: (u) => u });
    const destino = join(base, "clones", "novo");
    const res = await callTool(e.tools, "git_clone", { url: remote, destino });
    expect(dataOf(res)).toMatchObject({ ok: true, destino, branch: "main", hash: tip, profundidade: null });
    expect(sh(destino, "rev-parse", "HEAD").trim()).toBe(tip);
  });

  it("clona dentro da pasta-mãe dos clones dos projetos", async () => {
    const { base, remote } = makeRepoWithRemote();
    // the project clone lives in `base`, so `base` is the folder of the clones
    const e = env({ validateCloneUrl: (u) => u });
    expect(dataOf(await callTool(e.tools, "git_clone", { url: remote, destino: join(e.base, "outro-clone") }))).toMatchObject({ ok: true });
    void base;
  });

  it("validação real: hosts não permitidos, senha na URL e file:// -> argumento_invalido sem chamar o git", async () => {
    const base = makeTempDir();
    const e = env({ allowedFolders: () => [base] });
    e.spy.reset();
    for (const url of ["https://gitlab.com/o/r.git", "https://u:segredo123@github.com/o/r.git", "file:///C:/x.git", "git@evil.io:o/r.git", "https://github.com.evil.io/o/r.git"]) {
      const res = await callTool(e.tools, "git_clone", { url, destino: join(base, "n") });
      expect(dataOf(res)).toMatchObject({ ok: false, codigo: "argumento_invalido" });
      expect(textOf(res)).not.toContain("segredo123");
    }
    expect(e.spy.callsTo("clone")).toEqual([]);
  });

  it("destino existente, fora da lista, relativo e com '..' -> argumento_invalido", async () => {
    const { base, remote } = makeRepoWithRemote();
    const fora = makeTempDir();
    const e = env({ allowedFolders: () => [base], validateCloneUrl: (u) => u });
    e.spy.reset();
    for (const destino of [base, join(fora, "novo"), "relativo\\novo", `${base}\\x\\..\\novo`]) {
      expect(dataOf(await callTool(e.tools, "git_clone", { url: remote, destino }))).toMatchObject({ ok: false, codigo: "argumento_invalido" });
    }
    expect(e.spy.callsTo("clone")).toEqual([]);
  });

  it("sem pasta permitida nenhuma além do pai dos projetos, destino em outro lugar é recusado", async () => {
    const e = env({ validateCloneUrl: (u) => u });
    const fora = makeTempDir();
    expect(dataOf(await callTool(e.tools, "git_clone", { url: e.remote, destino: join(fora, "novo") }))).toMatchObject({ ok: false, codigo: "argumento_invalido" });
  });

  it("argumento desconhecido e obrigatórios", async () => {
    const e = env();
    expect(dataOf(await callTool(e.tools, "git_clone", { url: "https://github.com/o/r.git", destino: "C:\\x", repo: "Alpha" }))).toMatchObject({ codigo: "argumento_invalido" });
    expect(dataOf(await callTool(e.tools, "git_clone", { url: "https://github.com/o/r.git" }))).toMatchObject({ codigo: "argumento_invalido" });
    expect(dataOf(await callTool(e.tools, "git_clone", { destino: "C:\\x" }))).toMatchObject({ codigo: "argumento_invalido" });
  });

  it("erro do git sai mascarado", async () => {
    const base = makeTempDir();
    const e = env({ allowedFolders: () => [base], validateCloneUrl: (u) => u });
    const res = await callTool(e.tools, "git_clone", { url: "https://usuario:segredo123@exemplo.invalid/o/r.git", destino: join(base, "n") });
    expect(res.isError).toBe(true);
    expect(textOf(res)).not.toContain("segredo123");
  });
});
