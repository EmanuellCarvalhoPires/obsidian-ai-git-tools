// git_repo_criar and git_release_criar on real local repositories and the fake `secrets` service:
// no network. The GitHub answers come from routes; anything else is a 599 so a surprise fails the test.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { SecretRequest, SecretResponse } from "../../src/ecosystem/types";
import { buildGitTools } from "../../src/tools/git-tools";
import { FAKE_VALUE, makeFakeSecrets, reply } from "../helpers/fake-secrets";
import type { FakeSecrets } from "../helpers/fake-secrets";
import { cleanupTemp, makeRepo, makeTempDir, sh } from "../helpers/git-repos";
import { callTool, dataOf, makeDeps, textOf } from "../helpers/tool-deps";
import { createRemoteCache } from "../../src/core/repo-resolver";
import type { RemoteCache } from "../../src/core/repo-resolver";

afterAll(() => cleanupTemp());

const GH_REMOTE = "https://github.com/o/r.git";
const BB_REMOTE = "https://bitbucket.org/ws/r.git";

type Route = (req: SecretRequest, url: URL) => SecretResponse | undefined;

function handlerOf(...routes: Route[]): (req: SecretRequest) => SecretResponse {
  return (req) => {
    const url = new URL(req.url);
    for (const route of routes) {
      const out = route(req, url);
      if (out) return out;
    }
    return reply(599, { message: `inesperado ${req.method} ${req.url}` });
  };
}

const on =
  (method: string, path: string, answer: SecretResponse): Route =>
  (req, url) =>
    req.method === method && url.pathname === path ? answer : undefined;

interface Env {
  base: string;
  repo: string;
  tools: ReturnType<typeof buildGitTools>;
  fake: FakeSecrets;
}

function makeEnv(routes: Route[], opts: { remote?: string; secretGithub?: string; remoteCache?: RemoteCache } = {}): Env {
  const base = makeTempDir();
  const repo = makeRepo(base);
  if (opts.remote !== undefined) sh(repo, "remote", "add", "origin", opts.remote);
  const fake = makeFakeSecrets({ handler: handlerOf(...routes) });
  const deps = makeDeps({
    allowed: [base],
    getSecrets: fake.getSecrets,
    redact: (t) => fake.service.redact(t),
    settings: { secretGithub: opts.secretGithub ?? "GH_TESTE", secretBitbucket: "BB_TESTE" },
    remoteCache: opts.remoteCache,
  });
  return { base, repo, tools: buildGitTools(deps), fake };
}

const me = on("GET", "/user", reply(200, { login: "o" }));
const repoCreated = (over: Record<string, unknown> = {}) => ({
  name: "novo",
  private: false,
  owner: { login: "o" },
  html_url: "https://github.com/o/novo",
  clone_url: "https://github.com/o/novo.git",
  default_branch: "main",
  ...over,
});
const sent = (fake: FakeSecrets) => fake.calls.map((c) => c.req);
const posts = (fake: FakeSecrets) => sent(fake).filter((c) => c.method === "POST");

