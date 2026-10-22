// Pagination of the two providers: Bitbucket answers `{ values, next }` and GitHub answers an
// array (or an object with a list) plus a `Link: <url>; rel="next"` header. Both stop after
// `maxPages` pages and say so with `truncado`. The next page is only followed on the same https
// host as the first one, so the Authorization header never goes to another host.
import type { SecureHttp } from "../ports";
import { assertOk, RemoteError } from "./errors";
import { parseJson } from "./http";
import type { Lista, ProviderId } from "./provider";

export const DEFAULT_MAX_PAGES = 5;

export interface PageOptions {
  /** Headers of every page (the Authorization and the Accept of the provider). */
  headers?: Record<string, string>;
  /** Default 5. */
  maxPages?: number;
  /** Stops as soon as this many items were read (the list is cut to it). */
  maxItems?: number;
  /** GitHub only: takes the array from an object body (e.g. `body.workflow_runs`). Default: the body itself. */
  pick?: (body: unknown) => unknown;
  /** Applied to provider text that reaches an error. */
  redact?: (text: string) => string;
}

/** Same host and https as the first URL, or a RemoteError. */
function sameHost(first: string, next: string): string {
  let a: URL;
  let b: URL;
  try {
    a = new URL(first);
    b = new URL(next, first);
  } catch {
    throw new RemoteError("resposta_invalida", "O provedor devolveu um link de próxima página inválido.");
  }
  if (b.protocol !== "https:" || b.host !== a.host) {
    throw new RemoteError("resposta_invalida", "O provedor devolveu um link de próxima página para outro host; a leitura foi interrompida.");
  }
  return b.toString();
}

/** The `rel="next"` URL of a GitHub `Link` header, or undefined. */
export function nextFromLinkHeader(link: string | undefined): string | undefined {
  if (link === undefined || link === "") return undefined;
  for (const m of link.matchAll(/<([^>]*)>\s*;\s*rel\s*=\s*"?([A-Za-z]+)"?/g)) {
    if ((m[2] ?? "").toLowerCase() === "next" && (m[1] ?? "") !== "") return m[1];
  }
  return undefined;
}

async function paginate<T>(
  provedor: ProviderId,
  http: SecureHttp,
  url: string,
  opts: PageOptions,
  read: (body: unknown) => T[],
  nextOf: (body: unknown, headers: Record<string, string>) => string | undefined,
): Promise<Lista<T>> {
  const maxPages = Math.max(1, opts.maxPages ?? DEFAULT_MAX_PAGES);
  const itens: T[] = [];
  let next: string | undefined = url;
  let pages = 0;
  while (next !== undefined && pages < maxPages) {
    const res = assertOk(provedor, await http({ method: "GET", url: next, headers: { ...opts.headers } }), opts.redact);
    const body = parseJson(res);
    itens.push(...read(body));
    pages += 1;
    if (opts.maxItems !== undefined && itens.length >= opts.maxItems) {
      return { itens: itens.slice(0, opts.maxItems), truncado: itens.length > opts.maxItems || nextOf(body, res.headers) !== undefined };
    }
    const link = nextOf(body, res.headers);
    next = link === undefined ? undefined : sameHost(url, link);
  }
  return { itens, truncado: next !== undefined };
}

/** Bitbucket: follows `next` of `{ values: [...], next }`. */
export function paginateBitbucket<T = unknown>(http: SecureHttp, url: string, opts: PageOptions = {}): Promise<Lista<T>> {
  return paginate<T>(
    "bitbucket",
    http,
    url,
    opts,
    (body) => {
      const values = typeof body === "object" && body !== null ? (body as { values?: unknown }).values : undefined;
      return Array.isArray(values) ? (values as T[]) : [];
    },
    (body) => {
      const next = typeof body === "object" && body !== null ? (body as { next?: unknown }).next : undefined;
      return typeof next === "string" && next !== "" ? next : undefined;
    },
  );
}

/** GitHub: follows `Link rel="next"`; the items are the body (an array) or what `opts.pick` takes from it. */
export function paginateGithub<T = unknown>(http: SecureHttp, url: string, opts: PageOptions = {}): Promise<Lista<T>> {
  return paginate<T>(
    "github",
    http,
    url,
    opts,
    (body) => {
      const picked = opts.pick ? opts.pick(body) : body;
      return Array.isArray(picked) ? (picked as T[]) : [];
    },
    (_body, headers) => nextFromLinkHeader(headers.link),
  );
}
