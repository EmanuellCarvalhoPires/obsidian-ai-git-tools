import { describe, expect, it } from "vitest";
import { RemoteError } from "../../src/core/providers/errors";
import { DEFAULT_TIMEOUT_MS, USER_AGENT, authHeader, authHeaders, createSecureHttp, parseJson, withQuery } from "../../src/core/providers/http";
import type { SecretVaultService } from "../../src/ecosystem/types";
import { FAKE_VALUE, PolicyError, makeFakeSecrets, reply } from "../helpers/fake-secrets";

async function failure(promise: Promise<unknown>): Promise<RemoteError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(RemoteError);
    return err as RemoteError;
  }
  throw new Error("esperava uma falha");
}

const GET = { method: "GET", url: "https://api.github.com/user", headers: { Authorization: "{{bearer:GH_TESTE}}" } } as const;

describe("createSecureHttp", () => {
  it("sends through secrets.request with the module id, the timeout and the default headers", async () => {
    const fake = makeFakeSecrets({ handler: () => reply(200, { ok: 1 }, { "Content-Type": "application/json", Link: "<x>; rel=next" }) });
    const res = await createSecureHttp(fake.getSecrets)(GET);
    expect(fake.calls).toHaveLength(1);
    const { req, caller } = fake.calls[0]!;
    expect(caller).toBe("ai-git-tools");
    expect(req.method).toBe("GET");
    expect(req.url).toBe("https://api.github.com/user");
    expect(req.timeoutMs).toBe(DEFAULT_TIMEOUT_MS);
    expect(DEFAULT_TIMEOUT_MS).toBe(30_000);
    expect(req.headers).toMatchObject({ Authorization: "{{bearer:GH_TESTE}}", "User-Agent": USER_AGENT, Accept: "application/json" });
    expect(req.body).toBeUndefined();
    expect(res.status).toBe(200);
    expect(res.headers).toEqual({ "content-type": "application/json", link: "<x>; rel=next" });
    expect(JSON.parse(res.body)).toEqual({ ok: 1 });
  });

  it("keeps the Accept and the User-Agent given by the provider, in any case", async () => {
    const fake = makeFakeSecrets();
    await createSecureHttp(fake.getSecrets)({ ...GET, headers: { accept: "application/vnd.github.v3.diff", "user-agent": "outro" } });
    const headers = fake.calls[0]!.req.headers!;
    expect(headers).toEqual({ accept: "application/vnd.github.v3.diff", "user-agent": "outro" });
  });

  it("passes an object body unchanged and adds Content-Type: application/json", async () => {
    const fake = makeFakeSecrets();
    const body = { title: "t", close_source_branch: false };
    await createSecureHttp(fake.getSecrets)({ method: "POST", url: "https://api.bitbucket.org/2.0/x", headers: {}, body });
    const { req } = fake.calls[0]!;
    expect(req.body).toEqual(body);
    expect(req.headers!["Content-Type"]).toBe("application/json");
  });

  it("does not override a Content-Type already set, and sends a string body as is", async () => {
    const fake = makeFakeSecrets();
    const http = createSecureHttp(fake.getSecrets);
    await http({ method: "PUT", url: "https://api.github.com/x", headers: { "content-type": "text/plain" }, body: { a: 1 } });
    expect(Object.keys(fake.calls[0]!.req.headers!).filter((k) => k.toLowerCase() === "content-type")).toEqual(["content-type"]);
    await http({ method: "POST", url: "https://api.github.com/x", headers: {}, body: "texto" });
    expect(fake.calls[1]!.req.body).toBe("texto");
    expect(fake.calls[1]!.req.headers!["Content-Type"]).toBeUndefined();
  });

  it("uses the timeout and the module id of the options", async () => {
    const fake = makeFakeSecrets();
    await createSecureHttp(fake.getSecrets, { timeoutMs: 5000, moduleId: "outro-modulo" })(GET);
    expect(fake.calls[0]!.req.timeoutMs).toBe(5000);
    expect(fake.calls[0]!.caller).toBe("outro-modulo");
  });

  it("returns a non-2xx answer as is (the provider decides what it means)", async () => {
    const fake = makeFakeSecrets({ handler: () => reply(404, { message: "Not Found" }) });
    const res = await createSecureHttp(fake.getSecrets)(GET);
    expect(res.status).toBe(404);
  });

  it("looks the service up at every call", async () => {
    let service: SecretVaultService | undefined;
    const http = createSecureHttp(() => service);
    expect((await failure(http(GET))).codigo).toBe("servico_secrets_ausente");
    service = makeFakeSecrets().service;
    expect((await http(GET)).status).toBe(200);
    service = undefined;
    expect((await failure(http(GET))).codigo).toBe("servico_secrets_ausente");
  });

  it("fails with servico_secrets_ausente when the service is missing", async () => {
    const err = await failure(createSecureHttp(() => undefined)(GET));
    expect(err.codigo).toBe("servico_secrets_ausente");
    expect(err.mensagem).toMatch(/Environment Keys/);
    expect(err.status).toBeUndefined();
  });

  it("fails with cofre_bloqueado when the vault is locked", async () => {
    const fake = makeFakeSecrets();
    fake.lock();
    const err = await failure(createSecureHttp(fake.getSecrets)(GET));
    expect(err.codigo).toBe("cofre_bloqueado");
    expect(err.dica).toMatch(/desbloqueie/);
  });

  it("maps policy errors: unknown secret and host not allowed", async () => {
    const fake = makeFakeSecrets();
    const http = createSecureHttp(fake.getSecrets);
    fake.onRequest(() => {
      throw new PolicyError("unknown_secret", "No variable named GH_TESTE.");
    });
    expect((await failure(http(GET))).codigo).toBe("secret_nao_configurada");
    fake.onRequest(() => {
      throw new PolicyError("host_not_allowed", "api.github.com is not allowed");
    });
    const err = await failure(http(GET));
    expect(err.codigo).toBe("politica_secret");
    expect(err.mensagem).toMatch(/não permite este host/);
  });

  it("turns a network error into `rede` and masks credentials and secret values", async () => {
    const fake = makeFakeSecrets({
      handler: () => {
        throw new Error(`connect ECONNRESET https://usuario:senha@api.github.com/x token ${FAKE_VALUE}`);
      },
    });
    const err = await failure(createSecureHttp(fake.getSecrets)(GET));
    expect(err.codigo).toBe("rede");
    expect(err.mensagem).toContain("https://***@api.github.com/x");
    expect(err.mensagem).not.toContain("senha");
    expect(err.mensagem).not.toContain(FAKE_VALUE);
    expect(err.mensagem).toContain("[REDACTED]");
  });

  it("reports a timeout as a network failure", async () => {
    const fake = makeFakeSecrets({
      handler: () => {
        throw new Error("Request timed out after 30000 ms");
      },
    });
    const err = await failure(createSecureHttp(fake.getSecrets)(GET));
    expect(err.codigo).toBe("rede");
    expect(err.mensagem).toMatch(/timed out/);
  });
});