describe("git_repo_criar", () => {
  it("requires `privado` and does not call the network without it", async () => {
    const env = makeEnv([me]);
    const res = await callTool(env.tools, "git_repo_criar", { nome: "novo" });
    expect(res.isError).toBe(true);
    expect(dataOf(res).codigo).toBe("argumento_invalido");
    expect(textOf(res)).toContain("privado");
    expect(sent(env.fake)).toHaveLength(0);
  });

  it("creates the repository and adds the remote to the local clone", async () => {
    const env = makeEnv([me, on("POST", "/user/repos", reply(201, repoCreated()))]);
    const res = await callTool(env.tools, "git_repo_criar", { nome: "novo", privado: false, descricao: "Teste", repo: env.repo });
    expect(res.isError).toBeUndefined();
    expect(dataOf(res)).toMatchObject({ provedor: "github", repo: "o/novo", privado: false, url: "https://github.com/o/novo", remoto: "origin", remoto_adicionado: true });
    expect(sh(env.repo, "remote", "get-url", "origin").trim()).toBe("https://github.com/o/novo.git");
    expect(posts(env.fake)[0]!.body).toMatchObject({ name: "novo", private: false, description: "Teste" });
    expect(JSON.stringify(sent(env.fake))).not.toContain(FAKE_VALUE);
  });

  it("creates only the remote repository when repo is not given", async () => {
    const env = makeEnv([me, on("POST", "/user/repos", reply(201, repoCreated({ private: true })))]);
    const res = await callTool(env.tools, "git_repo_criar", { nome: "novo", privado: true });
    expect(dataOf(res)).toMatchObject({ ok: true, privado: true });
    expect(dataOf(res).repo_local).toBeUndefined();
  });

  it("refuses to replace a remote that already exists, before creating anything", async () => {
    const env = makeEnv([me, on("POST", "/user/repos", reply(201, repoCreated()))], { remote: GH_REMOTE });
    const res = await callTool(env.tools, "git_repo_criar", { nome: "novo", privado: true, repo: env.repo });
    expect(res.isError).toBe(true);
    expect(dataOf(res).codigo).toBe("argumento_invalido");
    expect(posts(env.fake)).toHaveLength(0);
    expect(sh(env.repo, "remote", "get-url", "origin").trim()).toBe(GH_REMOTE);
  });

  it("answers secret_nao_configurada without a secret", async () => {
    const env = makeEnv([me], { secretGithub: "" });
    const res = await callTool(env.tools, "git_repo_criar", { nome: "novo", privado: true });
    expect(dataOf(res).codigo).toBe("secret_nao_configurada");
    expect(sent(env.fake)).toHaveLength(0);
  });

  it("shows the provider reason when the name is taken (422)", async () => {
    const env = makeEnv([me, on("POST", "/user/repos", reply(422, { message: "Repository creation failed.", errors: [{ message: "name already exists on this account" }] }))]);
    const res = await callTool(env.tools, "git_repo_criar", { nome: "novo", privado: true });
    expect(res.isError).toBe(true);
    expect(dataOf(res).codigo).toBe("provedor_http_422");
    expect(textOf(res)).toContain("name already exists");
  });

  it("rejects an unknown argument and a bad remote name", async () => {
    const env = makeEnv([me]);
    expect(dataOf(await callTool(env.tools, "git_repo_criar", { nome: "novo", privado: true, foo: 1 })).codigo).toBe("argumento_invalido");
    expect(dataOf(await callTool(env.tools, "git_repo_criar", { nome: "novo", privado: true, repo: env.repo, nome_remoto: "-x" })).codigo).toBe("argumento_invalido");
    expect(sent(env.fake)).toHaveLength(0);
  });

  it("caches negative remote on clone without remote and invalidates cache when remote is added", async () => {
    const cache = createRemoteCache();
    const env = makeEnv([me, on("POST", "/user/repos", reply(201, repoCreated()))], { remoteCache: cache });
    await callTool(env.tools, "git_status", { repo: env.repo });
    expect(cache.get(env.repo)).toBeNull();

    const res = await callTool(env.tools, "git_repo_criar", { nome: "novo", privado: false, repo: env.repo });
    expect(res.isError).toBeUndefined();
    expect(sh(env.repo, "remote", "get-url", "origin").trim()).toBe("https://github.com/o/novo.git");
    expect(cache.get(env.repo)).toBeUndefined();

    await callTool(env.tools, "git_status", { repo: env.repo });
    expect(cache.get(env.repo)).toMatchObject({ nome: "origin" });
  });
});

