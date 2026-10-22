// Release and repository creation on GitHub (criarRelease, criarRepoGithub) over the fake secrets service: no network.
import { describe, expect, it } from "vitest";
import { RemoteError } from "../../src/core/providers/errors";
import { GITHUB_UPLOADS, createGithubProvider, criarRepoGithub } from "../../src/core/providers/github";
import { createSecureHttp } from "../../src/core/providers/http";
import type { RemoteRef } from "../../src/core/providers/provider";
import type { SecretResponse } from "../../src/ecosystem/types";
import { FAKE_VALUE, makeFakeSecrets, reply } from "../helpers/fake-secrets";
import type { FakeSecrets } from "../helpers/fake-secrets";

const REF: RemoteRef = { provider: "github", owner: "o", slug: "r", repo: "o/r" };
const AUTH = "{{bearer:GH_TESTE}}";

const sent = (fake: FakeSecrets) => fake.calls.map((c) => c.req);

type Call = { url: URL; method: string; body: unknown; headers: Record<string, string> };
type Route = (call: Call) => SecretResponse | undefined;

function setup(...routes: Route[]): { fake: FakeSecrets; http: ReturnType<typeof createSecureHttp> } {
  const fake = makeFakeSecrets({
    handler: (req) => {
      const call: Call = { url: new URL(req.url), method: req.method, body: req.body, headers: req.headers ?? {} };
      for (const route of routes) {
        const out = route(call);
        if (out) return out;
      }
      return reply(599, { message: `unexpected ${req.method} ${req.url}` });
    },
  });
  return { fake, http: createSecureHttp(fake.getSecrets) };
}

const on =
  (method: string, path: string, answer: SecretResponse | ((c: Call) => SecretResponse)): Route =>
  (c) =>
    c.method === method && c.url.pathname === path ? (typeof answer === "function" ? answer(c) : answer) : undefined;

const release = (over: Record<string, unknown> = {}) => ({
  id: 55,
  tag_name: "1.1.0",
  name: "1.1.0",
  html_url: "https://github.com/o/r/releases/tag/1.1.0",
  draft: false,
  prerelease: false,
  ...over,
});

describe("criarRelease", () => {
  it("creates the release with the generated notes and sends the placeholder, never a value", async () => {
    const { fake, http } = setup(on("POST", "/repos/o/r/releases", reply(201, release())));
    const provider = createGithubProvider({ http, ref: REF, secretName: "GH_TESTE" });
    const res = await provider.criarRelease!({ tag: "1.1.0", gerarNotas: true, rascunho: false, prerelease: false, ativos: [] });
    expect(res).toMatchObject({ id: "55", tag: "1.1.0", url: "https://github.com/o/r/releases/tag/1.1.0", ativos: [] });
    const call = sent(fake)[0]!;
    expect(call.body).toMatchObject({ tag_name: "1.1.0", name: "1.1.0", draft: false, prerelease: false, generate_release_notes: true });
    expect(call.headers?.Authorization).toBe(AUTH);
    expect(JSON.stringify(sent(fake))).not.toContain(FAKE_VALUE);
  });

  it("uses the given notes and target instead of generating them", async () => {
    const { fake, http } = setup(on("POST", "/repos/o/r/releases", reply(201, release({ draft: true }))));
    const provider = createGithubProvider({ http, ref: REF, secretName: "GH_TESTE" });
    const res = await provider.criarRelease!({ tag: "1.1.0", titulo: "Versão 1.1.0", notas: "Texto", gerarNotas: true, alvo: "main", rascunho: true, prerelease: false, ativos: [] });
    expect(res.rascunho).toBe(true);
    expect(sent(fake)[0]!.body).toMatchObject({ name: "Versão 1.1.0", body: "Texto", generate_release_notes: false, target_commitish: "main", draft: true });
  });

  it("attaches each file through the uploads host with its content type", async () => {
    const { fake, http } = setup(
      on("POST", "/repos/o/r/releases", reply(201, release())),
      on("POST", "/repos/o/r/releases/55/assets", reply(201, { id: 1 })),
    );
    const provider = createGithubProvider({ http, ref: REF, secretName: "GH_TESTE" });
    const res = await provider.criarRelease!({
      tag: "1.1.0",
      gerarNotas: true,
      rascunho: false,
      prerelease: false,
      ativos: [
        { nome: "main.js", conteudo: "console.log(1)", contentType: "application/javascript" },
        { nome: "manifest.json", conteudo: "{}", contentType: "application/json" },
      ],
    });
    expect(res.ativos).toEqual(["main.js", "manifest.json"]);
    const uploads = sent(fake).filter((c) => c.url.startsWith(GITHUB_UPLOADS));
    expect(uploads).toHaveLength(2);
    expect(uploads[0]!.url).toBe(`${GITHUB_UPLOADS}/repos/o/r/releases/55/assets?name=main.js`);
    expect(uploads[0]!.headers?.["Content-Type"]).toBe("application/javascript");
    expect(uploads[0]!.body).toBe("console.log(1)");
    expect(uploads[1]!.headers?.Authorization).toBe(AUTH);
  });

  it("says that the release exists when a file fails to upload", async () => {
    const { http } = setup(
      on("POST", "/repos/o/r/releases", reply(201, release())),
      on("POST", "/repos/o/r/releases/55/assets", reply(422, { message: "Validation Failed" })),
    );
    const provider = createGithubProvider({ http, ref: REF, secretName: "GH_TESTE" });
    const err = await provider
      .criarRelease!({ tag: "1.1.0", gerarNotas: true, rascunho: false, prerelease: false, ativos: [{ nome: "main.js", conteudo: "x", contentType: "application/javascript" }] })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RemoteError);
    const re = err as RemoteError;
    expect(re.mensagem).toContain("foi criada");
    expect(re.mensagem).toContain("main.js");
    expect(re.status).toBe(422);
  });

  it("refuses when GitHub already has the tag as a release (422)", async () => {
    const { http } = setup(on("POST", "/repos/o/r/releases", reply(422, { message: "Validation Failed", errors: [{ message: "already_exists" }] })));
    const provider = createGithubProvider({ http, ref: REF, secretName: "GH_TESTE" });
    await expect(provider.criarRelease!({ tag: "1.1.0", gerarNotas: true, rascunho: false, prerelease: false, ativos: [] })).rejects.toMatchObject({ codigo: "provedor_http_422" });
  });
});