describe("authHeader", () => {
  it("uses bearer for token, bearer and header secrets", () => {
    expect(authHeader("GH_TESTE")).toBe("{{bearer:GH_TESTE}}");
    expect(authHeader("GH_TESTE", { type: "bearer", hasUsername: false })).toBe("{{bearer:GH_TESTE}}");
    expect(authHeader("GH_TESTE", { type: "token", hasUsername: false })).toBe("{{bearer:GH_TESTE}}");
  });

  it("uses basic for the basic type or a secret with a username", () => {
    expect(authHeader("BB_TESTE", { type: "basic", hasUsername: true })).toBe("{{basic:BB_TESTE}}");
    expect(authHeader("BB_TESTE", { type: "token", hasUsername: true })).toBe("{{basic:BB_TESTE}}");
    expect(authHeader("BB_TESTE", { type: "basic", hasUsername: false })).toBe("{{basic:BB_TESTE}}");
  });

  it("refuses a name that could break out of the placeholder", () => {
    for (const bad of ["", "A}}{{secret:OUTRA", "A B", "1ABC", "a:b", "x".repeat(65)]) {
      expect(() => authHeader(bad)).toThrow(RemoteError);
    }
  });
});

describe("authHeaders", () => {
  const ref = { provider: "bitbucket", owner: "ws", slug: "r", repo: "ws/r" } as const;

  it("builds the Authorization header and keeps the extra headers", () => {
    expect(authHeaders({ ref, secretName: "BB_TESTE", secretInfo: { name: "BB_TESTE", type: "basic", hasUsername: true, allowedHosts: [], allowAnyHost: false, approval: "never" } }, { Accept: "application/json" })).toEqual({
      Accept: "application/json",
      Authorization: "{{basic:BB_TESTE}}",
    });
  });

  it("throws secret_nao_configurada without a secret", () => {
    try {
      authHeaders({ ref, secretName: "" });
      throw new Error("esperava uma falha");
    } catch (err) {
      expect(err).toBeInstanceOf(RemoteError);
      expect((err as RemoteError).codigo).toBe("secret_nao_configurada");
      expect((err as RemoteError).mensagem).toContain("Bitbucket");
    }
  });
});

describe("parseJson and withQuery", () => {
  it("parses JSON, accepts an empty body and rejects other text", () => {
    expect(parseJson({ status: 200, body: '{"a":1}' })).toEqual({ a: 1 });
    expect(parseJson({ status: 204, body: "" })).toBeUndefined();
    expect(() => parseJson({ status: 200, body: "<html>" })).toThrow(RemoteError);
  });

  it("adds an encoded query and skips empty values", () => {
    expect(withQuery("https://x/y", { state: "open", head: "o:feature/a b", per_page: 30, vazio: "", nada: undefined })).toBe(
      "https://x/y?state=open&head=o%3Afeature%2Fa%20b&per_page=30",
    );
    expect(withQuery("https://x/y?a=1", { b: 2 })).toBe("https://x/y?a=1&b=2");
    expect(withQuery("https://x/y")).toBe("https://x/y");
  });
});
