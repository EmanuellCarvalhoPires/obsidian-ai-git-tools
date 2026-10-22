import { describe, expect, it } from "vitest";
import { GitError } from "../../src/core/git-runner";
import {
  DICA_CONFIGURAR_SECRET,
  RemoteError,
  assertOk,
  cleanText,
  foraDaLista,
  httpError,
  providerMessage,
  secretNaoConfigurada,
  toFail,
} from "../../src/core/providers/errors";
import { FAKE_VALUE } from "../helpers/fake-secrets";

const res = (status: number, body: unknown = "", headers: Record<string, string> = {}) => ({
  status,
  headers,
  body: typeof body === "string" ? body : JSON.stringify(body),
});

describe("httpError", () => {
  it("maps 401 to a credential message with the status code", () => {
    const e = httpError("github", res(401, { message: "Bad credentials" }));
    expect(e.codigo).toBe("provedor_http_401");
    expect(e.status).toBe(401);
    expect(e.mensagem).toContain("recusou as credenciais");
    expect(e.mensagem).toContain("Bad credentials");
    expect(e.dica).toBeDefined();
  });

  it("maps 403 to a permission message, and to a rate limit when the headers say so", () => {
    expect(httpError("bitbucket", res(403)).mensagem).toMatch(/Sem permissão no Bitbucket/);
    const limited = httpError("github", res(403, "", { "x-ratelimit-remaining": "0" }));
    expect(limited.codigo).toBe("provedor_http_403");
    expect(limited.mensagem).toMatch(/limitou as requisições/);
  });

  it("maps 404, 409 and 422 to Portuguese messages", () => {
    expect(httpError("github", res(404)).mensagem).toMatch(/Não encontrado no GitHub \(404\)/);
    expect(httpError("github", res(409)).mensagem).toMatch(/Conflito/);
    const e = httpError("github", res(422, { message: "Validation Failed", errors: [{ message: "A pull request already exists for o:b." }] }));
    expect(e.codigo).toBe("provedor_http_422");
    expect(e.mensagem).toContain("recusou os dados");
    expect(e.mensagem).toContain("A pull request already exists");
  });

  it("maps 429 with the wait time and 5xx to a retry message", () => {
    const e = httpError("bitbucket", res(429, "", { "retry-after": "42" }));
    expect(e.codigo).toBe("provedor_http_429");
    expect(e.mensagem).toContain("42 s");
    const s = httpError("github", res(503));
    expect(s.codigo).toBe("provedor_http_503");
    expect(s.mensagem).toMatch(/falhou \(503\)/);
  });

  it("covers an unexpected status and redacts the provider text", () => {
    expect(httpError("github", res(418)).mensagem).toContain("418");
    const e = httpError("github", res(422, { message: `token ${FAKE_VALUE}` }), (t) => t.split(FAKE_VALUE).join("[REDACTED]"));
    expect(e.mensagem).not.toContain(FAKE_VALUE);
    expect(e.mensagem).toContain("[REDACTED]");
  });
});

describe("providerMessage", () => {
  it("reads the GitHub and Bitbucket error shapes", () => {
    expect(providerMessage('{"message":"Not Found"}')).toBe("Not Found");
    expect(providerMessage('{"type":"error","error":{"message":"Branch not found","detail":"x"}}')).toBe("Branch not found; x");
    expect(providerMessage("<html>")).toBeUndefined();
    expect(providerMessage("[]")).toBeUndefined();
    expect(providerMessage("")).toBeUndefined();
  });

  it("cuts a very long message", () => {
    expect(providerMessage(JSON.stringify({ message: "a".repeat(1000) }))!.length).toBeLessThan(310);
  });
});

describe("assertOk", () => {
  it("returns a 2xx answer and throws a RemoteError for the others", () => {
    const ok = res(202, "{}");
    expect(assertOk("github", ok)).toBe(ok);
    expect(() => assertOk("github", res(404))).toThrow(RemoteError);
  });
});

describe("hints", () => {
  it("secretNaoConfigurada points to the skill and the settings", () => {
    const e = secretNaoConfigurada("github");
    expect(e.codigo).toBe("secret_nao_configurada");
    expect(e.mensagem).toContain("GitHub");
    expect(e.dica).toBe(DICA_CONFIGURAR_SECRET);
    expect(DICA_CONFIGURAR_SECRET).toBe("rode a skill configurar-ai-git-tools ou escolha a secret nas configurações do plugin");
  });

  it("foraDaLista gives the Bitbucket package hint and the GitHub http_request hint", () => {
    expect(foraDaLista("bitbucket")).toEqual({ mcp: "Bitbucket", usar: "search_vault_tools + run_vault_tool" });
    expect(foraDaLista("github", "GH_TESTE")).toMatchObject({ usar: "http_request", cabecalho: "Authorization: {{bearer:GH_TESTE}}" });
    expect(foraDaLista("github")).toMatchObject({ cabecalho: "Authorization: {{bearer:NOME}}" });
  });
});

describe("toFail", () => {
  it("keeps the code, the message and the hint of a RemoteError", () => {
    const r = toFail(secretNaoConfigurada("bitbucket"));
    expect(r.isError).toBe(true);
    expect(r.structuredContent).toMatchObject({ ok: false, codigo: "secret_nao_configurada", dica: DICA_CONFIGURAR_SECRET });
  });

  it("keeps the HTTP code and masks credentials in the message", () => {
    const err = new RemoteError("provedor_http_500", "falha em https://u:senha@api.github.com/x", { status: 500 });
    const r = toFail(err, (t) => t.replace("senha", "[REDACTED]"));
    expect(r.structuredContent).toMatchObject({ codigo: "provedor_http_500" });
    expect(JSON.stringify(r)).not.toContain("senha");
  });

  it("delegates other errors to fromError", () => {
    const r = toFail(new GitError(1, "boom", ["status"]));
    expect(r.structuredContent).toMatchObject({ ok: false, codigo: "git_falhou" });
  });
});

describe("cleanText", () => {
  it("masks URL credentials and survives a failing redactor", () => {
    expect(cleanText("x https://u:p@host/y")).toBe("x https://***@host/y");
    expect(
      cleanText("abc", () => {
        throw new Error("falha");
      }),
    ).toBe("abc");
  });
});
