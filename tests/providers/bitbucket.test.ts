import { describe, expect, it } from "vitest";
import { RemoteError } from "../../src/core/providers/errors";
import { createSecureHttp } from "../../src/core/providers/http";
import { createBitbucketProvider, createBitbucketProviderWith, pipelineEstado } from "../../src/core/providers/bitbucket";
import type { BitbucketOptions } from "../../src/core/providers/bitbucket";
import type { GitProvider } from "../../src/core/providers/provider";
import type { SecretInfo } from "../../src/ecosystem/types";
import { FAKE_VALUE, makeFakeSecrets, reply, secretInfo } from "../helpers/fake-secrets";
import type { FakeHandler, FakeSecrets } from "../helpers/fake-secrets";

const BASE = "https://api.bitbucket.org/2.0/repositories/ws/r";
const REF = { provider: "bitbucket" as const, owner: "ws", slug: "r", repo: "ws/r" };

interface Setup {
  fake: FakeSecrets;
  provider: GitProvider;
}

function setup(handler: FakeHandler, opts: { secretName?: string; info?: SecretInfo; options?: BitbucketOptions } = {}): Setup {
  const fake = makeFakeSecrets({ handler });
  const ctx = {
    http: createSecureHttp(fake.getSecrets),
    ref: REF,
    secretName: opts.secretName ?? "BB_TESTE",
    ...(opts.info ? { secretInfo: opts.info } : {}),
    redact: (t: string) => fake.service.redact(t),
  };
  const provider = opts.options ? createBitbucketProviderWith(ctx, opts.options) : createBitbucketProvider(ctx);
  return { fake, provider };
}

/** Fake clock: `sleep` advances the time, so the polling needs no real waiting. */
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

const merged = (over: Record<string, unknown> = {}) => prBody({ state: "MERGED", merge_commit: { hash: "mmm999" }, ...over });

describe("criarPr", () => {
  it("POSTs the PR with close_source_branch false and maps the answer", async () => {
    const { fake, provider } = setup(() => reply(201, prBody()));
    const pr = await provider.criarPr({ origem: "feature/x", destino: "develop", titulo: "Minha feature", descricao: "Descricao" });
    expect(pr).toEqual({
      numero: 12,
      titulo: "Minha feature",
      estado: "aberto",
      origem: "feature/x",
      destino: "develop",
      url: "https://bitbucket.org/ws/r/pull-requests/12",
      autor: "Ana",
      criadoEm: "2026-10-01T10:00:00Z",
      descricao: "Descricao",
      headSha: "aaa111",
    });
    expect(fake.calls).toHaveLength(1);
    const { req, caller } = fake.calls[0]!;
    expect(caller).toBe("ai-git-tools");
    expect(req.method).toBe("POST");
    expect(req.url).toBe(`${BASE}/pullrequests`);
    expect(req.headers?.Authorization).toBe("{{bearer:BB_TESTE}}");
    expect(req.headers?.Accept).toBe("application/json");
    expect(req.headers?.["User-Agent"]).toBe("obsidian-ai-git-tools");
    expect(req.body).toEqual({
      title: "Minha feature",
      description: "Descricao",
      source: { branch: { name: "feature/x" } },
      destination: { branch: { name: "develop" } },
      close_source_branch: false,
    });
  });

  it("sends draft only when asked", async () => {
    const { fake, provider } = setup(() => reply(201, prBody()));
    await provider.criarPr({ origem: "a", destino: "b", titulo: "t", rascunho: true });
    await provider.criarPr({ origem: "a", destino: "b", titulo: "t" });
    expect((fake.calls[0]!.req.body as Record<string, unknown>).draft).toBe(true);
    expect(fake.calls[0]!.req.body).toMatchObject({ close_source_branch: false });
    expect(fake.calls[1]!.req.body).not.toHaveProperty("draft");
  });

  it("maps every Bitbucket state", async () => {
    const states: Array<[string, string]> = [
      ["OPEN", "aberto"],
      ["MERGED", "mesclado"],
      ["DECLINED", "fechado"],
      ["SUPERSEDED", "fechado"],
    ];
    for (const [state, estado] of states) {
      const { provider } = setup(() => reply(201, prBody({ state })));
      expect((await provider.criarPr({ origem: "a", destino: "b", titulo: "t" })).estado).toBe(estado);
    }
  });

  it("turns a 400 into a RemoteError with the provider detail, redacted", async () => {
    const { provider } = setup(() => reply(400, { type: "error", error: { message: `branch inexistente ${FAKE_VALUE}` } }));
    const err = await provider.criarPr({ origem: "a", destino: "b", titulo: "t" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RemoteError);
    expect((err as RemoteError).codigo).toBe("provedor_http_400");
    expect((err as RemoteError).mensagem).toContain("branch inexistente");
    expect((err as RemoteError).mensagem).not.toContain(FAKE_VALUE);
  });
});

describe("secret", () => {
  it("answers secret_nao_configurada without a secret, and makes no request", async () => {
    const { fake, provider } = setup(() => reply(200, {}), { secretName: "" });
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
      const err = await call().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(RemoteError);
      expect((err as RemoteError).codigo).toBe("secret_nao_configurada");
    }
    expect(fake.calls).toHaveLength(0);
  });

  it("uses {{basic:NAME}} for a basic secret", async () => {
    const { fake, provider } = setup(() => reply(200, { values: [] }), { info: secretInfo("BB_TESTE", "basic") });
    await provider.listarPrs({ estado: "aberto" });
    expect(fake.calls[0]!.req.headers?.Authorization).toBe("{{basic:BB_TESTE}}");
  });
});

