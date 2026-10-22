// Tests of the six provider tools on real repositories (a remote with a fictitious GitHub or
// Bitbucket URL) and the fake `secrets` service: no network. `ls-remote` is pointed at a local bare
// repository by wrapping the git runner (the remote URL itself stays fictitious).
import { afterAll, describe, expect, it } from "vitest";
import { createBitbucketProviderWith } from "../../src/core/providers/bitbucket";
import type { BitbucketOptions } from "../../src/core/providers/bitbucket";
import { createNodeGit } from "../../src/core/git-runner";
import type { GitRunner } from "../../src/core/ports";
import type { ProviderFactory, ProviderId } from "../../src/core/providers/provider";
import type { HubTool, HubToolResult, SecretRequest, SecretResponse, SecretInfo } from "../../src/ecosystem/types";
import { buildGitTools } from "../../src/tools/git-tools";
import { gitflowAvisos } from "../../src/tools/provider-tools";
import { FAKE_VALUE, makeFakeSecrets, reply, secretInfo } from "../helpers/fake-secrets";
import type { FakeSecrets } from "../helpers/fake-secrets";
import { cleanupTemp, makeBareRemote, makeRepo, makeTempDir, sh } from "../helpers/git-repos";
import { callTool, dataOf, makeDeps, textOf } from "../helpers/tool-deps";

afterAll(() => cleanupTemp());

const GH_REMOTE = "https://github.com/o/r.git";
const BB_REMOTE = "https://bitbucket.org/ws/r.git";
const BB = "https://api.bitbucket.org/2.0/repositories/ws/r";
const GH_SHA = "a".repeat(40);

interface Call {
  method: string;
  url: URL;
  body: unknown;
  headers: Record<string, string>;
}
type Route = (call: Call) => SecretResponse | undefined;

/** Answers with the first route that applies; anything else is a 599 so that a surprise fails the test. */
function routed(...routes: Route[]): (req: SecretRequest) => SecretResponse {
  return (req) => {
    const call: Call = { method: req.method, url: new URL(req.url), body: req.body, headers: req.headers ?? {} };
    for (const route of routes) {
      const out = route(call);
      if (out) return out;
    }
    return reply(599, { message: `inesperado ${req.method} ${req.url}` });
  };
}

const on =
  (method: string, path: string, answer: SecretResponse | ((c: Call) => SecretResponse)): Route =>
  (c) =>
    c.method === method && c.url.pathname === path ? (typeof answer === "function" ? answer(c) : answer) : undefined;

interface Env {
  repo: string;
  bare: string;
  tools: HubTool[];
  fake: FakeSecrets;
  /** Arguments of every `ls-remote` the tools ran. */
  lsRemote: string[][];
}

interface EnvOptions {
  /** URL of the remote `origin`; "bare" keeps a remote that is not GitHub or Bitbucket. */
  remote: string;
  handler?: (req: SecretRequest) => SecretResponse;
  secretGithub?: string;
  secretBitbucket?: string;
  metadata?: SecretInfo[];
  /** Branches that exist in the bare remote besides main. */
  remoteBranches?: string[];
  lsRemoteFails?: boolean;
  providerFactories?: Partial<Record<ProviderId, ProviderFactory>>;
}

function makeEnv(opts: EnvOptions): Env {
  const base = makeTempDir();
  const bare = makeBareRemote(base);
  const repo = makeRepo(base);
  sh(repo, "remote", "add", "origin", opts.remote === "bare" ? bare : opts.remote);
  sh(repo, "push", "--quiet", bare, "main");
  for (const b of opts.remoteBranches ?? ["feature/x"]) {
    sh(repo, "branch", b);
    sh(repo, "push", "--quiet", bare, b);
  }
  const real = createNodeGit();
  const lsRemote: string[][] = [];
  const git: GitRunner = (cwd, args, o) => {
    if (args[0] !== "ls-remote") return real(cwd, args, o);
    lsRemote.push(args);
    if (opts.lsRemoteFails) return Promise.reject(new Error("sem rede"));
    return real(cwd, args.map((a) => (a === "origin" ? bare : a)), o);
  };
  const fake = makeFakeSecrets({
    handler: opts.handler ?? (() => reply(599, { message: "sem rota" })),
    ...(opts.metadata ? { metadata: opts.metadata } : {}),
  });
  const deps = makeDeps({
    allowed: [base],
    git,
    getSecrets: fake.getSecrets,
    redact: (t) => fake.service.redact(t),
    settings: { secretGithub: opts.secretGithub ?? "GH_TESTE", secretBitbucket: opts.secretBitbucket ?? "BB_TESTE" },
    ...(opts.providerFactories ? { providerFactories: opts.providerFactories } : {}),
  });
  return { repo, bare, tools: buildGitTools(deps), fake, lsRemote };
}

const prBody = (over: Record<string, unknown> = {}) => ({
  id: 12,
  title: "Minha feature",
  description: "Descricao",
  state: "OPEN",
  created_on: "2026-10-01T10:00:00Z",
  author: { display_name: "Ana" },
  source: { branch: { name: "feature/x" }, commit: { hash: "aaa111" } },
  destination: { branch: { name: "develop" } },
  links: { html: { href: "https://bitbucket.org/ws/r/pull-requests/12" } },
  ...over,
});

const ghPr = (over: Record<string, unknown> = {}) => ({
  number: 12,
  title: "Feature X",
  state: "open",
  merged_at: null,
  html_url: "https://github.com/o/r/pull/12",
  user: { login: "ana" },
  created_at: "2026-10-01T10:00:00Z",
  body: "Descricao",
  head: { ref: "feature/x", sha: GH_SHA },
  base: { ref: "develop" },
  ...over,
});

