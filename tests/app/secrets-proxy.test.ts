import { describe, expect, it, vi } from "vitest";
import { RpcRemoteError } from "../../src/app/rpc";
import { createSecretsProxy } from "../../src/app/secrets-proxy";
import { isVaultLocked, policyCode } from "../../src/core/providers/secrets";

describe("createSecretsProxy", () => {
  it("mapeia o pedido e a resposta de segredos/requisicao", async () => {
    const request = vi.fn(async () => ({ status: 200, cabecalhos: { "x-a": "1" }, corpo: "ok", truncado: false }));
    const proxy = createSecretsProxy({ request });
    const res = await proxy.request({ method: "GET", url: "https://api.github.com/user", headers: { Authorization: "Bearer {{bearer:GH}}" } }, "ai-git-tools");
    expect(res).toEqual({ status: 200, headers: { "x-a": "1" }, body: "ok" });
    expect(request).toHaveBeenCalledWith(
      "segredos/requisicao",
      { metodo: "GET", url: "https://api.github.com/user", cabecalhos: { Authorization: "Bearer {{bearer:GH}}" }, corpo: null, tempo_limite_ms: null, corpo_cru: false },
      120_000,
    );
  });

  it("envia corpo texto e rawBody, e corpo objeto como JSON", async () => {
    const request = vi.fn(async (_method: string, _params: unknown, _timeoutMs?: number) => ({ status: 201, cabecalhos: {}, corpo: "" }));
    const proxy = createSecretsProxy({ request });
    await proxy.request({ method: "POST", url: "https://x.test", body: "abc", rawBody: true, timeoutMs: 5000 }, "m");
    expect(request.mock.calls[0]?.[1]).toMatchObject({ corpo: "abc", corpo_cru: true, tempo_limite_ms: 5000 });
    await proxy.request({ method: "POST", url: "https://x.test", body: { a: 1 } }, "m");
    expect(request.mock.calls[1]?.[1]).toMatchObject({ corpo: '{"a":1}', cabecalhos: { "Content-Type": "application/json" } });
  });

  it("não está bloqueado e não redige nada", () => {
    const proxy = createSecretsProxy({ request: vi.fn() });
    expect(proxy.isLocked?.()).toBe(false);
    expect(proxy.redact("texto")).toBe("texto");
  });

  it("listSecretMetadata converte os metadados", async () => {
    const request = vi.fn(async () => ({
      segredos: [
        { nome: "GH", tipo: "bearer", hosts: ["api.github.com"], descricao: "" },
        { nome: "BB", tipo: "basic", hosts: ["api.bitbucket.org"], descricao: "" },
      ],
    }));
    const list = await createSecretsProxy({ request }).listSecretMetadata!("ai-git-tools");
    expect(request).toHaveBeenCalledWith("segredos/metadados", {}, expect.any(Number));
    expect(list).toEqual([
      { name: "GH", type: "bearer", hasUsername: false, allowedHosts: ["api.github.com"], allowAnyHost: false, approval: "never" },
      { name: "BB", type: "basic", hasUsername: true, allowedHosts: ["api.bitbucket.org"], allowAnyHost: false, approval: "never" },
    ]);
  });

  it("cofre_ausente vira VaultLockedError (isVaultLocked)", async () => {
    const request = vi.fn(async () => {
      throw new RpcRemoteError(-32000, "cofre bloqueado", { codigo: "cofre_ausente", codigo_politica: null });
    });
    const err = await createSecretsProxy({ request }).request({ method: "GET", url: "https://x.test" }, "m").catch((e: unknown) => e);
    expect(isVaultLocked(err)).toBe(true);
    const err2 = await createSecretsProxy({ request }).listSecretMetadata!("m").catch((e: unknown) => e);
    expect(isVaultLocked(err2)).toBe(true);
  });

  it("politica vira PolicyError com o código (policyCode)", async () => {
    const request = vi.fn(async () => {
      throw new RpcRemoteError(-32000, "host não permitido", { codigo: "politica", codigo_politica: "host_not_allowed" });
    });
    const err = await createSecretsProxy({ request }).request({ method: "GET", url: "https://x.test" }, "m").catch((e: unknown) => e);
    expect(policyCode(err)).toBe("host_not_allowed");
    expect(isVaultLocked(err)).toBe(false);
  });

  it("outro erro vira Error com a mensagem", async () => {
    const request = vi.fn(async () => {
      throw new RpcRemoteError(-32000, "sem rede", { codigo: "rede", codigo_politica: null });
    });
    const err = (await createSecretsProxy({ request }).request({ method: "GET", url: "https://x.test" }, "m").catch((e: unknown) => e)) as Error;
    expect(err.message).toBe("sem rede");
    expect(isVaultLocked(err)).toBe(false);
    expect(policyCode(err)).toBeUndefined();
  });
});