describe("listarPrs", () => {
  it("lists by state with pagelen and maps the PRs", async () => {
    const { fake, provider } = setup(() => reply(200, { values: [prBody(), prBody({ id: 13 })] }));
    const out = await provider.listarPrs({ estado: "mesclado", limite: 10 });
    expect(out.itens.map((p) => p.numero)).toEqual([12, 13]);
    expect(out.truncado).toBe(false);
    const url = new URL(fake.calls[0]!.req.url);
    expect(url.origin + url.pathname).toBe(`${BASE}/pullrequests`);
    expect(url.searchParams.getAll("state")).toEqual(["MERGED"]);
    expect(url.searchParams.get("pagelen")).toBe("10");
    expect(url.searchParams.has("q")).toBe(false);
  });

  it("repeats state for the three states with todos, and the other states map as expected", async () => {
    const { fake, provider } = setup(() => reply(200, { values: [] }));
    await provider.listarPrs({ estado: "todos" });
    await provider.listarPrs({ estado: "aberto" });
    await provider.listarPrs({ estado: "fechado" });
    expect(new URL(fake.calls[0]!.req.url).searchParams.getAll("state")).toEqual(["OPEN", "MERGED", "DECLINED", "SUPERSEDED"]);
    expect(new URL(fake.calls[1]!.req.url).searchParams.getAll("state")).toEqual(["OPEN"]);
    expect(new URL(fake.calls[2]!.req.url).searchParams.getAll("state")).toEqual(["DECLINED", "SUPERSEDED"]);
    expect(new URL(fake.calls[0]!.req.url).searchParams.get("pagelen")).toBe("30");
  });

  it("filters by source and destination with q and escapes quotes and backslashes", async () => {
    const { fake, provider } = setup(() => reply(200, { values: [] }));
    await provider.listarPrs({ estado: "aberto", origem: 'feat"ure\\x', destino: "develop" });
    const q = new URL(fake.calls[0]!.req.url).searchParams.get("q");
    expect(q).toBe('source.branch.name="feat\\"ure\\\\x" AND destination.branch.name="develop"');
    await provider.listarPrs({ estado: "aberto", destino: "main" });
    expect(new URL(fake.calls[1]!.req.url).searchParams.get("q")).toBe('destination.branch.name="main"');
  });

  it("follows `next` and stops at 5 pages", async () => {
    const { fake, provider } = setup((req) => {
      const page = Number(new URL(req.url).searchParams.get("page") ?? "1");
      return reply(200, { values: [prBody({ id: page })], next: `${BASE}/pullrequests?page=${page + 1}` });
    });
    const out = await provider.listarPrs({ estado: "aberto", limite: 100 });
    expect(fake.calls).toHaveLength(5);
    expect(out.itens).toHaveLength(5);
    expect(out.truncado).toBe(true);
    for (const c of fake.calls) expect(c.req.headers?.Authorization).toBe("{{bearer:BB_TESTE}}");
  });

  it("cuts at the limit", async () => {
    const { provider } = setup(() => reply(200, { values: [prBody({ id: 1 }), prBody({ id: 2 }), prBody({ id: 3 })] }));
    const out = await provider.listarPrs({ estado: "aberto", limite: 2 });
    expect(out.itens.map((p) => p.numero)).toEqual([1, 2]);
    expect(out.truncado).toBe(true);
  });

  it("does not follow a `next` that points to another host", async () => {
    const { provider } = setup(() => reply(200, { values: [prBody()], next: "https://evil.example.com/x" }));
    await expect(provider.listarPrs({ estado: "aberto", limite: 100 })).rejects.toMatchObject({ codigo: "resposta_invalida" });
  });

  it("reports a 404 as provedor_http_404", async () => {
    const { provider } = setup(() => reply(404, { type: "error", error: { message: "Repository not found" } }));
    await expect(provider.listarPrs({ estado: "aberto" })).rejects.toMatchObject({ codigo: "provedor_http_404" });
  });
});

