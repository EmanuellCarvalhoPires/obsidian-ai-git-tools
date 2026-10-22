// git_fetch: `git fetch <remote> --tags`. Never prunes. Reports which remote branches and tags are
// new or moved by comparing the references before and after (git prints the summary on stderr,
// which the runner does not return on success).
import { rejectForbiddenFlags } from "../guards";
import type { GitRunner } from "../ports";
import { assertRemoteName } from "./revision";

export interface FetchArgs {
  /** Defaults to origin. */
  remoto?: string;
}

export interface FetchResult {
  remoto: string;
  /** Remote branches and tags that did not exist before, e.g. `origin/feature-x`, `tag v1.0`. */
  novas: string[];
  /** References that moved to another commit. */
  atualizadas: string[];
}

async function snapshot(git: GitRunner, root: string, remoto: string): Promise<Map<string, string>> {
  const raw = await git(root, ["for-each-ref", "--format=%(refname)%09%(objectname)", `refs/remotes/${remoto}`, "refs/tags"]);
  const map = new Map<string, string>();
  for (const line of raw.split(/\r?\n/)) {
    const [name, oid] = line.split("\t");
    if (name && oid) map.set(name, oid);
  }
  return map;
}

function label(ref: string): string {
  if (ref.startsWith("refs/remotes/")) return ref.slice("refs/remotes/".length);
  if (ref.startsWith("refs/tags/")) return `tag ${ref.slice("refs/tags/".length)}`;
  return ref;
}

export async function gitFetch(git: GitRunner, root: string, args: FetchArgs = {}): Promise<FetchResult> {
  const remoto = await assertRemoteName(git, root, args.remoto ?? "origin");
  const before = await snapshot(git, root, remoto);
  const argv = ["fetch", remoto, "--tags"];
  rejectForbiddenFlags(argv);
  await git(root, argv);
  const after = await snapshot(git, root, remoto);
  const novas: string[] = [];
  const atualizadas: string[] = [];
  for (const [ref, oid] of after) {
    const old = before.get(ref);
    if (old === undefined) novas.push(label(ref));
    else if (old !== oid) atualizadas.push(label(ref));
  }
  return { remoto, novas, atualizadas };
}