/** Calls that reached the provider, as `METHOD path`. */
const requests = (fake: FakeSecrets): string[] => fake.calls.map((c) => `${c.req.method} ${new URL(c.req.url).pathname}`);
const writes = (fake: FakeSecrets): string[] => requests(fake).filter((r) => !r.startsWith("GET "));
const dica = (res: HubToolResult): Record<string, unknown> => dataOf(res).dica as Record<string, unknown>;

function fakeClock(): { options: BitbucketOptions; time: () => number } {
  let t = 0;
  return {
    options: {
      now: () => t,
      sleep: async (ms) => {
        t += ms;
      },
    },
    time: () => t,
  };
}

describe("the 26 tools", () => {
  it("adds the six provider tools with the annotations of the contract", () => {
    const { tools } = makeEnv({ remote: BB_REMOTE });
    expect(tools).toHaveLength(26);
    const byName = (n: string) => tools.find((t) => t.name === n)!;
    for (const n of ["git_pr_listar", "git_pr_obter", "git_pipeline_status"]) {
      expect(byName(n).annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, openWorldHint: true });
    }
    for (const n of ["git_pr_criar", "git_pr_comentar"]) {
      expect(byName(n).annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false, openWorldHint: true });
    }
    expect(byName("git_pr_merge").annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true, openWorldHint: true });
  });

  it("has strict schemas and Portuguese descriptions that name the fallback and the approval", () => {
    const { tools } = makeEnv({ remote: BB_REMOTE });
    for (const n of ["git_pr_criar", "git_pr_listar", "git_pr_obter", "git_pr_comentar", "git_pr_merge", "git_pipeline_status"]) {
      const t = tools.find((x) => x.name === n)!;
      expect(t.inputSchema.additionalProperties).toBe(false);
      expect(t.description).toContain("search_vault_tools + run_vault_tool");
      expect(t.description).toContain("{{bearer:NOME}}");
    }
    const merge = tools.find((t) => t.name === "git_pr_merge")!;
    expect(merge.description).toContain("aprovação do usuário");
    expect(merge.inputSchema.required).toEqual(["repo", "numero", "destino", "titulo", "estrategia"]);
  });
});

describe("git_pr_criar", () => {
  it("opens a PR on Bitbucket with close_source_branch false and returns the number and the URL", async () => {
    const env = makeEnv({ remote: BB_REMOTE, handler: routed(on("POST", "/2.0/repositories/ws/r/pullrequests", reply(201, prBody()))) });
    const res = await callTool(env.tools, "git_pr_criar", { repo: env.repo, origem: "feature/x", destino: "develop", titulo: "Minha feature", descricao: "Descricao" });
    expect(res.isError).toBeUndefined();
    expect(dataOf(res)).toMatchObject({ ok: true, provedor: "bitbucket", numero: 12, url: "https://bitbucket.org/ws/r/pull-requests/12", origem: "feature/x", destino: "develop" });
    expect(dataOf(res).avisos).toBeUndefined();
    expect(textOf(res)).toContain("PR #12 aberto");
    expect(env.fake.calls).toHaveLength(1);
    const { req, caller } = env.fake.calls[0]!;
    expect(caller).toBe("ai-git-tools");
    expect(req.url).toBe(`${BB}/pullrequests`);
    expect(req.headers?.Authorization).toBe("{{bearer:BB_TESTE}}");
    expect(req.body).toEqual({
      title: "Minha feature",
      description: "Descricao",
      source: { branch: { name: "feature/x" } },
      destination: { branch: { name: "develop" } },
      close_source_branch: false,
    });
    // the source branch was looked for in the remote, by its exact ref
    expect(env.lsRemote).toEqual([["ls-remote", "--heads", "origin", "refs/heads/feature/x"]]);
  });

  it("opens a PR on GitHub, as a draft when asked", async () => {
    const env = makeEnv({ remote: GH_REMOTE, handler: routed(on("POST", "/repos/o/r/pulls", reply(201, ghPr()))) });
    const res = await callTool(env.tools, "git_pr_criar", { repo: env.repo, origem: "feature/x", destino: "develop", titulo: "Feature X", rascunho: true });
    expect(dataOf(res)).toMatchObject({ ok: true, provedor: "github", numero: 12, url: "https://github.com/o/r/pull/12", rascunho: true });
    expect(env.fake.calls[0]!.req.body).toMatchObject({ title: "Feature X", head: "feature/x", base: "develop", draft: true });
  });

  it("warns, without blocking, when the destination leaves the gitflow hierarchy", async () => {
    const env = makeEnv({ remote: BB_REMOTE, handler: routed(on("POST", "/2.0/repositories/ws/r/pullrequests", reply(201, prBody({ destination: { branch: { name: "main" } } })))) });
    const res = await callTool(env.tools, "git_pr_criar", { repo: env.repo, origem: "feature/x", destino: "main", titulo: "Minha feature" });
    expect(res.isError).toBeUndefined();
    const avisos = dataOf(res).avisos as string[];
    expect(avisos).toHaveLength(1);
    expect(avisos[0]).toContain("gitflow");
    expect(avisos[0]).toContain("develop");
    expect(writes(env.fake)).toEqual(["POST /2.0/repositories/ws/r/pullrequests"]);
    expect(textOf(res)).toContain("gitflow");
  });

  it("refuses when the source branch is not on the remote and says to push it", async () => {
    const env = makeEnv({ remote: BB_REMOTE });
    await callTool(env.tools, "git_checkout", { repo: env.repo, branch: "feature/y", criar: true });
    const res = await callTool(env.tools, "git_pr_criar", { repo: env.repo, origem: "feature/y", destino: "develop", titulo: "t" });
    expect(res.isError).toBe(true);
    expect(dataOf(res).codigo).toBe("argumento_invalido");
    expect(textOf(res)).toContain("feature/y");
    expect(dataOf(res).dica).toContain("git_push");
    expect(dataOf(res).dica).toContain("definir_upstream");
    expect(env.fake.calls).toHaveLength(0);
  });

  it("goes on with a warning when the remote cannot be queried", async () => {
    const env = makeEnv({ remote: BB_REMOTE, lsRemoteFails: true, handler: routed(on("POST", "/2.0/repositories/ws/r/pullrequests", reply(201, prBody()))) });
    const res = await callTool(env.tools, "git_pr_criar", { repo: env.repo, origem: "feature/x", destino: "develop", titulo: "t" });
    expect(res.isError).toBeUndefined();
    expect((dataOf(res).avisos as string[])[0]).toContain("Não foi possível confirmar");
    expect(env.fake.calls).toHaveLength(1);
  });

  it("refuses an option-like branch, the same branch twice and an empty title", async () => {
    const env = makeEnv({ remote: BB_REMOTE });
    for (const args of [
      { origem: "--upload-pack=x", destino: "develop", titulo: "t" },
      { origem: "feature/x", destino: "feature/x", titulo: "t" },
      { origem: "feature/x", destino: "develop", titulo: "  " },
    ]) {
      const res = await callTool(env.tools, "git_pr_criar", { repo: env.repo, ...args });
      expect(dataOf(res).codigo).toBe("argumento_invalido");
    }
    expect(env.fake.calls).toHaveLength(0);
  });

  it("maps a provider refusal to its code and hides the secret value", async () => {
    const env = makeEnv({
      remote: BB_REMOTE,
      handler: routed(on("POST", "/2.0/repositories/ws/r/pullrequests", reply(422, { error: { message: `token ${FAKE_VALUE} rejeitado` } }))),
    });
    const res = await callTool(env.tools, "git_pr_criar", { repo: env.repo, origem: "feature/x", destino: "develop", titulo: "t" });
    expect(res.isError).toBe(true);
    expect(dataOf(res).codigo).toBe("provedor_http_422");
    expect(textOf(res)).not.toContain(FAKE_VALUE);
    expect(JSON.stringify(res)).not.toContain(FAKE_VALUE);
  });
});