describe("obterPr", () => {
  it("reads only the PR by default", async () => {
    const { fake, provider } = setup(() => reply(200, prBody()));
    const pr = await provider.obterPr({ numero: 12 });
    expect(pr.numero).toBe(12);
    expect(pr.commits).toBeUndefined();
    expect(pr.diff).toBeUndefined();
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]!.req.url).toBe(`${BASE}/pullrequests/12`);
    expect(fake.calls[0]!.req.method).toBe("GET");
  });

  it("includes commits, diff and comments", async () => {
    const { fake, provider } = setup((req) => {
      const path = new URL(req.url).pathname;
      if (path.endsWith("/commits")) {
        return reply(200, {
          values: [
            { hash: "c1", message: "primeiro\n\ncorpo\n", date: "2026-10-01T10:00:00Z", author: { raw: "Ana <a@x>", user: { display_name: "Ana" } } },
            { hash: "c2", message: "segundo", date: "2026-10-02T10:00:00Z", author: { raw: "Beto <b@x>" } },
          ],
        });
      }
      if (path.endsWith("/diff")) return reply(200, "diff --git a/x b/x\n+linha\n", { "content-type": "text/plain" });
      if (path.endsWith("/comments")) {
        return reply(200, {
          values: [
            { id: 1, content: { raw: "ok" }, user: { display_name: "Ana" }, created_on: "2026-10-03T10:00:00Z" },
            { id: 2, content: { raw: "apagado" }, user: { display_name: "Ana" }, deleted: true },
          ],
        });
      }
      return reply(200, prBody());
    });
    const pr = await provider.obterPr({ numero: 12, incluir: ["commits", "diff", "comentarios"] });
    expect(pr.commits).toEqual([
      { hash: "c1", mensagem: "primeiro\n\ncorpo", autor: "Ana", data: "2026-10-01T10:00:00Z" },
      { hash: "c2", mensagem: "segundo", autor: "Beto <b@x>", data: "2026-10-02T10:00:00Z" },
    ]);
    expect(pr.diff).toBe("diff --git a/x b/x\n+linha\n");
    expect(pr.diffTruncado).toBe(false);
    expect(pr.comentarios).toEqual([{ id: "1", autor: "Ana", texto: "ok", criadoEm: "2026-10-03T10:00:00Z" }]);
    const diffCall = fake.calls.find((c) => c.req.url.endsWith("/diff"))!;
    expect(diffCall.req.headers?.Accept).toBe("text/plain");
    expect(diffCall.req.headers?.Authorization).toBe("{{bearer:BB_TESTE}}");
  });

  it("truncates the diff at max_bytes_diff (default 200000) without breaking a character", async () => {
    const long = "é".repeat(150_000); // 300000 bytes
    const { provider } = setup((req) => (new URL(req.url).pathname.endsWith("/diff") ? reply(200, long) : reply(200, prBody())));
    const big = await provider.obterPr({ numero: 12, incluir: ["diff"] });
    expect(big.diffTruncado).toBe(true);
    expect(new TextEncoder().encode(big.diff ?? "").length).toBeLessThanOrEqual(200_000);
    expect(big.diff).not.toContain("�");
    const small = await provider.obterPr({ numero: 12, incluir: ["diff"], max_bytes_diff: 5 });
    expect(small.diff).toBe("éé");
    expect(small.diffTruncado).toBe(true);
  });

  it("follows a diff redirect on the same host", async () => {
    const { fake, provider } = setup((req) => {
      const path = new URL(req.url).pathname;
      if (path.endsWith("/pullrequests/12/diff")) return reply(302, "", { location: `${BASE}/diff/ws/r:aaa..bbb` });
      if (path.includes("/diff/")) return reply(200, "DIFF");
      return reply(200, prBody());
    });
    const pr = await provider.obterPr({ numero: 12, incluir: ["diff"] });
    expect(pr.diff).toBe("DIFF");
    const last = fake.calls[fake.calls.length - 1]!;
    expect(last.req.url).toBe(`${BASE}/diff/ws/r:aaa..bbb`);
    expect(last.req.headers?.Authorization).toBe("{{bearer:BB_TESTE}}");
  });

  it("refuses a diff redirect to another host and sends nothing there", async () => {
    const { fake, provider } = setup((req) => {
      if (new URL(req.url).pathname.endsWith("/diff")) return reply(302, "", { location: "https://evil.example.com/diff" });
      return reply(200, prBody());
    });
    await expect(provider.obterPr({ numero: 12, incluir: ["diff"] })).rejects.toMatchObject({ codigo: "resposta_invalida" });
    expect(fake.calls.some((c) => c.req.url.includes("evil.example.com"))).toBe(false);
  });

  it("reports a missing PR", async () => {
    const { provider } = setup(() => reply(404, { type: "error", error: { message: "No pull request" } }));
    await expect(provider.obterPr({ numero: 99 })).rejects.toMatchObject({ codigo: "provedor_http_404" });
  });
});

