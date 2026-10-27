// git_status with remoto=true: the remotes of a repository, the provider behind them and whether a secret is
// configured for it. Never returns a secret value, and every URL has its credentials masked.
import { maskCredentials } from "../git-runner";
import type { GitRunner } from "../ports";
import { parseRemoteUrl } from "../providers/provider";
import type { ProviderId } from "../providers/provider";

export interface RemoteEntry {
  nome: string;
  /** Fetch URL with credentials masked. */
  url_fetch: string;
  url_push: string;
  provedor?: ProviderId;
  /** GitHub owner or Bitbucket workspace. */
  dono?: string;
  slug?: string;
}

export interface RemoteInfoResult {
  remotos: RemoteEntry[];
  /** `origin`, or the first remote. */
  principal: string | undefined;
  provedor: ProviderId | undefined;
  dono: string | undefined;
  slug: string | undefined;
  /** Default branch of the main remote (from refs/remotes/<remote>/HEAD); undefined when unknown. */
  branchPadrao: string | undefined;
  /** True when the plugin has a secret chosen for the provider of the main remote. */
  secretConfigurada: boolean;
}

export interface RemoteInfoOptions {
  /** Whether a secret name is set for each provider (never the name itself, never the value). */
  secrets: Record<ProviderId, boolean>;
}

/** Parses `git remote -v`: `name<TAB>url (fetch|push)`. URLs are kept raw here; the caller masks them. */
export function parseRemoteList(raw: string): { nome: string; fetch: string; push: string }[] {
  const map = new Map<string, { nome: string; fetch: string; push: string }>();
  for (const line of raw.split(/\r?\n/)) {
    const m = /^(\S+)\s+(.+?)\s+\((fetch|push)\)\s*$/.exec(line.trim());
    if (!m) continue;
    const nome = m[1] ?? "";
    const item = map.get(nome) ?? { nome, fetch: "", push: "" };
    if (m[3] === "fetch") item.fetch = m[2] ?? "";
    else item.push = m[2] ?? "";
    map.set(nome, item);
  }
  return [...map.values()];
}

export async function gitRemoteInfo(git: GitRunner, root: string, options: RemoteInfoOptions): Promise<RemoteInfoResult> {
  const list = parseRemoteList(await git(root, ["remote", "-v"]));
  const remotos: RemoteEntry[] = list.map((r) => {
    const ref = parseRemoteUrl(r.fetch !== "" ? r.fetch : r.push);
    const entry: RemoteEntry = { nome: r.nome, url_fetch: maskCredentials(r.fetch), url_push: maskCredentials(r.push !== "" ? r.push : r.fetch) };
    if (ref) {
      entry.provedor = ref.provider;
      entry.dono = ref.owner;
      entry.slug = ref.slug;
    }
    return entry;
  });
  const principal = remotos.find((r) => r.nome === "origin") ?? remotos[0];

  let branchPadrao: string | undefined;
  if (principal && !principal.nome.startsWith("-")) {
    try {
      const sym = (await git(root, ["symbolic-ref", `refs/remotes/${principal.nome}/HEAD`])).trim();
      const prefix = `refs/remotes/${principal.nome}/`;
      if (sym.startsWith(prefix)) branchPadrao = sym.slice(prefix.length);
    } catch {
      // the remote HEAD is only known after a clone or `git remote set-head`
    }
  }

  const provedor = principal?.provedor;
  return {
    remotos,
    principal: principal?.nome,
    provedor,
    dono: principal?.dono,
    slug: principal?.slug,
    branchPadrao,
    secretConfigurada: provedor !== undefined && options.secrets[provedor],
  };
}