describe("gitflowAvisos", () => {
  it.each([
    ["feature/a", "develop", 0],
    ["bugfix/a", "develop", 0],
    ["chore/a", "develop", 0],
    ["feature/a", "main", 1],
    ["bugfix/a", "release", 1],
    ["develop", "main", 0],
    ["develop", "feature/x", 1],
    ["hotfix/a", "main", 0],
    ["hotfix/a", "develop", 0],
    ["hotfix/a", "staging", 1],
    ["PROJ-12", "main", 0],
  ])("%s -> %s gives %i warning(s)", (origem, destino, n) => {
    expect(gitflowAvisos(origem, destino)).toHaveLength(n);
  });
});

describe("without a secret", () => {
  it("answers secret_nao_configurada with no network call, and the local tools keep working", async () => {
    const env = makeEnv({ remote: GH_REMOTE, secretGithub: "" });
    const res = await callTool(env.tools, "git_pr_listar", { repo: env.repo });
    expect(res.isError).toBe(true);
    expect(dataOf(res).codigo).toBe("secret_nao_configurada");
    expect(dataOf(res).dica).toBe("rode a skill configurar-ai-git-tools ou escolha a secret nas configurações do plugin");
    expect(textOf(res)).toContain("GitHub");
    expect(env.fake.calls).toHaveLength(0);
    expect(env.lsRemote).toHaveLength(0);

    const status = await callTool(env.tools, "git_status", { repo: env.repo });
    expect(status.isError).toBeUndefined();
    expect(dataOf(status).branch).toBe("main");
  });

  it("only the provider of the remote matters: a GitHub secret does not serve a Bitbucket remote", async () => {
    const env = makeEnv({ remote: BB_REMOTE, secretBitbucket: "", secretGithub: "GH_TESTE" });
    for (const [name, args] of [
      ["git_pr_listar", {}],
      ["git_pr_obter", { numero: 1 }],
      ["git_pr_comentar", { numero: 1, texto: "oi" }],
      ["git_pr_merge", { numero: 1, destino: "develop", titulo: "t", estrategia: "merge" }],
      ["git_pipeline_status", {}],
      ["git_pr_criar", { origem: "feature/x", destino: "develop", titulo: "t" }],
    ] as const) {
      const res = await callTool(env.tools, name, { repo: env.repo, ...args });
      expect(dataOf(res).codigo, name).toBe("secret_nao_configurada");
    }
    expect(env.fake.calls).toHaveLength(0);
  });

  it("a remote that is not GitHub or Bitbucket explains it, with no network call", async () => {
    const env = makeEnv({ remote: "bare" });
    const res = await callTool(env.tools, "git_pr_listar", { repo: env.repo });
    expect(res.isError).toBe(true);
    expect(dataOf(res).codigo).toBe("argumento_invalido");
    expect(textOf(res)).toContain("GitHub ou do Bitbucket");
    expect(env.fake.calls).toHaveLength(0);
  });

  it("reports a locked vault with its own code", async () => {
    const env = makeEnv({ remote: BB_REMOTE });
    env.fake.lock();
    const res = await callTool(env.tools, "git_pr_listar", { repo: env.repo });
    expect(dataOf(res).codigo).toBe("cofre_bloqueado");
  });
});