describe("criarRepoGithub", () => {
  const me = on("GET", "/user", reply(200, { login: "Ana" }));
  const created = (over: Record<string, unknown> = {}) => ({
    name: "novo",
    private: true,
    owner: { login: "Ana" },
    html_url: "https://github.com/Ana/novo",
    clone_url: "https://github.com/Ana/novo.git",
    default_branch: "main",
    ...over,
  });

  it("creates the repository of the user of the secret", async () => {
    const { fake, http } = setup(me, on("POST", "/user/repos", reply(201, created())));
    const res = await criarRepoGithub({ http, secretName: "GH_TESTE" }, { nome: "novo", privado: true, descricao: "Teste" });
    expect(res).toEqual({ provedor: "github", dono: "Ana", slug: "novo", privado: true, url: "https://github.com/Ana/novo", cloneUrl: "https://github.com/Ana/novo.git", branchPadrao: "main" });
    const post = sent(fake).find((c) => c.method === "POST")!;
    expect(post.body).toEqual({ name: "novo", private: true, auto_init: false, description: "Teste" });
    expect(post.headers?.Authorization).toBe(AUTH);
    expect(JSON.stringify(sent(fake))).not.toContain(FAKE_VALUE);
  });

  it("uses the user endpoint when dono is the user, whatever the case", async () => {
    const { fake, http } = setup(me, on("POST", "/user/repos", reply(201, created())));
    await criarRepoGithub({ http, secretName: "GH_TESTE" }, { nome: "novo", privado: false, dono: "ana" });
    expect(sent(fake).some((c) => c.method === "POST" && c.url.endsWith("/user/repos"))).toBe(true);
    expect(sent(fake).find((c) => c.method === "POST")!.body).toMatchObject({ private: false });
  });

  it("uses the organization endpoint for another dono", async () => {
    const { fake, http } = setup(me, on("POST", "/orgs/acme/repos", reply(201, created({ owner: { login: "acme" } }))));
    const res = await criarRepoGithub({ http, secretName: "GH_TESTE" }, { nome: "novo", privado: true, dono: "acme" });
    expect(res.dono).toBe("acme");
    expect(sent(fake).some((c) => c.url.endsWith("/orgs/acme/repos"))).toBe(true);
  });

  it("rejects an invalid name before any call", async () => {
    const { fake, http } = setup();
    await expect(criarRepoGithub({ http, secretName: "GH_TESTE" }, { nome: "com espaço", privado: true })).rejects.toMatchObject({ codigo: "argumento_invalido" });
    expect(sent(fake)).toHaveLength(0);
  });

  it("answers secret_nao_configurada without a secret", async () => {
    const { fake, http } = setup();
    await expect(criarRepoGithub({ http, secretName: "" }, { nome: "novo", privado: true })).rejects.toMatchObject({ codigo: "secret_nao_configurada" });
    expect(sent(fake)).toHaveLength(0);
  });

  it("reports a 422 (name already taken) with the provider text", async () => {
    const { http } = setup(me, on("POST", "/user/repos", reply(422, { message: "Repository creation failed.", errors: [{ message: "name already exists on this account" }] })));
    const err = (await criarRepoGithub({ http, secretName: "GH_TESTE" }, { nome: "novo", privado: true }).catch((e: unknown) => e)) as RemoteError;
    expect(err.codigo).toBe("provedor_http_422");
    expect(err.mensagem).toContain("name already exists");
  });
});

describe("anexarRelease", () => {
  it("finds the release by tag and attaches the files with rawBody, never a placeholder in the body", async () => {
    const { fake, http } = setup(
      on("GET", "/repos/o/r/releases/tags/1.1.0", reply(200, release({ id: 88 }))),
      on("POST", "/repos/o/r/releases/88/assets", reply(201, { id: 1 })),
    );
    const provider = createGithubProvider({ http, ref: REF, secretName: "GH_TESTE" });
    const res = await provider.anexarRelease!({ tag: "1.1.0", ativos: [{ nome: "main.js", conteudo: "x {{secret:NOME}}", contentType: "application/javascript" }] });
    expect(res).toMatchObject({ id: "88", tag: "1.1.0", ativos: ["main.js"] });
    const upload = sent(fake).find((c) => c.url.startsWith(GITHUB_UPLOADS))!;
    expect(upload.rawBody).toBe(true);
    expect(upload.body).toBe("x {{secret:NOME}}");
  });

  it("refuses when there is no release with that tag", async () => {
    const { http } = setup(on("GET", "/repos/o/r/releases/tags/9.9.9", reply(404, { message: "Not Found" })));
    const provider = createGithubProvider({ http, ref: REF, secretName: "GH_TESTE" });
    await expect(provider.anexarRelease!({ tag: "9.9.9", ativos: [] })).rejects.toMatchObject({ codigo: "provedor_http_404" });
  });
});