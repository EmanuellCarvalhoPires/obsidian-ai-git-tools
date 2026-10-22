import { describe, expect, it } from "vitest";
import { RemoteError } from "../../src/core/providers/errors";
import { createGithubProvider, mapRunState, truncateBytes } from "../../src/core/providers/github";
import { createSecureHttp } from "../../src/core/providers/http";
import type { GitProvider, ProviderContext, RemoteRef } from "../../src/core/providers/provider";
import type { SecretResponse } from "../../src/ecosystem/types";
import { FAKE_VALUE, makeFakeSecrets, reply, secretInfo } from "../helpers/fake-secrets";
import type { FakeHandler, FakeSecrets, RecordedCall } from "../helpers/fake-secrets";

const REF: RemoteRef = { provider: "github", owner: "o", slug: "r", repo: "o/r" };
const API = "https://api.github.com/repos/o/r";
const AUTH = "{{bearer:GH_TESTE}}";

interface Setup {
  provider: GitProvider;
  fake: FakeSecrets;
}

type Call = { url: URL; method: string; body: unknown; headers: Record<string, string> };
/** Answers a call, or undefined when this route does not apply. */
type Route = (call: Call) => SecretResponse | undefined;

/** Turns a route into a handler of the fake: anything no route answers is a 599, so a surprise fails the test. */
function toHandler(route: Route): FakeHandler {
  return (req) => route({ url: new URL(req.url), method: req.method, body: req.body, headers: req.headers ?? {} }) ?? reply(599, { message: `unexpected ${req.method} ${req.url}` });
}

function setup(route: Route, ctx: Partial<ProviderContext> = {}): Setup {
  const fake = makeFakeSecrets({ handler: toHandler(route) });
  const provider = createGithubProvider({
    http: createSecureHttp(fake.getSecrets),
    ref: REF,
    secretName: "GH_TESTE",
    redact: (t) => fake.service.redact(t),
    ...ctx,
  });
  return { provider, fake };
}

/** The first route that answers wins. */
function router(...routes: Route[]): Route {
  return (call) => {
    for (const route of routes) {
      const out = route(call);
      if (out) return out;
    }
    return undefined;
  };
}

const on =
  (method: string, path: string, answer: SecretResponse | ((c: Call) => SecretResponse)): Route =>
  (c) =>
    c.method === method && c.url.pathname === path ? (typeof answer === "function" ? answer(c) : answer) : undefined;

/** Headers of a recorded request (optional in the type of the secrets service). */
const hdrs = (req: { headers?: Record<string, string> }): Record<string, string> => req.headers ?? {};

const last = (fake: FakeSecrets): RecordedCall => fake.calls[fake.calls.length - 1] as RecordedCall;

function rawPr(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    number: 12,
    title: "Feature X",
    state: "open",
    merged_at: null,
    html_url: "https://github.com/o/r/pull/12",
    user: { login: "ana" },
    created_at: "2026-10-01T10:00:00Z",
    body: "Descricao",
    head: { ref: "feature/x", sha: "a".repeat(40) },
    base: { ref: "develop" },
    ...over,
  };
}

/** GitHub pages of 2 PRs (`pages` of them), linked by `Link rel="next"`. */
function prPages(pages: number): Route {
  return (c) => {
    if (c.method !== "GET" || c.url.pathname !== "/repos/o/r/pulls") return undefined;
    const page = Number(c.url.searchParams.get("page") ?? "1");
    const items = [rawPr({ number: page * 10 }), rawPr({ number: page * 10 + 1 })];
    const link: Record<string, string> = page < pages ? { link: `<${API}/pulls?page=${page + 1}>; rel="next", <${API}/pulls?page=${pages}>; rel="last"` } : {};
    return reply(200, items, link);
  };
}