describe("secret type", () => {
  it("uses the basic placeholder when the Environment Keys says the secret is basic", async () => {
    const env = makeEnv({
      remote: BB_REMOTE,
      metadata: [secretInfo("BB_TESTE", "basic", { allowedHosts: ["api.bitbucket.org"] })],
      handler: routed(on("GET", "/2.0/repositories/ws/r/pullrequests", reply(200, { values: [] }))),
    });
    await callTool(env.tools, "git_pr_listar", { repo: env.repo });
    expect(env.fake.calls[0]!.req.headers?.Authorization).toBe("{{basic:BB_TESTE}}");
  });
});

describe("git_pr_listar", () => {
  it("lists the open PRs of Bitbucket with a default limit of 20", async () => {
    const env = makeEnv({ remote: BB_REMOTE, handler: routed(on("GET", "/2.0/repositories/ws/r/pullrequests", reply(200, { values: [prBody(), prBody({ id: 13, title: "Outra" })] }))) });
    const res = await callTool(env.tools, "git_pr_listar", { repo: env.repo });
    expect(res.isError).toBeUndefined();
    const data = dataOf(res);
    expect(data).toMatchObject({ ok: true, provedor: "bitbucket", estado: "aberto", total: 2, truncado: false });
    expect((data.prs as Array<{ numero: number }>).map((p) => p.numero)).toEqual([12, 13]);
    expect(textOf(res)).toContain("#13");
    const url = new URL(env.fake.calls[0]!.req.url);
    expect(url.searchParams.getAll("state")).toEqual(["OPEN"]);
    expect(url.searchParams.get("pagelen")).toBe("20");
  });

  it("passes the filters of state, origin and destination to GitHub", async () => {
    const env = makeEnv({
      remote: GH_REMOTE,
      handler: routed(on("GET", "/repos/o/r/pulls", reply(200, [ghPr(), ghPr({ number: 13 })]))),
    });
    const res = await callTool(env.tools, "git_pr_listar", { repo: env.repo, estado: "aberto", origem: "feature/x", destino: "develop", limite: 50 });
    expect(dataOf(res)).toMatchObject({ ok: true, provedor: "github", total: 2 });
    const url = new URL(env.fake.calls[0]!.req.url);
    expect(url.searchParams.get("state")).toBe("open");
    expect(url.searchParams.get("base")).toBe("develop");
    expect(url.searchParams.get("head")).toBe("o:feature/x");
    expect(url.searchParams.get("per_page")).toBe("50");
  });

  it("refuses a state or a limit out of range", async () => {
    const env = makeEnv({ remote: BB_REMOTE });
    expect(dataOf(await callTool(env.tools, "git_pr_listar", { repo: env.repo, estado: "abandonado" })).codigo).toBe("argumento_invalido");
    expect(dataOf(await callTool(env.tools, "git_pr_listar", { repo: env.repo, limite: 101 })).codigo).toBe("argumento_invalido");
    expect(dataOf(await callTool(env.tools, "git_pr_listar", { repo: env.repo, limite: 0 })).codigo).toBe("argumento_invalido");
    expect(dataOf(await callTool(env.tools, "git_pr_listar", { repo: env.repo, extra: 1 })).codigo).toBe("argumento_invalido");
    expect(env.fake.calls).toHaveLength(0);
  });
});

describe("git_pr_obter", () => {
  it("reads a Bitbucket PR with commits, diff and comments", async () => {
    const env = makeEnv({
      remote: BB_REMOTE,
      handler: routed(
        on("GET", "/2.0/repositories/ws/r/pullrequests/12", reply(200, prBody())),
        on("GET", "/2.0/repositories/ws/r/pullrequests/12/commits", reply(200, { values: [{ hash: "c1c1c1c1", message: "primeiro\n\ncorpo", date: "2026-10-01T10:00:00Z", author: { raw: "Ana <a@x>" } }] })),
        on("GET", "/2.0/repositories/ws/r/pullrequests/12/comments", reply(200, { values: [{ id: 1, content: { raw: "ok" }, user: { display_name: "Beto" }, created_on: "2026-10-02T10:00:00Z" }] })),
        on("GET", "/2.0/repositories/ws/r/pullrequests/12/diff", reply(200, "diff --git a/x b/x\n+linha\n")),
      ),
    });
    const res = await callTool(env.tools, "git_pr_obter", { repo: env.repo, numero: 12, incluir: ["commits", "diff", "comentarios"] });
    expect(res.isError).toBeUndefined();
    const data = dataOf(res);
    expect(data).toMatchObject({ numero: 12, estado: "aberto", destino: "develop", diff: "diff --git a/x b/x\n+linha\n", diff_truncado: false });
    expect((data.commits as Array<{ hash: string }>)[0]!.hash).toBe("c1c1c1c1");
    expect((data.comentarios as Array<{ texto: string }>)[0]!.texto).toBe("ok");
    expect(textOf(res)).toContain("diff --git a/x b/x");
    expect(textOf(res)).toContain("Beto: ok");
  });

  it("reads a GitHub PR with the commits", async () => {
    const env = makeEnv({
      remote: GH_REMOTE,
      handler: routed(
        on("GET", "/repos/o/r/pulls/12", reply(200, ghPr())),
        on("GET", "/repos/o/r/pulls/12/commits", reply(200, [{ sha: "b".repeat(40), commit: { message: "primeiro", author: { name: "Ana", date: "2026-10-01T10:00:00Z" } } }])),
      ),
    });
    const res = await callTool(env.tools, "git_pr_obter", { repo: env.repo, numero: 12, incluir: ["commits"] });
    const data = dataOf(res);
    expect(data).toMatchObject({ ok: true, provedor: "github", numero: 12, titulo: "Feature X", head_sha: GH_SHA });
    expect((data.commits as unknown[]).length).toBe(1);
    expect(data.diff).toBeUndefined();
  });

  it("refuses an unknown item of incluir and a PR number below 1", async () => {
    const env = makeEnv({ remote: BB_REMOTE });
    expect(dataOf(await callTool(env.tools, "git_pr_obter", { repo: env.repo, numero: 1, incluir: ["tudo"] })).codigo).toBe("argumento_invalido");
    expect(dataOf(await callTool(env.tools, "git_pr_obter", { repo: env.repo, numero: 0 })).codigo).toBe("argumento_invalido");
    expect(env.fake.calls).toHaveLength(0);
  });

  it("maps a 404 to provedor_http_404", async () => {
    const env = makeEnv({ remote: BB_REMOTE, handler: routed(on("GET", "/2.0/repositories/ws/r/pullrequests/99", reply(404, { error: { message: "No such pull request" } }))) });
    const res = await callTool(env.tools, "git_pr_obter", { repo: env.repo, numero: 99 });
    expect(res.isError).toBe(true);
    expect(dataOf(res).codigo).toBe("provedor_http_404");
  });
});