describe("comentarios", () => {
  it("comentarPr POSTs content.raw and maps the comment", async () => {
    const { fake, provider } = setup(() =>
      reply(201, { id: 77, content: { raw: "texto" }, user: { display_name: "Ana" }, created_on: "2026-10-03T10:00:00Z", links: { html: { href: "https://bitbucket.org/c" } } }),
    );
    const c = await provider.comentarPr({ numero: 12, texto: "texto" });
    expect(c).toEqual({ id: "77", autor: "Ana", texto: "texto", criadoEm: "2026-10-03T10:00:00Z", url: "https://bitbucket.org/c" });
    const { req } = fake.calls[0]!;
    expect(req.method).toBe("POST");
    expect(req.url).toBe(`${BASE}/pullrequests/12/comments`);
    expect(req.body).toEqual({ content: { raw: "texto" } });
  });

  it("comentarPr reports a 403", async () => {
    const { provider } = setup(() => reply(403, { type: "error", error: { message: "no" } }));
    await expect(provider.comentarPr({ numero: 12, texto: "x" })).rejects.toMatchObject({ codigo: "provedor_http_403" });
  });

  it("listarComentarios ignores deleted comments, paginates and respects the limit", async () => {
    const { fake, provider } = setup((req) => {
      const page = Number(new URL(req.url).searchParams.get("page") ?? "1");
      const values = [
        { id: page * 10, content: { raw: "a" }, user: { display_name: "Ana" } },
        { id: page * 10 + 1, content: { raw: "b" }, user: { display_name: "Ana" }, deleted: true },
      ];
      return reply(200, page < 2 ? { values, next: `${BASE}/pullrequests/12/comments?page=2` } : { values });
    });
    const all = await provider.listarComentarios({ numero: 12 });
    expect(all.itens.map((c) => c.id)).toEqual(["10", "20"]);
    expect(all.truncado).toBe(false);
    expect(fake.calls).toHaveLength(2);
    const one = await provider.listarComentarios({ numero: 12, limite: 1 });
    expect(one.itens.map((c) => c.id)).toEqual(["10"]);
    expect(one.truncado).toBe(true);
  });
});

