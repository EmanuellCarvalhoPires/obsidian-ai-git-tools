// Decides which repositories the tools may touch. The input is a project name or an absolute
// path; the real path (symbolic links and junctions resolved) must be inside a project clone or
// inside one of the allowed folders, and git must confirm it is a repository.
import { realpath as fsRealpath } from "node:fs";
import { isAbsolute } from "node:path";
import { GuardError } from "./guards";
import { maskCredentials } from "./git-runner";
import { parseRemoteUrl } from "./providers/provider";
import type { RemoteRef } from "./providers/provider";
import type { GitRunner, ProjectLookup } from "./ports";

export class RepoError extends Error {
  readonly codigo = "repo_nao_permitido";
  constructor(message: string) {
    super(message);
    this.name = "RepoError";
  }
}

export interface ResolvedRemote {
  nome: string;
  /** Remote URL with credentials masked. */
  url: string;
  /** Present when the host is GitHub or Bitbucket. */
  ref?: RemoteRef;
}

export interface ResolvedRepo {
  /** Real, absolute top level of the repository (native separators). */
  root: string;
  /** Project note that owns the clone, when there is one. */
  projeto?: string;
  /** Remote `origin` (or the first remote). */
  remoto?: ResolvedRemote;
}

export interface RepoResolverDeps {
  git: GitRunner;
  projects: ProjectLookup;
  /** Reads the allowed folders at call time (the setting may change). */
  allowedFolders: () => string[];
  /** When true, any folder is accepted; git still has to confirm it is a repository. */
  allowAnyFolder?: () => boolean;
  /** Real path of an existing path; defaults to the native `realpath`. Rejects when missing. */
  realpath?: (path: string) => Promise<string>;
  /** Short-lived cache of the remote of each repository. */
  remoteCache?: RemoteCache;
}

/** Short-lived cache of the remote of a repository, keyed by its real root. `null` means "no remote". */
export interface RemoteCache {
  get(root: string): ResolvedRemote | null | undefined;
  set(root: string, value: ResolvedRemote | undefined): void;
  forget(root: string): void;
}

export function createRemoteCache(ttlMs = 30_000, now: () => number = Date.now): RemoteCache {
  const entries = new Map<string, { at: number; value: ResolvedRemote | null }>();
  return {
    get(root) {
      const key = normalizePathKey(root);
      const hit = entries.get(key);
      if (!hit) return undefined;
      if (now() - hit.at >= ttlMs) {
        entries.delete(key);
        return undefined;
      }
      return hit.value;
    },
    set(root, value) {
      entries.set(normalizePathKey(root), { at: now(), value: value ?? null });
    },
    forget(root) {
      entries.delete(normalizePathKey(root));
    },
  };
}