describe("git_pr_comentar", () => {
  it("comments on Bitbucket", async () => {
    const env = makeEnv({
      remote: BB_REMOTE,
      handler: routed(on("POST", "/2.0/repositories/ws/r/pullrequests/12/comments", reply(201, { id: 77, content: { raw: "ok" }, user: { display_name: "Ana" }, created_on: "2026-10-03T10:00:00Z", links: { html: { href: "https://bitbucket.org/c" } } }))),
    });
    const res = await callTool(env.tools, "git_pr_comentar", { repo: env.repo, numero: 12, texto: "ok" });
    expect(res.isError).toBeUndefined();
    expect(dataOf(res)).toMatchObject({ ok: true, numero: 12, comentario: { id: "77", autor: "Ana", url: "https://bitbucket.org/c" } });
    expect(env.fake.calls[0]!.req.body).toEqual({ content: { raw: "ok" } });
  });

  it("comments on GitHub (issues endpoint)", async () => {
    const env = makeEnv({
      remote: GH_REMOTE,
      handler: routed(on("POST", "/repos/o/r/issues/12/comments", reply(201, { id: 5, body: "ok", user: { login: "ana" }, created_at: "2026-10-03T10:00:00Z", html_url: "https://github.com/o/r/pull/12#c5" }))),
    });
    const res = await callTool(env.tools, "git_pr_comentar", { repo: env.repo, numero: 12, texto: "ok" });
    expect(dataOf(res)).toMatchObject({ ok: true, comentario: { id: "5", autor: "ana" } });
    expect(env.fake.calls[0]!.req.body).toEqual({ body: "ok" });
  });

  it("refuses an empty text", async () => {
    const env = makeEnv({ remote: BB_REMOTE });
    expect(dataOf(await callTool(env.tools, "git_pr_comentar", { repo: env.repo, numero: 12, texto: "  " })).codigo).toBe("argumento_invalido");
    expect(env.fake.calls).toHaveLength(0);
  });
});