describe("git_release_criar", () => {
  const releaseRoutes = (): Route[] => [
    on("POST", "/repos/o/r/releases", reply(201, { id: 77, tag_name: "1.1.0", name: "1.1.0", html_url: "https://github.com/o/r/releases/tag/1.1.0", draft: false, prerelease: false })),
    on("POST", "/repos/o/r/releases/77/assets", reply(201, { id: 1 })),
  ];

  it("publishes the release with the generated notes", async () => {
    const env = makeEnv(releaseRoutes(), { remote: GH_REMOTE });
    const res = await callTool(env.tools, "git_release_criar", { repo: env.repo, tag: "1.1.0" });
    expect(res.isError).toBeUndefined();
    expect(dataOf(res)).toMatchObject({ provedor: "github", tag: "1.1.0", url: "https://github.com/o/r/releases/tag/1.1.0", arquivos: [] });
    expect(posts(env.fake)[0]!.body).toMatchObject({ tag_name: "1.1.0", generate_release_notes: true });
  });

  it("attaches the text files of the repository", async () => {
    const env = makeEnv(releaseRoutes(), { remote: GH_REMOTE });
    writeFileSync(join(env.repo, "main.js"), "console.log(1)");
    writeFileSync(join(env.repo, "manifest.json"), "{}");
    const res = await callTool(env.tools, "git_release_criar", { repo: env.repo, tag: "1.1.0", arquivos: ["main.js", "manifest.json"] });
    expect(dataOf(res).arquivos).toEqual(["main.js", "manifest.json"]);
    const uploads = sent(env.fake).filter((c) => c.url.includes("/assets"));
    expect(uploads).toHaveLength(2);
    expect(uploads[0]!.body).toBe("console.log(1)");
    expect(uploads[1]!.headers?.["Content-Type"]).toBe("application/json");
  });

  it("refuses a file outside the repository, a missing file and a binary file, before any call", async () => {
    const env = makeEnv(releaseRoutes(), { remote: GH_REMOTE });
    writeFileSync(join(env.repo, "bin.dat"), Buffer.from([0x41, 0x00, 0x42]));
    for (const arquivos of [["../segredo.txt"], [join(env.base, "x.txt")], ["nao-existe.js"], ["bin.dat"]]) {
      const res = await callTool(env.tools, "git_release_criar", { repo: env.repo, tag: "1.1.0", arquivos });
      expect(res.isError, arquivos.join()).toBe(true);
      expect(dataOf(res).codigo, arquivos.join()).toBe("argumento_invalido");
    }
    expect(sent(env.fake)).toHaveLength(0);
  });

  it("explains that Bitbucket has no releases", async () => {
    const env = makeEnv([], { remote: BB_REMOTE });
    const res = await callTool(env.tools, "git_release_criar", { repo: env.repo, tag: "1.1.0" });
    expect(res.isError).toBe(true);
    expect(dataOf(res).codigo).toBe("argumento_invalido");
    expect(textOf(res)).toContain("Bitbucket");
    expect(sent(env.fake)).toHaveLength(0);
  });

  it("answers secret_nao_configurada without a secret, and refuses a repository without a remote", async () => {
    const semSecret = makeEnv([], { remote: GH_REMOTE, secretGithub: "" });
    expect(dataOf(await callTool(semSecret.tools, "git_release_criar", { repo: semSecret.repo, tag: "1.1.0" })).codigo).toBe("secret_nao_configurada");
    const semRemoto = makeEnv([]);
    const res = await callTool(semRemoto.tools, "git_release_criar", { repo: semRemoto.repo, tag: "1.1.0" });
    expect(dataOf(res).codigo).toBe("argumento_invalido");
    expect(textOf(res)).toContain("remoto");
  });

  it("attaches files to an existing release with anexar_apenas", async () => {
    const env = makeEnv(
      [
        on("GET", "/repos/o/r/releases/tags/1.1.0", reply(200, { id: 7, tag_name: "1.1.0", name: "1.1.0", html_url: "https://github.com/o/r/releases/tag/1.1.0", draft: false, prerelease: false })),
        on("POST", "/repos/o/r/releases/7/assets", reply(201, { id: 1 })),
      ],
      { remote: GH_REMOTE },
    );
    writeFileSync(join(env.repo, "main.js"), "console.log(1)");
    const res = await callTool(env.tools, "git_release_criar", { repo: env.repo, tag: "1.1.0", anexar_apenas: true, arquivos: ["main.js"] });
    expect(res.isError).toBeUndefined();
    expect(dataOf(res).arquivos).toEqual(["main.js"]);
    const postReleases = sent(env.fake).filter((c) => c.method === "POST" && new URL(c.url).pathname === "/repos/o/r/releases");
    expect(postReleases).toHaveLength(0);
  });

  it("refuses anexar_apenas combined with titulo", async () => {
    const env = makeEnv([], { remote: GH_REMOTE });
    const res = await callTool(env.tools, "git_release_criar", { repo: env.repo, tag: "1.1.0", anexar_apenas: true, titulo: "v1.1.0", arquivos: ["main.js"] });
    expect(res.isError).toBe(true);
    expect(dataOf(res).codigo).toBe("argumento_invalido");
    expect(sent(env.fake)).toHaveLength(0);
  });

  it("refuses anexar_apenas without arquivos", async () => {
    const env = makeEnv([], { remote: GH_REMOTE });
    const res = await callTool(env.tools, "git_release_criar", { repo: env.repo, tag: "1.1.0", anexar_apenas: true });
    expect(res.isError).toBe(true);
    expect(dataOf(res).codigo).toBe("argumento_invalido");
  });

  it("fails with provedor_http_404 when the tag has no release", async () => {
    const env = makeEnv(
      [on("GET", "/repos/o/r/releases/tags/1.1.0", reply(404, { message: "Not Found" }))],
      { remote: GH_REMOTE },
    );
    writeFileSync(join(env.repo, "main.js"), "console.log(1)");
    const res = await callTool(env.tools, "git_release_criar", { repo: env.repo, tag: "1.1.0", anexar_apenas: true, arquivos: ["main.js"] });
    expect(res.isError).toBe(true);
    expect(dataOf(res).codigo).toBe("provedor_http_404");
  });
});