/** Lower case, "/" separators, no trailing slash: how paths are compared (Windows is case-insensitive). */
export function normalizePathKey(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

/** True when child is the folder itself or inside it. */
export function isInside(parent: string, child: string): boolean {
  const p = normalizePathKey(parent);
  const c = normalizePathKey(child);
  return c === p || c.startsWith(`${p}/`);
}

const nativeRealpath = (path: string): Promise<string> =>
  new Promise((resolve, reject) => {
    fsRealpath.native(path, (err, resolved) => (err ? reject(err) : resolve(resolved)));
  });

function looksLikePath(input: string): boolean {
  return isAbsolute(input) || /[\\/]/.test(input) || /^[a-zA-Z]:/.test(input);
}

export async function resolveRepo(input: string, deps: RepoResolverDeps): Promise<ResolvedRepo> {
  const real = deps.realpath ?? nativeRealpath;
  const text = typeof input === "string" ? input.trim() : "";
  if (text === "") throw new GuardError("Informe o projeto ou o caminho do repositório.");

  const all = await deps.projects.list();

  let candidate: string;
  let projectName: string | undefined;
  if (looksLikePath(text)) {
    if (!isAbsolute(text)) throw new RepoError(`O caminho tem de ser absoluto: ${text}`);
    if (text.split(/[\\/]/).some((seg) => seg === "..")) throw new RepoError(`O caminho não pode conter "..": ${text}`);
    candidate = text;
  } else {
    const project = all.find((p) => p.name.toLowerCase() === text.toLowerCase());
    if (!project) throw new RepoError(`Projeto não encontrado: ${text}`);
    if (!project.clonePath) throw new RepoError(`O projeto ${project.name} não tem clone local na nota.`);
    projectName = project.name;
    candidate = project.clonePath;
  }

  let realCandidate: string;
  try {
    realCandidate = await real(candidate);
  } catch {
    throw new RepoError(`O caminho não existe: ${candidate}`);
  }

  // Allowed roots: the clones of the projects and the extra folders (all with real paths).
  const cloneRoots = await Promise.all(
    all.map(async (p) => {
      if (!p.clonePath) return undefined;
      try {
        return { path: await real(p.clonePath), project: p.name };
      } catch {
        // clone missing on disk: cannot grant anything
        return undefined;
      }
    }),
  );
  const folderRoots = await Promise.all(
    deps.allowedFolders().map(async (folder) => {
      const trimmed = folder.trim();
      if (trimmed === "" || !isAbsolute(trimmed)) return undefined;
      try {
        return { path: await real(trimmed) };
      } catch {
        // folder missing on disk
        return undefined;
      }
    }),
  );
  const roots: { path: string; project?: string }[] = [];
  for (const r of cloneRoots) {
    if (r !== undefined) roots.push(r);
  }
  for (const r of folderRoots) {
    if (r !== undefined) roots.push(r);
  }

  const anyFolder = deps.allowAnyFolder?.() ?? false;
  if (!anyFolder && !roots.some((r) => isInside(r.path, realCandidate))) {
    throw new RepoError(`O caminho está fora dos projetos e das pastas permitidas: ${candidate}`);
  }

  let top: string;
  try {
    top = (await deps.git(realCandidate, ["rev-parse", "--show-toplevel"])).trim();
  } catch {
    throw new RepoError(`Não é um repositório git: ${candidate}`);
  }
  if (top === "") throw new RepoError(`Não é um repositório git: ${candidate}`);
  let root: string;
  try {
    root = await real(top);
  } catch {
    throw new RepoError(`Repositório inacessível: ${top}`);
  }
  // The top level can be above the folder that was granted (a folder inside a bigger repository).
  const owners = roots.filter((r) => isInside(r.path, root));
  if (!anyFolder && owners.length === 0) {
    throw new RepoError(`A raiz do repositório está fora das pastas permitidas: ${root}`);
  }

  const resolved: ResolvedRepo = { root };
  const owner = projectName ?? owners.find((r) => r.project !== undefined)?.project;
  if (owner !== undefined) resolved.projeto = owner;
  const cached = deps.remoteCache?.get(root);
  let remoto: ResolvedRemote | undefined;
  if (cached !== undefined) remoto = cached ?? undefined;
  else {
    remoto = await readRemote(deps.git, root);
    deps.remoteCache?.set(root, remoto);
  }
  if (remoto) resolved.remoto = remoto;
  return resolved;
}

export async function readRemote(git: GitRunner, root: string): Promise<ResolvedRemote | undefined> {
  try {
    const names = (await git(root, ["remote"])).split(/\r?\n/).map((s) => s.trim()).filter((s) => s !== "");
    const nome = names.includes("origin") ? "origin" : names[0];
    if (!nome) return undefined;
    const url = (await git(root, ["remote", "get-url", nome])).trim();
    const out: ResolvedRemote = { nome, url: maskCredentials(url) };
    const ref = parseRemoteUrl(url);
    if (ref) out.ref = ref;
    return out;
  } catch {
    return undefined;
  }
}