describe("git_pr_merge", () => {
  const MERGE_ARGS = { numero: 12, destino: "develop", titulo: "Minha feature", estrategia: "merge" } as const;

  it("merges on Bitbucket after checking the PR, keeping the source branch", async () => {
    const env = makeEnv({
      remote: BB_REMOTE,
      handler: routed(
        on("GET", "/2.0/repositories/ws/r/pullrequests/12", reply(200, prBody())),
        on("POST", "/2.0/repositories/ws/r/pullrequests/12/merge", reply(200, prBody({ state: "MERGED", merge_commit: { hash: "mmm9999999" } }))),
      ),
    });
    const res = await callTool(env.tools, "git_pr_merge", { repo: env.repo, ...MERGE_ARGS, mensagem: "corpo" });
    expect(res.isError).toBeUndefined();
    expect(dataOf(res)).toMatchObject({ ok: true, numero: 12, mesclado: true, commit: "mmm9999999", destino: "develop", url: "https://bitbucket.org/ws/r/pull-requests/12" });
    expect(requests(env.fake)).toEqual(["GET /2.0/repositories/ws/r/pullrequests/12", "POST /2.0/repositories/ws/r/pullrequests/12/merge"]);
    expect(env.fake.calls[1]!.req.body).toEqual({ type: "pullrequest", merge_strategy: "merge_commit", close_source_branch: false, message: "corpo" });
  });

  it("merges on GitHub pinning the head read from the PR", async () => {
    const env = makeEnv({
      remote: GH_REMOTE,
      handler: routed(on("GET", "/repos/o/r/pulls/12", reply(200, ghPr())), on("PUT", "/repos/o/r/pulls/12/merge", reply(200, { merged: true, sha: "m".repeat(40) }))),
    });
    const res = await callTool(env.tools, "git_pr_merge", { repo: env.repo, numero: 12, destino: "develop", titulo: "Feature X", estrategia: "squash" });
    expect(dataOf(res)).toMatchObject({ ok: true, mesclado: true, commit: "m".repeat(40), destino: "develop" });
    expect(requests(env.fake)).toEqual(["GET /repos/o/r/pulls/12", "PUT /repos/o/r/pulls/12/merge"]);
    expect(env.fake.calls[1]!.req.body).toEqual({ merge_method: "squash", commit_title: "Feature X", sha: GH_SHA });
  });

  it("compares destino and titulo after trim", async () => {
    const env = makeEnv({
      remote: BB_REMOTE,
      handler: routed(
        on("GET", "/2.0/repositories/ws/r/pullrequests/12", reply(200, prBody())),
        on("POST", "/2.0/repositories/ws/r/pullrequests/12/merge", reply(200, prBody({ state: "MERGED" }))),
      ),
    });
    const res = await callTool(env.tools, "git_pr_merge", { repo: env.repo, numero: 12, destino: "  develop ", titulo: " Minha feature  ", estrategia: "squash" });
    expect(dataOf(res).ok).toBe(true);
  });

  it("refuses a divergent destination with aprovacao_divergente and merges nothing", async () => {
    const env = makeEnv({
      remote: BB_REMOTE,
      handler: routed(on("GET", "/2.0/repositories/ws/r/pullrequests/12", reply(200, prBody())), on("POST", "/2.0/repositories/ws/r/pullrequests/12/merge", reply(200, prBody({ state: "MERGED" })))),
    });
    const res = await callTool(env.tools, "git_pr_merge", { repo: env.repo, ...MERGE_ARGS, destino: "main" });
    expect(res.isError).toBe(true);
    const data = dataOf(res);
    expect(data).toMatchObject({ ok: false, codigo: "aprovacao_divergente", destino_informado: "main", destino_real: "develop" });
    expect(textOf(res)).toContain('o destino real é "develop" (informado "main")');
    expect(textOf(res)).toContain("Nada foi mesclado");
    expect(writes(env.fake)).toEqual([]);
    expect(requests(env.fake)).toEqual(["GET /2.0/repositories/ws/r/pullrequests/12"]);
  });

  it("refuses a divergent title and reports both divergences at once", async () => {
    const env = makeEnv({
      remote: GH_REMOTE,
      handler: routed(on("GET", "/repos/o/r/pulls/12", reply(200, ghPr())), on("PUT", "/repos/o/r/pulls/12/merge", reply(200, { merged: true }))),
    });
    const titulo = await callTool(env.tools, "git_pr_merge", { repo: env.repo, numero: 12, destino: "develop", titulo: "Outro título", estrategia: "merge" });
    expect(dataOf(titulo)).toMatchObject({ codigo: "aprovacao_divergente", titulo_informado: "Outro título", titulo_real: "Feature X" });
    expect(textOf(titulo)).toContain('o título real é "Feature X"');
    expect(textOf(titulo)).not.toContain("o destino real");

    const ambos = await callTool(env.tools, "git_pr_merge", { repo: env.repo, numero: 12, destino: "main", titulo: "Outro título", estrategia: "merge" });
    expect(textOf(ambos)).toContain("o destino real");
    expect(textOf(ambos)).toContain("o título real");
    expect(writes(env.fake)).toEqual([]);
  });

  it("refuses a PR that is not open", async () => {
    const env = makeEnv({
      remote: BB_REMOTE,
      handler: routed(on("GET", "/2.0/repositories/ws/r/pullrequests/12", reply(200, prBody({ state: "MERGED" }))), on("POST", "/2.0/repositories/ws/r/pullrequests/12/merge", reply(200, {}))),
    });
    const merged = await callTool(env.tools, "git_pr_merge", { repo: env.repo, ...MERGE_ARGS });
    expect(merged.isError).toBe(true);
    expect(dataOf(merged).codigo).toBe("argumento_invalido");
    expect(textOf(merged)).toContain("mesclado");
    expect(writes(env.fake)).toEqual([]);

    const declined = makeEnv({
      remote: BB_REMOTE,
      handler: routed(on("GET", "/2.0/repositories/ws/r/pullrequests/12", reply(200, prBody({ state: "DECLINED" })))),
    });
    const res = await callTool(declined.tools, "git_pr_merge", { repo: declined.repo, ...MERGE_ARGS });
    expect(dataOf(res).codigo).toBe("argumento_invalido");
    expect(textOf(res)).toContain("fechado");
  });

  it("waits for the asynchronous merge of Bitbucket (202, then SUCCESS) and returns merged", async () => {
    const task = `${BB}/pullrequests/12/merge/task-status/abc`;
    let polls = 0;
    const clock = fakeClock();
    const env = makeEnv({
      remote: BB_REMOTE,
      providerFactories: { bitbucket: (ctx) => createBitbucketProviderWith(ctx, clock.options) },
      handler: routed(
        on("GET", "/2.0/repositories/ws/r/pullrequests/12", reply(200, prBody())),
        on("POST", "/2.0/repositories/ws/r/pullrequests/12/merge", reply(202, "", { Location: task })),
        (c) => {
          if (c.url.pathname !== "/2.0/repositories/ws/r/pullrequests/12/merge/task-status/abc") return undefined;
          polls += 1;
          return polls < 3 ? reply(200, { task_status: "PENDING" }) : reply(200, { task_status: "SUCCESS", merge_result: prBody({ state: "MERGED", merge_commit: { hash: "mmm9999999" } }) });
        },
      ),
    });
    const res = await callTool(env.tools, "git_pr_merge", { repo: env.repo, ...MERGE_ARGS, estrategia: "squash" });
    expect(res.isError).toBeUndefined();
    expect(dataOf(res)).toMatchObject({ ok: true, mesclado: true, commit: "mmm9999999", destino: "develop" });
    expect(env.fake.calls.map((c) => c.req.method)).toEqual(["GET", "POST", "GET", "GET", "GET"]);
    expect(env.fake.calls[1]!.req.body).toMatchObject({ merge_strategy: "squash", close_source_branch: false });
    expect(clock.time()).toBe(2000);
  });

  it("says merge_em_andamento when the asynchronous merge does not finish in time", async () => {
    const task = `${BB}/pullrequests/12/merge/task-status/abc`;
    const clock = fakeClock();
    const env = makeEnv({
      remote: BB_REMOTE,
      providerFactories: { bitbucket: (ctx) => createBitbucketProviderWith(ctx, clock.options) },
      handler: routed(
        on("GET", "/2.0/repositories/ws/r/pullrequests/12", reply(200, prBody())),
        on("POST", "/2.0/repositories/ws/r/pullrequests/12/merge", reply(202, "", { Location: task })),
        on("GET", "/2.0/repositories/ws/r/pullrequests/12/merge/task-status/abc", reply(200, { task_status: "PENDING" })),
      ),
    });
    const res = await callTool(env.tools, "git_pr_merge", { repo: env.repo, ...MERGE_ARGS });
    expect(res.isError).toBe(true);
    expect(dataOf(res).codigo).toBe("merge_em_andamento");
    expect(textOf(res)).toContain("segue em andamento");
    expect(dataOf(res).dica).toContain("git_pr_obter");
  });

  it("GitHub has no fast-forward: refuses before any merge call", async () => {
    const env = makeEnv({ remote: GH_REMOTE, handler: routed(on("GET", "/repos/o/r/pulls/12", reply(200, ghPr())), on("PUT", "/repos/o/r/pulls/12/merge", reply(200, { merged: true }))) });
    const res = await callTool(env.tools, "git_pr_merge", { repo: env.repo, numero: 12, destino: "develop", titulo: "Feature X", estrategia: "fast_forward" });
    expect(dataOf(res).codigo).toBe("argumento_invalido");
    expect(writes(env.fake)).toEqual([]);
  });

  it("maps a conflict of the provider (409) and keeps the failure honest", async () => {
    const env = makeEnv({
      remote: BB_REMOTE,
      handler: routed(on("GET", "/2.0/repositories/ws/r/pullrequests/12", reply(200, prBody())), on("POST", "/2.0/repositories/ws/r/pullrequests/12/merge", reply(409, { error: { message: "conflito" } }))),
    });
    const res = await callTool(env.tools, "git_pr_merge", { repo: env.repo, ...MERGE_ARGS });
    expect(res.isError).toBe(true);
    expect(dataOf(res).codigo).toBe("provedor_http_409");
  });

  it("requires every argument of the approval (numero, destino, titulo, estrategia)", async () => {
    const env = makeEnv({ remote: BB_REMOTE });
    for (const omit of ["numero", "destino", "titulo", "estrategia"]) {
      const args: Record<string, unknown> = { repo: env.repo, ...MERGE_ARGS };
      delete args[omit];
      const res = await callTool(env.tools, "git_pr_merge", args);
      expect(dataOf(res).codigo, omit).toBe("argumento_invalido");
    }
    expect(dataOf(await callTool(env.tools, "git_pr_merge", { repo: env.repo, ...MERGE_ARGS, estrategia: "rebase" })).codigo).toBe("argumento_invalido");
    expect(env.fake.calls).toHaveLength(0);
  });
});