describe("headers and secret", () => {
  it("sends the bearer placeholder, Accept and the API version, never a value", async () => {
    const { provider, fake } = setup(on("GET", "/repos/o/r/pulls/12", reply(200, rawPr())));
    await provider.obterPr({ numero: 12 });
    const { req, caller } = last(fake);
    expect(caller).toBe("ai-git-tools");
    expect(hdrs(req).Authorization).toBe(AUTH);
    expect(hdrs(req).Accept).toBe("application/vnd.github+json");
    expect(hdrs(req)["X-GitHub-Api-Version"]).toBe("2022-11-28");
    expect(hdrs(req)["User-Agent"]).toBe("obsidian-ai-git-tools");
    expect(JSON.stringify(fake.calls)).not.toContain(FAKE_VALUE);
  });

  it("uses the basic placeholder for a secret of the basic type", async () => {
    const { provider, fake } = setup(on("GET", "/repos/o/r/pulls/12", reply(200, rawPr())), { secretInfo: secretInfo("GH_TESTE", "basic") });
    await provider.obterPr({ numero: 12 });
    expect(hdrs(last(fake).req).Authorization).toBe("{{basic:GH_TESTE}}");
  });

  it("answers secret_nao_configurada without calling the network, on every operation", async () => {
    const { provider, fake } = setup(() => reply(200, {}), { secretName: "" });
    const calls = [
      () => provider.criarPr({ origem: "a", destino: "b", titulo: "t" }),
      () => provider.listarPrs({ estado: "aberto" }),
      () => provider.obterPr({ numero: 1 }),
      () => provider.comentarPr({ numero: 1, texto: "x" }),
      () => provider.listarComentarios({ numero: 1 }),
      () => provider.mesclarPr({ numero: 1, estrategia: "merge" }),
      () => provider.statusPipelines({}),
    ];
    for (const call of calls) {
      await expect(call()).rejects.toMatchObject({ name: "RemoteError", codigo: "secret_nao_configurada" });
    }
    expect(fake.calls).toHaveLength(0);
  });

  it("encodes owner and slug in the URL", async () => {
    const { provider, fake } = setup(() => reply(200, rawPr()), {
      ref: { provider: "github", owner: "o w", slug: "r/x", repo: "o w/r/x" },
    });
    await provider.obterPr({ numero: 3 });
    expect(last(fake).req.url).toBe("https://api.github.com/repos/o%20w/r%2Fx/pulls/3");
  });

  it("rejects a PR number that is not a positive integer", async () => {
    const { provider, fake } = setup(() => reply(200, rawPr()));
    await expect(provider.obterPr({ numero: 0 })).rejects.toMatchObject({ codigo: "argumento_invalido" });
    await expect(provider.comentarPr({ numero: 1.5, texto: "x" })).rejects.toMatchObject({ codigo: "argumento_invalido" });
    expect(fake.calls).toHaveLength(0);
  });
});

