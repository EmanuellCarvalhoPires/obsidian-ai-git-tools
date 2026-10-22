import { describe, expect, it } from "vitest";
import { GitError } from "../../src/core/git-runner";
import { GuardError } from "../../src/core/guards";
import { RepoError } from "../../src/core/repo-resolver";
import { fail, fromError, httpCode, ok } from "../../src/tools/results";

describe("ok", () => {
  it("monta content e structuredContent", () => {
    const res = ok("Feito.", { hash: "abc" });
    expect(res.isError).toBeUndefined();
    expect(res.content).toEqual([{ type: "text", text: "Feito." }]);
    expect(res.structuredContent).toEqual({ ok: true, hash: "abc" });
  });

  it("acrescenta nota e avisos só quando existem", () => {
    expect(ok("x", {}, { nota: "Projetos/A/Eventos/n.md", avisos: ["a"] }).structuredContent).toEqual({ ok: true, nota: "Projetos/A/Eventos/n.md", avisos: ["a"] });
    expect(ok("x", {}, { avisos: [] }).structuredContent).toEqual({ ok: true });
  });
});

describe("fail", () => {
  it("marca isError e leva código, mensagem e dica", () => {
    const res = fail("git_falhou", "Deu ruim.", "rode git_pull");
    expect(res.isError).toBe(true);
    expect(res.content).toEqual([{ type: "text", text: "Deu ruim." }]);
    expect(res.structuredContent).toEqual({ ok: false, codigo: "git_falhou", mensagem: "Deu ruim.", dica: "rode git_pull" });
  });

  it("dica estruturada e sem dica", () => {
    expect(fail("provedor_http_404", "x", { mcp: "Bitbucket", usar: "search_vault_tools + run_vault_tool" }).structuredContent?.dica).toEqual({ mcp: "Bitbucket", usar: "search_vault_tools + run_vault_tool" });
    expect(fail("conflito", "x").structuredContent).toEqual({ ok: false, codigo: "conflito", mensagem: "x" });
  });

  it("httpCode", () => {
    expect(httpCode(422)).toBe("provedor_http_422");
  });
});

describe("fromError", () => {
  it("GuardError -> argumento_invalido", () => {
    expect(fromError(new GuardError("flag proibida")).structuredContent).toMatchObject({ codigo: "argumento_invalido", mensagem: "flag proibida" });
  });
  it("RepoError -> repo_nao_permitido", () => {
    expect(fromError(new RepoError("fora")).structuredContent).toMatchObject({ codigo: "repo_nao_permitido" });
  });
  it("GitError -> git_falhou, com a credencial mascarada", () => {
    const err = new GitError(128, "fatal: unable to access 'https://u:segredo@host/x.git/'", ["fetch", "https://u:segredo@host/x.git"]);
    const res = fromError(err);
    expect(res.structuredContent).toMatchObject({ ok: false, codigo: "git_falhou" });
    expect(JSON.stringify(res)).not.toContain("segredo");
    expect(JSON.stringify(res)).toContain("https://***@host");
  });
  it("erro desconhecido -> git_falhou e aplica o redact", () => {
    const res = fromError(new Error("token ABC123 inválido"), (t) => t.replace("ABC123", "[REDACTED]"));
    expect(res.structuredContent).toMatchObject({ codigo: "git_falhou", mensagem: "token [REDACTED] inválido" });
    expect(fromError("texto solto").structuredContent).toMatchObject({ mensagem: "texto solto" });
  });
});