describe("git_pipeline_status", () => {
  const pipeline = (uuid: string, over: Record<string, unknown> = {}) => ({
    uuid,
    build_number: 41,
    state: { name: "COMPLETED", result: { name: "SUCCESSFUL" } },
    target: { ref_name: "main", commit: { hash: "abc123abc123" } },
    created_on: "2026-10-05T10:00:00Z",
    ...over,
  });

  it("without a filter uses the current branch (Bitbucket)", async () => {
    const env = makeEnv({
      remote: BB_REMOTE,
      handler: routed(
        on("GET", "/2.0/repositories/ws/r/pipelines/", reply(200, { values: [pipeline("{u1}")] })),
        (c) => (c.url.pathname.endsWith("/steps/") ? reply(200, { values: [{ name: "Build", state: { name: "COMPLETED", result: { name: "SUCCESSFUL" } } }] }) : undefined),
      ),
    });
    const res = await callTool(env.tools, "git_pipeline_status", { repo: env.repo });
    expect(res.isError).toBeUndefined();
    const data = dataOf(res);
    expect(data).toMatchObject({ ok: true, provedor: "bitbucket", branch: "main", total: 1 });
    expect((data.pipelines as Array<Record<string, unknown>>)[0]).toMatchObject({ estado: "sucesso", branch: "main", url: "https://bitbucket.org/ws/r/pipelines/results/41", steps: [{ nome: "Build", estado: "sucesso" }] });
    expect(textOf(res)).toContain("sucesso main abc123a");
    expect(new URL(env.fake.calls[0]!.req.url).searchParams.get("q")).toBe('target.ref_name="main"');
  });

  it("reads GitHub Actions runs of a branch with the jobs as steps", async () => {
    const env = makeEnv({
      remote: GH_REMOTE,
      handler: routed(
        on("GET", "/repos/o/r/actions/runs", reply(200, { workflow_runs: [{ id: 501, status: "in_progress", conclusion: null, head_branch: "feature/x", head_sha: "d".repeat(40), html_url: "https://github.com/o/r/actions/runs/501", created_at: "2026-10-04T12:00:00Z" }] })),
        on("GET", "/repos/o/r/actions/runs/501/jobs", reply(200, { jobs: [{ name: "build", status: "completed", conclusion: "success" }, { name: "test", status: "in_progress", conclusion: null }] })),
      ),
    });
    const res = await callTool(env.tools, "git_pipeline_status", { repo: env.repo, branch: "feature/x", limite: 3 });
    const data = dataOf(res);
    expect(data).toMatchObject({ ok: true, provedor: "github", branch: "feature/x", total: 1 });
    expect((data.pipelines as Array<Record<string, unknown>>)[0]).toMatchObject({ id: "501", estado: "executando", steps: [{ nome: "build", estado: "sucesso" }, { nome: "test", estado: "executando" }] });
    const url = new URL(env.fake.calls[0]!.req.url);
    expect(url.searchParams.get("branch")).toBe("feature/x");
    expect(url.searchParams.get("per_page")).toBe("3");
  });

  it("with a PR number does not add the current branch to the filter", async () => {
    const env = makeEnv({
      remote: BB_REMOTE,
      handler: routed(
        on("GET", "/2.0/repositories/ws/r/pullrequests/12", reply(200, prBody())),
        on("GET", "/2.0/repositories/ws/r/pipelines/", reply(200, { values: [pipeline("{u1}", { target: { ref_name: "feature/x", commit: { hash: "abc123abc123" } } })] })),
        (c) => (c.url.pathname.endsWith("/steps/") ? reply(200, { values: [] }) : undefined),
      ),
    });
    const res = await callTool(env.tools, "git_pipeline_status", { repo: env.repo, numero_pr: 12 });
    expect(dataOf(res)).toMatchObject({ ok: true, total: 1 });
    expect(dataOf(res).branch).toBeUndefined();
    const list = env.fake.calls.find((c) => new URL(c.req.url).pathname === "/2.0/repositories/ws/r/pipelines/")!;
    expect(new URL(list.req.url).searchParams.get("q")).toBe('target.ref_name="feature/x"');
  });

  it("refuses a limit above 20 and a detached HEAD without any filter", async () => {
    const env = makeEnv({ remote: BB_REMOTE });
    expect(dataOf(await callTool(env.tools, "git_pipeline_status", { repo: env.repo, limite: 21 })).codigo).toBe("argumento_invalido");
    sh(env.repo, "checkout", "--detach");
    const res = await callTool(env.tools, "git_pipeline_status", { repo: env.repo });
    expect(dataOf(res).codigo).toBe("argumento_invalido");
    expect(textOf(res)).toContain("HEAD solto");
    expect(env.fake.calls).toHaveLength(0);
  });
});