describe("criarPr", () => {
  it("POSTs title, head, base, body and draft and normalizes the PR", async () => {
    const { provider, fake } = setup(on("POST", "/repos/o/r/pulls", reply(201, rawPr())));
    const pr = await provider.criarPr({ origem: "feature/x", destino: "develop", titulo: "Feature X", descricao: "Descricao", rascunho: true });
    const { req } = last(fake);
    expect(req.method).toBe("POST");
    expect(req.url).toBe(`${API}/pulls`);
    expect(req.body).toEqual({ title: "Feature X", head: "feature/x", base: "develop", body: "Descricao", draft: true });
    expect(pr).toEqual({
      numero: 12,
      titulo: "Feature X",
      estado: "aberto",
      origem: "feature/x",
      destino: "develop",
      url: "https://github.com/o/r/pull/12",
      autor: "ana",
      criadoEm: "2026-10-01T10:00:00Z",
      descricao: "Descricao",
      headSha: "a".repeat(40),
    });
  });

  it("leaves out the optional fields that were not given", async () => {
    const { provider, fake } = setup(on("POST", "/repos/o/r/pulls", reply(201, rawPr({ body: null }))));
    const pr = await provider.criarPr({ origem: "a", destino: "b", titulo: "t" });
    expect(last(fake).req.body).toEqual({ title: "t", head: "a", base: "b" });
    expect(pr.descricao).toBeUndefined();
  });

  it("maps a 422 (PR already exists) to provedor_http_422 with the provider message", async () => {
    const { provider } = setup(on("POST", "/repos/o/r/pulls", reply(422, { message: "Validation Failed", errors: [{ message: "A pull request already exists for o:feature/x." }] })));
    const err = await provider.criarPr({ origem: "feature/x", destino: "develop", titulo: "t" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RemoteError);
    expect((err as RemoteError).codigo).toBe("provedor_http_422");
    expect((err as RemoteError).mensagem).toContain("already exists");
  });
});

describe("listarPrs", () => {
  it("builds the query (state, head with owner, base, per_page) and maps the states", async () => {
    const items = [rawPr({ number: 1 }), rawPr({ number: 2, state: "closed" }), rawPr({ number: 3, state: "closed", merged_at: "2026-10-02T00:00:00Z" })];
    const { provider, fake } = setup(on("GET", "/repos/o/r/pulls", reply(200, items)));
    const out = await provider.listarPrs({ estado: "todos", origem: "feature/x", destino: "develop", limite: 10 });
    const url = new URL(last(fake).req.url);
    expect(url.searchParams.get("state")).toBe("all");
    expect(url.searchParams.get("head")).toBe("o:feature/x");
    expect(url.searchParams.get("base")).toBe("develop");
    expect(url.searchParams.get("per_page")).toBe("10");
    expect(out.itens.map((p) => [p.numero, p.estado])).toEqual([
      [1, "aberto"],
      [2, "fechado"],
      [3, "mesclado"],
    ]);
    expect(out.truncado).toBe(false);
  });

  it("asks for open PRs with state=open and caps per_page at 100", async () => {
    const { provider, fake } = setup(on("GET", "/repos/o/r/pulls", reply(200, [])));
    await provider.listarPrs({ estado: "aberto", limite: 500 });
    const url = new URL(last(fake).req.url);
    expect(url.searchParams.get("state")).toBe("open");
    expect(url.searchParams.has("head")).toBe(false);
    expect(url.searchParams.get("per_page")).toBe("100");
  });

  it("estado mesclado asks for closed and keeps only the PRs with merged_at", async () => {
    const items = [rawPr({ number: 1, state: "closed" }), rawPr({ number: 2, state: "closed", merged_at: "2026-10-02T00:00:00Z" })];
    const { provider, fake } = setup(on("GET", "/repos/o/r/pulls", reply(200, items)));
    const out = await provider.listarPrs({ estado: "mesclado" });
    expect(new URL(last(fake).req.url).searchParams.get("state")).toBe("closed");
    expect(out.itens.map((p) => p.numero)).toEqual([2]);
  });

  it("estado fechado keeps only the closed PRs without merged_at", async () => {
    const items = [rawPr({ number: 1, state: "closed" }), rawPr({ number: 2, state: "closed", merged_at: "2026-10-02T00:00:00Z" })];
    const { provider } = setup(on("GET", "/repos/o/r/pulls", reply(200, items)));
    const out = await provider.listarPrs({ estado: "fechado" });
    expect(out.itens.map((p) => [p.numero, p.estado])).toEqual([[1, "fechado"]]);
  });

  it("applies the limit after the merged filter", async () => {
    const items = [1, 2, 3, 4].map((n) => rawPr({ number: n, state: "closed", merged_at: n % 2 === 0 ? "2026-10-02T00:00:00Z" : null }));
    const { provider } = setup(on("GET", "/repos/o/r/pulls", reply(200, items)));
    const out = await provider.listarPrs({ estado: "mesclado", limite: 1 });
    expect(out.itens.map((p) => p.numero)).toEqual([2]);
    expect(out.truncado).toBe(true);
  });

  it("follows the Link header across pages with the same headers", async () => {
    const { provider, fake } = setup(router(prPages(3)));
    const out = await provider.listarPrs({ estado: "aberto", limite: 100 });
    expect(out.itens.map((p) => p.numero)).toEqual([10, 11, 20, 21, 30, 31]);
    expect(out.truncado).toBe(false);
    expect(fake.calls).toHaveLength(3);
    for (const c of fake.calls) expect(hdrs(c.req).Authorization).toBe(AUTH);
  });

  it("reads at most 5 pages and reports truncado", async () => {
    const { provider, fake } = setup(router(prPages(9)));
    const out = await provider.listarPrs({ estado: "aberto", limite: 100 });
    expect(fake.calls).toHaveLength(5);
    expect(out.itens).toHaveLength(10);
    expect(out.truncado).toBe(true);
  });

  it("stops at the limit and reports truncado when there was more", async () => {
    const { provider, fake } = setup(router(prPages(4)));
    const out = await provider.listarPrs({ estado: "aberto", limite: 3 });
    expect(out.itens).toHaveLength(3);
    expect(out.truncado).toBe(true);
    expect(fake.calls).toHaveLength(2);
  });

  it("maps a 404 to provedor_http_404", async () => {
    const { provider } = setup(on("GET", "/repos/o/r/pulls", reply(404, { message: "Not Found" })));
    await expect(provider.listarPrs({ estado: "aberto" })).rejects.toMatchObject({ codigo: "provedor_http_404" });
  });
});

describe("obterPr", () => {
  it("reads the PR and returns the head sha, without extras by default", async () => {
    const { provider, fake } = setup(on("GET", "/repos/o/r/pulls/12", reply(200, rawPr({ state: "closed", merged_at: "2026-10-03T00:00:00Z" }))));
    const pr = await provider.obterPr({ numero: 12 });
    expect(pr.estado).toBe("mesclado");
    expect(pr.headSha).toBe("a".repeat(40));
    expect(pr.commits).toBeUndefined();
    expect(pr.diff).toBeUndefined();
    expect(pr.comentarios).toBeUndefined();
    expect(fake.calls).toHaveLength(1);
  });

  it("includes commits, diff and comments with the right endpoints", async () => {
    const commits = [{ sha: "c1", commit: { message: "feat: x", author: { name: "Ana", date: "2026-10-01T09:00:00Z" } }, author: { login: "ana" } }];
    const comments = [{ id: 7, user: { login: "bia" }, body: "ok", created_at: "2026-10-01T11:00:00Z", html_url: "https://github.com/o/r/pull/12#c7" }];
    const { provider, fake } = setup(
      router(
        on("GET", "/repos/o/r/pulls/12/commits", reply(200, commits)),
        on("GET", "/repos/o/r/issues/12/comments", reply(200, comments)),
        (c) => (c.url.pathname === "/repos/o/r/pulls/12" && c.headers.Accept === "application/vnd.github.v3.diff" ? reply(200, "diff --git a/x b/x\n+linha") : undefined),
        on("GET", "/repos/o/r/pulls/12", reply(200, rawPr())),
      ),
    );
    const pr = await provider.obterPr({ numero: 12, incluir: ["commits", "diff", "comentarios"] });
    expect(pr.commits).toEqual([{ hash: "c1", mensagem: "feat: x", autor: "Ana", data: "2026-10-01T09:00:00Z" }]);
    expect(pr.diff).toBe("diff --git a/x b/x\n+linha");
    expect(pr.diffTruncado).toBe(false);
    expect(pr.comentarios).toEqual([{ id: "7", autor: "bia", texto: "ok", criadoEm: "2026-10-01T11:00:00Z", url: "https://github.com/o/r/pull/12#c7" }]);
    const diffCall = fake.calls.find((c) => hdrs(c.req).Accept === "application/vnd.github.v3.diff");
    expect(diffCall?.req.url).toBe(`${API}/pulls/12`);
    expect(hdrs(diffCall?.req ?? {}).Authorization).toBe(AUTH);
  });

  it("cuts the diff at max_bytes_diff and marks diffTruncado", async () => {
    const big = "x".repeat(500);
    const { provider } = setup(
      router(
        (c) => (c.headers.Accept === "application/vnd.github.v3.diff" ? reply(200, big) : undefined),
        on("GET", "/repos/o/r/pulls/12", reply(200, rawPr())),
      ),
    );
    const pr = await provider.obterPr({ numero: 12, incluir: ["diff"], max_bytes_diff: 100 });
    expect(pr.diff).toHaveLength(100);
    expect(pr.diffTruncado).toBe(true);
  });

  it("does not cut a diff that fits the default limit", async () => {
    const text = "y".repeat(1000);
    const { provider } = setup(
      router(
        (c) => (c.headers.Accept === "application/vnd.github.v3.diff" ? reply(200, text) : undefined),
        on("GET", "/repos/o/r/pulls/12", reply(200, rawPr())),
      ),
    );
    const pr = await provider.obterPr({ numero: 12, incluir: ["diff"] });
    expect(pr.diff).toBe(text);
    expect(pr.diffTruncado).toBe(false);
  });

  it("maps a 404 to provedor_http_404", async () => {
    const { provider } = setup(on("GET", "/repos/o/r/pulls/99", reply(404, { message: "Not Found" })));
    await expect(provider.obterPr({ numero: 99 })).rejects.toMatchObject({ codigo: "provedor_http_404" });
  });

  it("maps a 403 with an exhausted rate limit to a rate limit message", async () => {
    const { provider } = setup(on("GET", "/repos/o/r/pulls/12", reply(403, { message: "API rate limit exceeded" }, { "x-ratelimit-remaining": "0" })));
    const err = (await provider.obterPr({ numero: 12 }).catch((e: unknown) => e)) as RemoteError;
    expect(err.codigo).toBe("provedor_http_403");
    expect(err.mensagem).toMatch(/limitou as requisições/);
  });
});

describe("comentarPr and listarComentarios", () => {
  it("POSTs the text to the issue comments endpoint", async () => {
    const created = { id: 9, user: { login: "ana" }, body: "Texto", created_at: "2026-10-02T08:00:00Z", html_url: "https://github.com/o/r/pull/12#c9" };
    const { provider, fake } = setup(on("POST", "/repos/o/r/issues/12/comments", reply(201, created)));
    const c = await provider.comentarPr({ numero: 12, texto: "Texto" });
    expect(last(fake).req.method).toBe("POST");
    expect(last(fake).req.url).toBe(`${API}/issues/12/comments`);
    expect(last(fake).req.body).toEqual({ body: "Texto" });
    expect(c).toEqual({ id: "9", autor: "ana", texto: "Texto", criadoEm: "2026-10-02T08:00:00Z", url: "https://github.com/o/r/pull/12#c9" });
  });

  it("maps a 403 to a permission error", async () => {
    const { provider } = setup(on("POST", "/repos/o/r/issues/12/comments", reply(403, { message: "Resource not accessible by personal access token" })));
    const err = (await provider.comentarPr({ numero: 12, texto: "x" }).catch((e: unknown) => e)) as RemoteError;
    expect(err.codigo).toBe("provedor_http_403");
    expect(err.mensagem).toContain("Sem permissão");
  });

  it("lists comments with pagination", async () => {
    const route: Route = (c) => {
      if (c.url.pathname !== "/repos/o/r/issues/12/comments") return undefined;
      const page = Number(c.url.searchParams.get("page") ?? "1");
      const link: Record<string, string> = page < 2 ? { link: `<${API}/issues/12/comments?page=2>; rel="next"` } : {};
      return reply(200, [{ id: page * 10, user: { login: "u" }, body: `c${page}`, created_at: "t" }], link);
    };
    const { provider, fake } = setup(router(route));
    const out = await provider.listarComentarios({ numero: 12 });
    expect(out.itens.map((c) => c.texto)).toEqual(["c1", "c2"]);
    expect(out.truncado).toBe(false);
    expect(fake.calls).toHaveLength(2);
  });
});

describe("mesclarPr", () => {
  const sha = "b".repeat(40);
  const merged = reply(200, { sha: "m".repeat(40), merged: true, message: "Pull Request successfully merged" });

  it("reads the PR to get the head sha, then PUTs the merge with it", async () => {
    const { provider, fake } = setup(
      router(
        on("GET", "/repos/o/r/pulls/12", reply(200, rawPr({ head: { ref: "feature/x", sha } }))),
        on("PUT", "/repos/o/r/pulls/12/merge", merged),
      ),
    );
    const out = await provider.mesclarPr({ numero: 12, estrategia: "squash", titulo: "Feature X (#12)", mensagem: "corpo" });
    expect(fake.calls.map((c) => [c.req.method, new URL(c.req.url).pathname])).toEqual([
      ["GET", "/repos/o/r/pulls/12"],
      ["PUT", "/repos/o/r/pulls/12/merge"],
    ]);
    const put = last(fake).req;
    expect(hdrs(put).Authorization).toBe(AUTH);
    expect(put.body).toEqual({ merge_method: "squash", commit_title: "Feature X (#12)", commit_message: "corpo", sha });
    expect(out).toEqual({ numero: 12, mesclado: true, estado: "mesclado", commit: "m".repeat(40), url: "https://github.com/o/r/pull/12" });
    // The source branch is never deleted: no DELETE call exists.
    expect(fake.calls.some((c) => c.req.method === "DELETE")).toBe(false);
  });

  it("does not read the PR when the caller gives the sha", async () => {
    const { provider, fake } = setup(on("PUT", "/repos/o/r/pulls/12/merge", merged));
    await provider.mesclarPr({ numero: 12, estrategia: "merge", sha });
    expect(fake.calls).toHaveLength(1);
    expect(last(fake).req.body).toEqual({ merge_method: "merge", sha });
  });

  it("answers 405 with a clear message that the PR cannot be merged", async () => {
    const { provider } = setup(
      router(
        on("GET", "/repos/o/r/pulls/12", reply(200, rawPr())),
        on("PUT", "/repos/o/r/pulls/12/merge", reply(405, { message: "Pull Request is not mergeable" })),
      ),
    );
    const err = (await provider.mesclarPr({ numero: 12, estrategia: "merge" }).catch((e: unknown) => e)) as RemoteError;
    expect(err).toBeInstanceOf(RemoteError);
    expect(err.codigo).toBe("provedor_http_405");
    expect(err.mensagem).toContain("não pode ser mesclado");
    expect(err.mensagem).toContain("not mergeable");
  });

  it("answers 409 saying that the head changed", async () => {
    const { provider } = setup(on("PUT", "/repos/o/r/pulls/12/merge", reply(409, { message: "Head branch was modified. Review and try the merge again." })));
    const err = (await provider.mesclarPr({ numero: 12, estrategia: "merge", sha }).catch((e: unknown) => e)) as RemoteError;
    expect(err.codigo).toBe("provedor_http_409");
    expect(err.mensagem).toContain("cabeça do PR #12 mudou");
  });

  it("refuses fast_forward as argumento_invalido without calling GitHub", async () => {
    const { provider, fake } = setup(() => merged);
    const err = (await provider.mesclarPr({ numero: 12, estrategia: "fast_forward" }).catch((e: unknown) => e)) as RemoteError;
    expect(err.codigo).toBe("argumento_invalido");
    expect(err.mensagem).toContain("fast-forward");
    expect(fake.calls).toHaveLength(0);
  });

  it("maps a 401 from the merge to provedor_http_401", async () => {
    const { provider } = setup(on("PUT", "/repos/o/r/pulls/12/merge", reply(401, { message: "Bad credentials" })));
    await expect(provider.mesclarPr({ numero: 12, estrategia: "merge", sha })).rejects.toMatchObject({ codigo: "provedor_http_401" });
  });
});

describe("statusPipelines", () => {
  const run = (id: number, status: string, conclusion: string | null, extra: Record<string, unknown> = {}) => ({
    id,
    status,
    conclusion,
    head_branch: "feature/x",
    head_sha: "d".repeat(40),
    html_url: `https://github.com/o/r/actions/runs/${id}`,
    created_at: "2026-10-04T12:00:00Z",
    ...extra,
  });

  it("lists the runs of a branch with the jobs as steps", async () => {
    const jobs = { jobs: [{ name: "build", status: "completed", conclusion: "success" }, { name: "test", status: "in_progress", conclusion: null }] };
    const { provider, fake } = setup(
      router(
        on("GET", "/repos/o/r/actions/runs", reply(200, { total_count: 1, workflow_runs: [run(501, "in_progress", null)] })),
        on("GET", "/repos/o/r/actions/runs/501/jobs", reply(200, jobs)),
      ),
    );
    const out = await provider.statusPipelines({ branch: "feature/x" });
    const url = new URL(fake.calls[0]?.req.url ?? "");
    expect(url.searchParams.get("branch")).toBe("feature/x");
    expect(url.searchParams.get("per_page")).toBe("5");
    expect(url.searchParams.has("head_sha")).toBe(false);
    expect(out.itens).toEqual([
      {
        id: "501",
        estado: "executando",
        branch: "feature/x",
        commit: "d".repeat(40),
        url: "https://github.com/o/r/actions/runs/501",
        criadoEm: "2026-10-04T12:00:00Z",
        steps: [
          { nome: "build", estado: "sucesso" },
          { nome: "test", estado: "executando" },
        ],
      },
    ]);
    for (const c of fake.calls) expect(hdrs(c.req).Authorization).toBe(AUTH);
  });

  it("passes the commit as head_sha", async () => {
    const { provider, fake } = setup(on("GET", "/repos/o/r/actions/runs", reply(200, { workflow_runs: [] })));
    const out = await provider.statusPipelines({ commit: "e".repeat(40), limite: 2 });
    const url = new URL(last(fake).req.url);
    expect(url.searchParams.get("head_sha")).toBe("e".repeat(40));
    expect(url.searchParams.get("per_page")).toBe("2");
    expect(out).toEqual({ itens: [], truncado: false });
  });

  it("resolves the head sha of the PR first when numero_pr is given", async () => {
    const sha = "f".repeat(40);
    const { provider, fake } = setup(
      router(
        on("GET", "/repos/o/r/pulls/12", reply(200, rawPr({ head: { ref: "feature/x", sha } }))),
        on("GET", "/repos/o/r/actions/runs", reply(200, { workflow_runs: [] })),
      ),
    );
    await provider.statusPipelines({ numero_pr: 12 });
    expect(new URL(fake.calls[0]?.req.url ?? "").pathname).toBe("/repos/o/r/pulls/12");
    expect(new URL(last(fake).req.url).searchParams.get("head_sha")).toBe(sha);
  });

  it("maps statuses and conclusions to the normalized states, for runs and jobs", async () => {
    const cases: [string, string | null, string][] = [
      ["queued", null, "pendente"],
      ["waiting", null, "pendente"],
      ["requested", null, "pendente"],
      ["pending", null, "pendente"],
      ["in_progress", null, "executando"],
      ["completed", "success", "sucesso"],
      ["completed", "failure", "falha"],
      ["completed", "timed_out", "falha"],
      ["completed", "startup_failure", "falha"],
      ["completed", "cancelled", "parado"],
      ["completed", "skipped", "parado"],
      ["completed", "neutral", "parado"],
      ["completed", "stale", "parado"],
      ["completed", "action_required", "parado"],
    ];
    const runs = cases.map(([status, conclusion], i) => run(100 + i, status, conclusion));
    const { provider } = setup(
      router(
        on("GET", "/repos/o/r/actions/runs", reply(200, { workflow_runs: runs })),
        (c) => {
          const m = /\/actions\/runs\/(\d+)\/jobs$/.exec(c.url.pathname);
          if (!m) return undefined;
          const [status, conclusion] = cases[Number(m[1]) - 100] ?? ["queued", null];
          return reply(200, { jobs: [{ name: "job", status, conclusion }] });
        },
      ),
    );
    const out = await provider.statusPipelines({ limite: 20 });
    expect(out.itens.map((r) => r.estado)).toEqual(cases.map((c) => c[2]));
    expect(out.itens.map((r) => r.steps[0]?.estado)).toEqual(cases.map((c) => c[2]));
    for (const [status, conclusion, estado] of cases) expect(mapRunState(status, conclusion)).toBe(estado);
  });

  it("cuts the runs to the limit and reports truncado", async () => {
    const runs = [1, 2, 3].map((n) => run(n, "completed", "success"));
    const { provider, fake } = setup(
      router(
        on("GET", "/repos/o/r/actions/runs", reply(200, { workflow_runs: runs })),
        (c) => (/\/jobs$/.test(c.url.pathname) ? reply(200, { jobs: [] }) : undefined),
      ),
    );
    const out = await provider.statusPipelines({ limite: 2 });
    expect(out.itens.map((r) => r.id)).toEqual(["1", "2"]);
    expect(out.truncado).toBe(true);
    // 1 listing + 2 job calls: the third run is never fetched.
    expect(fake.calls).toHaveLength(3);
  });

  it("maps a 404 of the runs and of the jobs to provedor_http_404", async () => {
    const a = setup(on("GET", "/repos/o/r/actions/runs", reply(404, { message: "Not Found" })));
    await expect(a.provider.statusPipelines({})).rejects.toMatchObject({ codigo: "provedor_http_404" });
    const b = setup(
      router(
        on("GET", "/repos/o/r/actions/runs", reply(200, { workflow_runs: [run(7, "completed", "success")] })),
        on("GET", "/repos/o/r/actions/runs/7/jobs", reply(404, { message: "Not Found" })),
      ),
    );
    await expect(b.provider.statusPipelines({})).rejects.toMatchObject({ codigo: "provedor_http_404" });
  });

  it("maps a 429 to a rate limit error", async () => {
    const { provider } = setup(on("GET", "/repos/o/r/actions/runs", reply(429, { message: "slow down" }, { "retry-after": "30" })));
    const err = (await provider.statusPipelines({}).catch((e: unknown) => e)) as RemoteError;
    expect(err.codigo).toBe("provedor_http_429");
    expect(err.mensagem).toContain("30 s");
  });
});

describe("truncateBytes", () => {
  it("counts bytes, not characters, and drops a character cut in half", () => {
    expect(truncateBytes("abc", 10)).toEqual({ texto: "abc", truncado: false });
    // "é" takes 2 bytes: cutting at 3 bytes of "aéé" keeps "aé" (3 bytes) and the cut is clean.
    expect(truncateBytes("aéé", 3)).toEqual({ texto: "aé", truncado: true });
    // Cutting in the middle of the second "é" (4 bytes) drops the half character.
    expect(truncateBytes("aéé", 4)).toEqual({ texto: "aé", truncado: true });
  });
});
