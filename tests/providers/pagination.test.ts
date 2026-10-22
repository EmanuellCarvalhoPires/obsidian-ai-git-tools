import { describe, expect, it } from "vitest";
import { RemoteError } from "../../src/core/providers/errors";
import { createSecureHttp } from "../../src/core/providers/http";
import { nextFromLinkHeader, paginateBitbucket, paginateGithub } from "../../src/core/providers/pagination";
import { makeFakeSecrets, reply } from "../helpers/fake-secrets";
import type { FakeHandler } from "../helpers/fake-secrets";

const BB = "https://api.bitbucket.org/2.0/repositories/ws/r/pullrequests";
const GH = "https://api.github.com/repos/o/r/pulls";
const AUTH = { Authorization: "{{basic:BB_TESTE}}" };

/** `pages` pages of Bitbucket with 2 items each; the last one has no `next`. */
function bitbucketPages(pages: number): FakeHandler {
  return (req) => {
    const page = Number(new URL(req.url).searchParams.get("page") ?? "1");
    const values = [{ id: page * 10 }, { id: page * 10 + 1 }];
    return reply(200, page < pages ? { values, next: `${BB}?page=${page + 1}` } : { values });
  };
}

/** GitHub pages with a Link header, same shape. */
function githubPages(pages: number): FakeHandler {
  return (req) => {
    const page = Number(new URL(req.url).searchParams.get("page") ?? "1");
    const items = [{ n: page * 10 }, { n: page * 10 + 1 }];
    const link: Record<string, string> = page < pages ? { link: `<${GH}?page=${page + 1}>; rel="next", <${GH}?page=${pages}>; rel="last"` } : {};
    return reply(200, items, link);
  };
}

describe("paginateBitbucket", () => {
  it("follows `next` until there is none", async () => {
    const fake = makeFakeSecrets({ handler: bitbucketPages(3) });
    const out = await paginateBitbucket<{ id: number }>(createSecureHttp(fake.getSecrets), BB, { headers: AUTH });
    expect(out.itens.map((i) => i.id)).toEqual([10, 11, 20, 21, 30, 31]);
    expect(out.truncado).toBe(false);
    expect(fake.calls).toHaveLength(3);
    for (const c of fake.calls) expect(c.req.headers).toMatchObject(AUTH);
  });

  it("reads at most 5 pages by default and reports `truncado`", async () => {
    const fake = makeFakeSecrets({ handler: bitbucketPages(9) });
    const out = await paginateBitbucket(createSecureHttp(fake.getSecrets), BB);
    expect(fake.calls).toHaveLength(5);
    expect(out.itens).toHaveLength(10);
    expect(out.truncado).toBe(true);
  });

  it("honours maxPages and exactly 5 pages is not truncated", async () => {
    const fake = makeFakeSecrets({ handler: bitbucketPages(5) });
    const out = await paginateBitbucket(createSecureHttp(fake.getSecrets), BB);
    expect(out.itens).toHaveLength(10);
    expect(out.truncado).toBe(false);
    const two = makeFakeSecrets({ handler: bitbucketPages(5) });
    const cut = await paginateBitbucket(createSecureHttp(two.getSecrets), BB, { maxPages: 2 });
    expect(two.calls).toHaveLength(2);
    expect(cut.truncado).toBe(true);
  });

  it("cuts to maxItems", async () => {
    const fake = makeFakeSecrets({ handler: bitbucketPages(4) });
    const out = await paginateBitbucket(createSecureHttp(fake.getSecrets), BB, { maxItems: 3 });
    expect(out.itens).toHaveLength(3);
    expect(out.truncado).toBe(true);
    expect(fake.calls).toHaveLength(2);
  });

  it("does not follow a `next` to another host", async () => {
    const fake = makeFakeSecrets({ handler: () => reply(200, { values: [{ id: 1 }], next: "https://evil.example.com/steal" }) });
    await expect(paginateBitbucket(createSecureHttp(fake.getSecrets), BB, { headers: AUTH })).rejects.toMatchObject({ codigo: "resposta_invalida" });
    expect(fake.calls).toHaveLength(1);
  });

  it("maps an error answer of a page to a RemoteError", async () => {
    const fake = makeFakeSecrets({ handler: () => reply(404, { error: { message: "No such repository" } }) });
    const err = await paginateBitbucket(createSecureHttp(fake.getSecrets), BB).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RemoteError);
    expect((err as RemoteError).codigo).toBe("provedor_http_404");
    expect((err as RemoteError).mensagem).toContain("No such repository");
  });

  it("returns an empty list when the body has no values", async () => {
    const fake = makeFakeSecrets({ handler: () => reply(200, {}) });
    expect(await paginateBitbucket(createSecureHttp(fake.getSecrets), BB)).toEqual({ itens: [], truncado: false });
  });
});

