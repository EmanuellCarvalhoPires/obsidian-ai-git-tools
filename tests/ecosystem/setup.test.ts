import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "../../src/types";
import type { Settings } from "../../src/types";
import { SETUP_KEYS, createSetupHandler } from "../../src/ecosystem/setup";
import { inspectSecrets } from "../../src/core/providers/secrets";
import type { SecretListing, SecretsGetter } from "../../src/core/providers/secrets";
import { makeFakeSecrets, secretInfo } from "../helpers/fake-secrets";

function make(folders: string[] = ["Projetos"], listSecrets: () => Promise<SecretListing> = () => Promise.resolve({ status: "ok", secrets: [] })) {
  const settings: Settings = { ...DEFAULT_SETTINGS };
  let saved = 0;
  const handler = createSetupHandler({
    getSettings: () => settings,
    saveSettings: async () => void (saved += 1),
    folderExists: (p) => folders.includes(p),
    listSecrets,
  });
  return { settings, handler, saved: () => saved };
}

describe("setup handler", () => {
  it("detects the folder and the secret choices, never secret values", async () => {
    const { handler, settings } = make();
    settings.secretGithub = "gh-token-name";
    expect(await handler.detect!()).toEqual({
      projectsRoot: "Projetos",
      projectsRootExists: true,
      secrets: [],
      secretsStatus: "ok",
      secretGithub: "gh-token-name",
      secretBitbucket: "nenhuma",
    });
  });

  describe("detect with the secrets of Environment Keys", () => {
    const withService = (getSecrets: SecretsGetter) => make(["Projetos"], () => inspectSecrets(getSecrets));

    it("lists the metadata only (names, types, hosts), never values", async () => {
      const fake = makeFakeSecrets({ metadata: [secretInfo("GH_TESTE"), secretInfo("BB_TESTE", "basic", { allowedHosts: ["api.bitbucket.org"] })] });
      const detected = await withService(fake.getSecrets).handler.detect!();
      expect(detected.secretsStatus).toBe("ok");
      expect(detected.secrets).toEqual([
        { name: "GH_TESTE", type: "bearer", hasUsername: false, allowedHosts: ["api.github.com"], allowAnyHost: false, approval: "never" },
        { name: "BB_TESTE", type: "basic", hasUsername: true, allowedHosts: ["api.bitbucket.org"], allowAnyHost: false, approval: "never" },
      ]);
      expect(detected.projectsRoot).toBe("Projetos");
    });

    it("gives an empty list and says so when the service has no listSecretMetadata", async () => {
      const detected = await withService(makeFakeSecrets().getSecrets).handler.detect!();
      expect(detected.secrets).toEqual([]);
      expect(detected.secretsStatus).toBe("sem_listagem");
      expect(detected.projectsRootExists).toBe(true);
    });

    it("gives an empty list when Environment Keys is missing or locked", async () => {
      expect((await withService(() => undefined).handler.detect!()).secretsStatus).toBe("sem_servico");
      const locked = makeFakeSecrets({ metadata: [secretInfo("GH_TESTE")] });
      locked.lock();
      const detected = await withService(locked.getSecrets).handler.detect!();
      expect(detected.secrets).toEqual([]);
      expect(detected.secretsStatus).toBe("cofre_bloqueado");
    });

    it("survives a listing that throws", async () => {
      const h = make(["Projetos"], () => Promise.reject(new Error("falha")));
      const detected = await h.handler.detect!();
      expect(detected.secrets).toEqual([]);
      expect(detected.secretsStatus).toBe("erro");
    });
  });

  it('saves "nenhuma" as an empty secret name', async () => {
    const h = make();
    h.settings.secretGithub = "gh";
    h.settings.secretBitbucket = "bb";
    expect(await h.handler.save!("secret_github", "nenhuma")).toBeUndefined();
    expect(await h.handler.save!("secret_bitbucket", " nenhuma ")).toBeUndefined();
    expect(h.settings).toMatchObject({ secretGithub: "", secretBitbucket: "" });
    expect(h.saved()).toBe(2);
  });

  it("saves a secret name as given", async () => {
    const h = make();
    await h.handler.save!("secret_bitbucket", "bb-token");
    expect(h.settings.secretBitbucket).toBe("bb-token");
  });

  it('refuses a folder with ".." and keeps the old value', async () => {
    const h = make();
    expect(await h.handler.save!("pasta_dos_projetos", "../fora")).toMatch(/vault-relative/);
    expect(h.settings.projectsRoot).toBe("Projetos");
    expect(h.saved()).toBe(0);
  });

  it("saves a valid folder without slashes at the edges", async () => {
    const h = make();
    expect(await h.handler.save!("pasta_dos_projetos", "/Dev/Projetos/")).toBeUndefined();
    expect(h.settings.projectsRoot).toBe("Dev/Projetos");
  });

  it("refuses an unknown key and lists the accepted ones", async () => {
    const h = make();
    const message = await h.handler.save!("outra", 1);
    expect(message).toContain(SETUP_KEYS[0]);
    expect(message).toContain("Unknown key");
    expect(h.saved()).toBe(0);
  });

  it("validates ok when the projects folder exists", async () => {
    expect(await make(["Projetos"]).handler.validate!()).toEqual({ ok: true });
  });

  it("validates not ok when the projects folder is missing", async () => {
    const result = await make([]).handler.validate!();
    expect(result.ok).toBe(false);
    expect(result.missing?.length).toBeGreaterThan(0);
  });
});