describe("mesclarPr", () => {
  it("merges with 200 and sends the strategy, close_source_branch false and the message", async () => {
    const { fake, provider } = setup(() => reply(200, merged()));
    const out = await provider.mesclarPr({ numero: 12, estrategia: "merge", mensagem: "Merge feature" });
    expect(out).toEqual({ numero: 12, mesclado: true, estado: "mesclado", commit: "mmm999", url: "https://bitbucket.org/ws/r/pull-requests/12" });
    const { req } = fake.calls[0]!;
    expect(req.method).toBe("POST");
    expect(req.url).toBe(`${BASE}/pullrequests/12/merge`);
    expect(req.body).toEqual({ type: "pullrequest", merge_strategy: "merge_commit", close_source_branch: false, message: "Merge feature" });
    expect(req.headers?.Authorization).toBe("{{bearer:BB_TESTE}}");
  });

  it("maps the strategies and omits an empty message", async () => {
    const { fake, provider } = setup(() => reply(200, merged()));
    await provider.mesclarPr({ numero: 12, estrategia: "squash" });
    await provider.mesclarPr({ numero: 12, estrategia: "fast_forward" });
    expect(fake.calls[0]!.req.body).toEqual({ type: "pullrequest", merge_strategy: "squash", close_source_branch: false });
    expect(fake.calls[1]!.req.body).toMatchObject({ merge_strategy: "fast_forward", close_source_branch: false });
  });

  it("makes no DELETE and no other call besides the merge on 200", async () => {
    const { fake, provider } = setup(() => reply(200, merged()));
    await provider.mesclarPr({ numero: 12, estrategia: "merge" });
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls.every((c) => c.req.method !== "DELETE")).toBe(true);
  });

  it("202 with Location: polls PENDING until SUCCESS and returns merged", async () => {
    const task = `${BASE}/pullrequests/12/merge/task-status/abc`;
    let polls = 0;
    const clock = fakeClock();
    const { fake, provider } = setup(
      (req) => {
        if (req.method === "POST") return reply(202, "", { Location: task });
        polls += 1;
        return polls < 3 ? reply(200, { task_status: "PENDING" }) : reply(200, { task_status: "SUCCESS", merge_result: merged() });
      },
      { options: clock.options },
    );
    const out = await provider.mesclarPr({ numero: 12, estrategia: "merge" });
    expect(out).toMatchObject({ numero: 12, mesclado: true, estado: "mesclado", commit: "mmm999" });
    expect(fake.calls.map((c) => c.req.method)).toEqual(["POST", "GET", "GET", "GET"]);
    for (const c of fake.calls.slice(1)) {
      expect(c.req.url).toBe(task);
      expect(c.req.headers?.Authorization).toBe("{{bearer:BB_TESTE}}");
    }
    expect(clock.time()).toBe(2000); // one second between polls, no real waiting
  });

  it("202 then SUCCESS without merge_result rereads the PR", async () => {
    const task = `${BASE}/pullrequests/12/merge/task-status/abc`;
    const { fake, provider } = setup(
      (req) => {
        if (req.method === "POST") return reply(202, "", { location: task });
        if (req.url === task) return reply(200, { task_status: "SUCCESS" });
        return reply(200, merged());
      },
      { options: fakeClock().options },
    );
    const out = await provider.mesclarPr({ numero: 12, estrategia: "merge" });
    expect(out).toMatchObject({ mesclado: true, commit: "mmm999" });
    expect(fake.calls[fake.calls.length - 1]!.req.url).toBe(`${BASE}/pullrequests/12`);
  });

  it("202 with a failed task is a RemoteError", async () => {
    const task = `${BASE}/pullrequests/12/merge/task-status/abc`;
    const { provider } = setup(
      (req) => (req.method === "POST" ? reply(202, "", { location: task }) : reply(200, { task_status: "ERROR", error: { message: "merge conflict" } })),
      { options: fakeClock().options },
    );
    const err = await provider.mesclarPr({ numero: 12, estrategia: "merge" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RemoteError);
    expect((err as RemoteError).mensagem).toContain("merge conflict");
  });

  it("202 that never finishes gives a clear error saying the merge continues on Bitbucket", async () => {
    const task = `${BASE}/pullrequests/12/merge/task-status/abc`;
    const clock = fakeClock();
    const { fake, provider } = setup((req) => (req.method === "POST" ? reply(202, "", { location: task }) : reply(200, { task_status: "PENDING" })), {
      options: clock.options,
    });
    const err = (await provider.mesclarPr({ numero: 12, estrategia: "merge" }).catch((e: unknown) => e)) as RemoteError;
    expect(err).toBeInstanceOf(RemoteError);
    expect(err.codigo).toBe("merge_em_andamento");
    expect(err.status).toBe(202);
    expect(err.mensagem).toMatch(/segue em andamento no Bitbucket/);
    expect(err.mensagem).toMatch(/não é uma falha definitiva/);
    expect(clock.time()).toBe(30_000);
    expect(fake.calls.length).toBe(31); // the POST and 30 polls
  });

  it("refuses a Location on another host and never polls it", async () => {
    const { fake, provider } = setup(() => reply(202, "", { location: "https://evil.example.com/task" }), { options: fakeClock().options });
    await expect(provider.mesclarPr({ numero: 12, estrategia: "merge" })).rejects.toMatchObject({ codigo: "resposta_invalida" });
    expect(fake.calls).toHaveLength(1);
  });

  it("refuses an http Location and a 202 without Location", async () => {
    const http = setup(() => reply(202, "", { location: "http://api.bitbucket.org/task" }), { options: fakeClock().options });
    await expect(http.provider.mesclarPr({ numero: 12, estrategia: "merge" })).rejects.toMatchObject({ codigo: "resposta_invalida" });
    const none = setup(() => reply(202), { options: fakeClock().options });
    await expect(none.provider.mesclarPr({ numero: 12, estrategia: "merge" })).rejects.toMatchObject({ codigo: "resposta_invalida" });
  });

  it("explains 409 and 555", async () => {
    const conflict = setup(() => reply(409, { type: "error", error: { message: "Cannot merge" } }));
    const e409 = (await conflict.provider.mesclarPr({ numero: 12, estrategia: "merge" }).catch((e: unknown) => e)) as RemoteError;
    expect(e409.codigo).toBe("provedor_http_409");
    expect(e409.mensagem).toContain("não pôde mesclar o PR #12");
    expect(e409.mensagem).toContain("Cannot merge");
    const slow = setup(() => reply(555, ""));
    const e555 = (await slow.provider.mesclarPr({ numero: 12, estrategia: "merge" }).catch((e: unknown) => e)) as RemoteError;
    expect(e555.codigo).toBe("provedor_http_555");
    expect(e555.mensagem).toMatch(/demorou demais/);
  });

  it("reports another error status", async () => {
    const { provider } = setup(() => reply(403, { type: "error", error: { message: "no" } }));
    await expect(provider.mesclarPr({ numero: 12, estrategia: "merge" })).rejects.toMatchObject({ codigo: "provedor_http_403" });
  });
});

