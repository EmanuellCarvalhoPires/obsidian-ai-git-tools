import { describe, expect, it } from "vitest";
import { RemoteError } from "../../src/core/providers/errors";
import { findSecret, inspectSecrets, listSecrets, redactWith } from "../../src/core/providers/secrets";
import { FAKE_VALUE, makeFakeSecrets, secretInfo } from "../helpers/fake-secrets";

const META = [secretInfo("GH_TESTE"), secretInfo("BB_TESTE", "basic", { allowedHosts: ["api.bitbucket.org"] })];

describe("listSecrets", () => {
  it("returns the metadata of the service, with the caller id", async () => {
    const fake = makeFakeSecrets({ metadata: META });
    const seen: string[] = [];
    const original = fake.service.listSecretMetadata!;
    fake.service.listSecretMetadata = (caller) => {
      seen.push(caller);
      return original(caller);
    };
    const list = await listSecrets(fake.getSecrets, "ai-git-tools");
    expect(list.map((s) => s.name)).toEqual(["GH_TESTE", "BB_TESTE"]);
    expect(seen).toEqual(["ai-git-tools"]);
    expect(JSON.stringify(list)).not.toMatch(/valor|value"/i);
  });

  it("returns [] when the service has no listSecretMetadata or is missing", async () => {
    expect(await listSecrets(makeFakeSecrets().getSecrets)).toEqual([]);
    expect(await listSecrets(() => undefined)).toEqual([]);
  });

  it("throws cofre_bloqueado while the vault is locked", async () => {
    const fake = makeFakeSecrets({ metadata: META });
    fake.lock();
    const err = await listSecrets(fake.getSecrets).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RemoteError);
    expect((err as RemoteError).codigo).toBe("cofre_bloqueado");
  });

  it("masks a failure message from the service", async () => {
    const fake = makeFakeSecrets({ metadata: META });
    fake.service.listSecretMetadata = () => Promise.reject(new Error(`falha com ${FAKE_VALUE}`));
    const err = (await listSecrets(fake.getSecrets).catch((e: unknown) => e)) as RemoteError;
    expect(err.codigo).toBe("rede");
    expect(err.mensagem).not.toContain(FAKE_VALUE);
  });
});

describe("inspectSecrets", () => {
  it("tells why the list is empty and never throws", async () => {
    expect(await inspectSecrets(() => undefined)).toEqual({ status: "sem_servico", secrets: [] });
    expect(await inspectSecrets(makeFakeSecrets().getSecrets)).toEqual({ status: "sem_listagem", secrets: [] });
    const locked = makeFakeSecrets({ metadata: META });
    locked.lock();
    expect(await inspectSecrets(locked.getSecrets)).toEqual({ status: "cofre_bloqueado", secrets: [] });
    const broken = makeFakeSecrets({ metadata: META });
    broken.service.listSecretMetadata = () => Promise.reject(new Error("falha"));
    expect(await inspectSecrets(broken.getSecrets)).toEqual({ status: "erro", secrets: [] });
    const ok = await inspectSecrets(makeFakeSecrets({ metadata: META }).getSecrets);
    expect(ok.status).toBe("ok");
    expect(ok.secrets).toHaveLength(2);
  });
});

describe("findSecret and redactWith", () => {
  it("finds a secret by name and gives undefined for none, unknown or no listing", async () => {
    const fake = makeFakeSecrets({ metadata: META });
    expect((await findSecret(fake.getSecrets, "BB_TESTE"))?.type).toBe("basic");
    expect(await findSecret(fake.getSecrets, "OUTRA")).toBeUndefined();
    expect(await findSecret(fake.getSecrets, "")).toBeUndefined();
    expect(await findSecret(makeFakeSecrets().getSecrets, "GH_TESTE")).toBeUndefined();
  });

  it("redacts with the service and falls back to the plain text", () => {
    const fake = makeFakeSecrets();
    expect(redactWith(fake.getSecrets, `a ${FAKE_VALUE} b`)).toBe("a [REDACTED] b");
    expect(redactWith(() => undefined, "texto")).toBe("texto");
  });
});