describe("paginateGithub", () => {
  it("follows Link rel=next until there is none", async () => {
    const fake = makeFakeSecrets({ handler: githubPages(3) });
    const out = await paginateGithub<{ n: number }>(createSecureHttp(fake.getSecrets), GH, { headers: { Authorization: "{{bearer:GH_TESTE}}" } });
    expect(out.itens.map((i) => i.n)).toEqual([10, 11, 20, 21, 30, 31]);
    expect(out.truncado).toBe(false);
    expect(fake.calls).toHaveLength(3);
  });

  it("reads at most 5 pages and reports `truncado`", async () => {
    const fake = makeFakeSecrets({ handler: githubPages(8) });
    const out = await paginateGithub(createSecureHttp(fake.getSecrets), GH);
    expect(fake.calls).toHaveLength(5);
    expect(out.itens).toHaveLength(10);
    expect(out.truncado).toBe(true);
  });

  it("takes the list from an object body with `pick` (Actions runs)", async () => {
    const fake = makeFakeSecrets({ handler: () => reply(200, { total_count: 2, workflow_runs: [{ id: 1 }, { id: 2 }] }) });
    const out = await paginateGithub<{ id: number }>(createSecureHttp(fake.getSecrets), `${GH}/runs`, {
      pick: (body) => (body as { workflow_runs: unknown }).workflow_runs,
    });
    expect(out.itens.map((i) => i.id)).toEqual([1, 2]);
  });

  it("does not follow a Link to another host or to http", async () => {
    const other = makeFakeSecrets({ handler: () => reply(200, [{ n: 1 }], { link: '<https://evil.example.com/x>; rel="next"' }) });
    await expect(paginateGithub(createSecureHttp(other.getSecrets), GH)).rejects.toMatchObject({ codigo: "resposta_invalida" });
    const plain = makeFakeSecrets({ handler: () => reply(200, [{ n: 1 }], { link: '<http://api.github.com/x>; rel="next"' }) });
    await expect(paginateGithub(createSecureHttp(plain.getSecrets), GH)).rejects.toMatchObject({ codigo: "resposta_invalida" });
  });

  it("maps an error answer to a RemoteError", async () => {
    const fake = makeFakeSecrets({ handler: () => reply(401, { message: "Bad credentials" }) });
    await expect(paginateGithub(createSecureHttp(fake.getSecrets), GH)).rejects.toMatchObject({ codigo: "provedor_http_401" });
  });

  it("returns an empty list for a body that is not a list", async () => {
    const fake = makeFakeSecrets({ handler: () => reply(200, { message: "x" }) });
    expect((await paginateGithub(createSecureHttp(fake.getSecrets), GH)).itens).toEqual([]);
  });
});

describe("nextFromLinkHeader", () => {
  it("finds rel=next among other relations, in any order", () => {
    expect(nextFromLinkHeader('<https://a/1?page=1>; rel="prev", <https://a/1?page=3>; rel="next", <https://a/1?page=9>; rel="last"')).toBe("https://a/1?page=3");
    expect(nextFromLinkHeader('<https://a/1?page=9>; rel="last"')).toBeUndefined();
    expect(nextFromLinkHeader(undefined)).toBeUndefined();
    expect(nextFromLinkHeader("")).toBeUndefined();
  });
});