describe("statusPipelines", () => {
  const pipeline = (uuid: string, over: Record<string, unknown> = {}) => ({
    uuid,
    build_number: 41,
    created_on: "2026-10-05T10:00:00Z",
    state: { name: "COMPLETED", result: { name: "SUCCESSFUL" } },
    target: { type: "pipeline_ref_target", ref_name: "feature/x", ref_type: "branch", commit: { hash: "abc123" } },
    ...over,
  });

  it("lists the pipelines of a branch with their steps, filtering locally too", async () => {
    const { fake, provider } = setup((req) => {
      const url = new URL(req.url);
      if (url.pathname === "/2.0/repositories/ws/r/pipelines/") {
        return reply(200, {
          values: [
            pipeline("{u1}"),
            pipeline("{u2}", { build_number: 40, target: { ref_name: "outra", commit: { hash: "zzz" } } }),
            pipeline("{u3}", { build_number: 39, state: { name: "IN_PROGRESS" } }),
          ],
        });
      }
      if (url.pathname.endsWith("/steps/")) {
        return reply(200, {
          values: [
            { name: "Build", state: { name: "COMPLETED", result: { name: "SUCCESSFUL" } } },
            { name: "Test", state: { name: "COMPLETED", result: { name: "FAILED" } } },
          ],
        });
      }
      return reply(404, {});
    });
    const out = await provider.statusPipelines({ branch: "feature/x", limite: 5 });
    expect(out.itens.map((p) => p.id)).toEqual(["{u1}", "{u3}"]);
    expect(out.itens[0]).toEqual({
      id: "{u1}",
      estado: "sucesso",
      branch: "feature/x",
      commit: "abc123",
      url: "https://bitbucket.org/ws/r/pipelines/results/41",
      criadoEm: "2026-10-05T10:00:00Z",
      steps: [
        { nome: "Build", estado: "sucesso" },
        { nome: "Test", estado: "falha" },
      ],
    });
    expect(out.itens[1]!.estado).toBe("executando");
    const list = new URL(fake.calls[0]!.req.url);
    expect(list.searchParams.get("sort")).toBe("-created_on");
    expect(list.searchParams.get("q")).toBe('target.ref_name="feature/x"');
    expect(list.searchParams.get("pagelen")).toBe("20");
    // UUIDs with braces are encoded in the path
    const stepUrls = fake.calls.map((c) => c.req.url).filter((u) => u.includes("/steps/"));
    expect(stepUrls).toContain(`${BASE}/pipelines/%7Bu1%7D/steps/`);
    expect(stepUrls).toContain(`${BASE}/pipelines/%7Bu3%7D/steps/`);
    for (const c of fake.calls) expect(c.req.headers?.Authorization).toBe("{{bearer:BB_TESTE}}");
  });

  it("without filters asks for `limite` pipelines and cuts the list", async () => {
    const { fake, provider } = setup((req) => {
      const path = new URL(req.url).pathname;
      if (path.endsWith("/steps/")) return reply(200, { values: [] });
      return reply(200, { values: [pipeline("{a}"), pipeline("{b}"), pipeline("{c}")] });
    });
    const out = await provider.statusPipelines({ limite: 2 });
    expect(out.itens.map((p) => p.id)).toEqual(["{a}", "{b}"]);
    expect(out.truncado).toBe(true);
    const list = new URL(fake.calls[0]!.req.url);
    expect(list.searchParams.get("pagelen")).toBe("2");
    expect(list.searchParams.has("q")).toBe(false);
  });

  it("filters by commit", async () => {
    const { fake, provider } = setup((req) => {
      const path = new URL(req.url).pathname;
      if (path.endsWith("/steps/")) return reply(200, { values: [] });
      return reply(200, { values: [pipeline("{a}"), pipeline("{b}", { target: { ref_name: "feature/x", commit: { hash: "def456" } } })] });
    });
    const out = await provider.statusPipelines({ commit: "def456" });
    expect(out.itens.map((p) => p.id)).toEqual(["{b}"]);
    expect(new URL(fake.calls[0]!.req.url).searchParams.get("q")).toBe('target.commit.hash="def456"');
  });

  it("resolves the source branch of a PR", async () => {
    const { fake, provider } = setup((req) => {
      const path = new URL(req.url).pathname;
      if (path.endsWith("/pullrequests/7")) return reply(200, prBody({ id: 7 }));
      if (path.endsWith("/steps/")) return reply(200, { values: [] });
      return reply(200, { values: [pipeline("{a}")] });
    });
    const out = await provider.statusPipelines({ numero_pr: 7 });
    expect(out.itens).toHaveLength(1);
    expect(fake.calls[0]!.req.url).toBe(`${BASE}/pullrequests/7`);
    expect(new URL(fake.calls[1]!.req.url).searchParams.get("q")).toBe('target.ref_name="feature/x"');
  });

  it("uses the PR source of a pull request pipeline when there is no ref_name", async () => {
    const { provider } = setup((req) => {
      if (new URL(req.url).pathname.endsWith("/steps/")) return reply(200, { values: [] });
      return reply(200, { values: [pipeline("{a}", { target: { type: "pipeline_pullrequest_target", source: "feature/x", commit: { hash: "abc" } } })] });
    });
    const out = await provider.statusPipelines({ branch: "feature/x" });
    expect(out.itens[0]!.branch).toBe("feature/x");
  });

  it("reports an error of the pipelines API", async () => {
    const { provider } = setup(() => reply(403, { type: "error", error: { message: "Pipelines disabled" } }));
    await expect(provider.statusPipelines({ branch: "x" })).rejects.toMatchObject({ codigo: "provedor_http_403" });
  });

  it("maps the states of pipelines and steps", () => {
    const cases: Array<[unknown, string]> = [
      [{ name: "PENDING" }, "pendente"],
      [{ name: "IN_PROGRESS" }, "executando"],
      [{ name: "RUNNING" }, "executando"],
      [{ name: "IN_PROGRESS", stage: { name: "PAUSED" } }, "parado"],
      [{ name: "COMPLETED", result: { name: "SUCCESSFUL" } }, "sucesso"],
      [{ name: "COMPLETED", result: { name: "FAILED" } }, "falha"],
      [{ name: "COMPLETED", result: { name: "ERROR" } }, "falha"],
      [{ name: "COMPLETED", result: { name: "STOPPED" } }, "parado"],
      [{ name: "COMPLETED", result: { name: "EXPIRED" } }, "parado"],
      [{ name: "PAUSED" }, "parado"],
      [{ name: "HALTED" }, "parado"],
      [{ name: "FAILED" }, "falha"],
      [undefined, "pendente"],
    ];
    for (const [state, expected] of cases) expect(pipelineEstado(state)).toBe(expected);
  });
});