describe("operations outside the list", () => {
  it("a 404 or 405 on Bitbucket carries the hint of search_vault_tools", async () => {
    const env = makeEnv({
      remote: BB_REMOTE,
      handler: routed(on("POST", "/2.0/repositories/ws/r/pullrequests/12/comments", reply(405, { error: { message: "Method not allowed" } }))),
    });
    const res = await callTool(env.tools, "git_pr_comentar", { repo: env.repo, numero: 12, texto: "oi" });
    expect(res.isError).toBe(true);
    expect(dataOf(res).codigo).toBe("provedor_http_405");
    expect(dica(res)).toMatchObject({ mcp: "Bitbucket", usar: "search_vault_tools + run_vault_tool" });
  });

  it("a 404 on Bitbucket keeps the token hint next to the fallback hint", async () => {
    const env = makeEnv({ remote: BB_REMOTE, handler: routed(on("GET", "/2.0/repositories/ws/r/pullrequests/99", reply(404, {}))) });
    const res = await callTool(env.tools, "git_pr_obter", { repo: env.repo, numero: 99 });
    expect(dica(res)).toMatchObject({ mcp: "Bitbucket", usar: "search_vault_tools + run_vault_tool" });
    expect(String(dica(res).conferir)).toContain("token");
  });

  it("a 404 on GitHub points to http_request with the bearer placeholder of the secret", async () => {
    const env = makeEnv({ remote: GH_REMOTE, handler: routed(on("POST", "/repos/o/r/issues/12/comments", reply(404, { message: "Not Found" }))) });
    const res = await callTool(env.tools, "git_pr_comentar", { repo: env.repo, numero: 12, texto: "oi" });
    expect(dica(res)).toMatchObject({ usar: "http_request", cabecalho: "Authorization: {{bearer:GH_TESTE}}", host: "api.github.com" });
  });

  it("other statuses do not get the fallback hint", async () => {
    const env = makeEnv({ remote: BB_REMOTE, handler: routed(on("GET", "/2.0/repositories/ws/r/pullrequests/12", reply(401, {}))) });
    const res = await callTool(env.tools, "git_pr_obter", { repo: env.repo, numero: 12 });
    expect(dataOf(res).codigo).toBe("provedor_http_401");
    expect(typeof dataOf(res).dica).toBe("string");
  });
});

describe("repository resolution", () => {
  it("refuses a repository outside the allowed folders before any call", async () => {
    const env = makeEnv({ remote: BB_REMOTE });
    const outside = makeRepo(makeTempDir(), "fora");
    const res = await callTool(env.tools, "git_pr_listar", { repo: outside });
    expect(dataOf(res).codigo).toBe("repo_nao_permitido");
    expect(env.fake.calls).toHaveLength(0);
  });
});
