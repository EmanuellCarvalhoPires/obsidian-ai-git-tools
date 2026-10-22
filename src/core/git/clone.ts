// git_clone: `git clone [--branch b] [--depth n] -- <url> <destino>`. The URL must be on github.com
// or bitbucket.org (https or ssh with the `git` user), without a password; the destination is an
// absolute path that does not exist yet and lies inside an allowed folder.
import { realpath as fsRealpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, parse as parsePath } from "node:path";
import { maskCredentials } from "../git-runner";
import { GuardError, assertRefName, rejectForbiddenFlags } from "../guards";
import type { GitRunner, ProjectLookup } from "../ports";
import { isInside, normalizePathKey } from "../repo-resolver";
import { currentBranch, headHash } from "./revision";

export const CLONE_HOSTS = ["github.com", "bitbucket.org"] as const;
export const CLONE_MAX_DEPTH = 100_000;

export interface CloneUrl {
  /** The URL as given, trimmed. */
  url: string;
  host: (typeof CLONE_HOSTS)[number];
  provider: "github" | "bitbucket";
  owner: string;
  slug: string;
}

const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SCP_LIKE = /^git@([^:/\s]+):([^\s]+)$/;

function hostOf(name: string): (typeof CLONE_HOSTS)[number] | undefined {
  const h = name.toLowerCase();
  return (CLONE_HOSTS as readonly string[]).includes(h) ? (h as (typeof CLONE_HOSTS)[number]) : undefined;
}

function repoSegments(path: string, url: string): { owner: string; slug: string } {
  const parts = path.replace(/^\/+/, "").split("/");
  if (parts.length !== 2) throw new GuardError(`A URL tem de apontar para dono/repositório: ${maskCredentials(url)}`);
  const owner = parts[0] ?? "";
  const slug = (parts[1] ?? "").replace(/\.git$/i, "");
  if (!SEGMENT.test(owner) || !SEGMENT.test(slug) || owner === ".." || slug === "..") {
    throw new GuardError(`A URL tem dono ou repositório inválido: ${maskCredentials(url)}`);
  }
  return { owner, slug };
}

/**
 * Accepts `https://github.com/o/r(.git)`, `https://usuario@bitbucket.org/ws/r.git` (user without
 * password), `git@github.com:o/r.git` and `ssh://git@bitbucket.org/ws/r.git`. Any other host,
 * scheme, password, port, query or fragment is refused. Never reaches git when it throws.
 */
export function validateCloneUrl(input: string): CloneUrl {
  if (typeof input !== "string" || input.trim() === "") throw new GuardError("Informe a URL do repositório.");
  const url = input.trim();
  // eslint-disable-next-line no-control-regex -- control characters in a URL are an attack, not a typo
  if (/[\s\u0000-\u001f\u007f\\]/.test(url)) throw new GuardError("A URL não pode ter espaços, barra invertida nem caracteres de controle.");
  if (url.startsWith("-")) throw new GuardError("A URL não pode começar com \"-\".");

  const scp = SCP_LIKE.exec(url);
  if (scp) {
    const host = hostOf(scp[1] ?? "");
    if (!host) throw new GuardError(`Host não permitido: ${scp[1] ?? ""} (só github.com e bitbucket.org).`);
    return { url, host, provider: host === "github.com" ? "github" : "bitbucket", ...repoSegments(scp[2] ?? "", url) };
  }

  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new GuardError("URL inválida. Use https://github.com/dono/repo.git, git@github.com:dono/repo.git ou o equivalente do bitbucket.org.");
  }
  if (u.protocol !== "https:" && u.protocol !== "ssh:") throw new GuardError(`Protocolo não permitido: ${u.protocol.replace(":", "")} (use https ou ssh).`);
  const host = hostOf(u.hostname);
  if (!host) throw new GuardError(`Host não permitido: ${u.hostname} (só github.com e bitbucket.org).`);
  if (u.password !== "") throw new GuardError("A URL não pode conter senha. Use a autenticação do git ou SSH.");
  if (u.protocol === "ssh:" && u.username !== "git") throw new GuardError("Na URL ssh o usuário tem de ser git.");
  if (u.port !== "") throw new GuardError("A URL não pode ter porta.");
  if (u.search !== "" || u.hash !== "") throw new GuardError("A URL não pode ter parâmetros nem fragmento.");
  return { url, host, provider: host === "github.com" ? "github" : "bitbucket", ...repoSegments(u.pathname, url) };
}

const nativeRealpath = (path: string): Promise<string> => fsRealpath(path);

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Folders where a clone may be created: the extra allowed folders and the parent folder of each
 * project clone (the folder where the user keeps the clones).
 */
export async function cloneAllowedRoots(
  projects: ProjectLookup,
  allowedFolders: string[],
  allowAnyFolder = false,
  destino = "",
): Promise<string[]> {
  if (allowAnyFolder && isAbsolute(destino)) return [parsePath(destino).root];
  const roots = allowedFolders.filter((f) => f.trim() !== "" && isAbsolute(f.trim())).map((f) => f.trim());
  for (const p of await projects.list()) {
    if (p.clonePath && isAbsolute(p.clonePath)) roots.push(dirname(p.clonePath));
  }
  return roots;
}

export interface CloneDestination {
  /** Absolute destination (real path of the existing parent + the new name). */
  destino: string;
  /** Closest existing folder above the destination: where git runs. */
  cwd: string;
}

/**
 * Checks the destination: absolute, no "..", does not exist, and inside (never equal to) an
 * allowed folder after resolving links of the closest existing ancestor.
 */
export async function assertCloneDestination(
  destino: string,
  allowedRoots: string[],
  realpath: (path: string) => Promise<string> = nativeRealpath,
): Promise<CloneDestination> {
  if (typeof destino !== "string" || destino.trim() === "") throw new GuardError("Informe o destino do clone.");
  const dest = destino.trim();
  if (dest.includes("\0")) throw new GuardError("O destino não pode ter caractere nulo.");
  if (!isAbsolute(dest)) throw new GuardError(`O destino tem de ser um caminho absoluto: ${dest}`);
  if (dest.split(/[\\/]/).some((seg) => seg === "..")) throw new GuardError(`O destino não pode conter "..": ${dest}`);
  if (await exists(dest)) throw new GuardError(`O destino já existe: ${dest}`);

  // closest existing ancestor, remembering what is still to be created
  const pending: string[] = [];
  let ancestor = dest.replace(/[\\/]+$/, "");
  while (!(await exists(ancestor))) {
    const parent = dirname(ancestor);
    if (parent === ancestor) throw new GuardError(`O destino não tem uma pasta existente acima: ${dest}`);
    pending.unshift(basename(ancestor));
    ancestor = parent;
  }
  const realAncestor = await realpath(ancestor);
  const real = pending.length > 0 ? join(realAncestor, ...pending) : realAncestor;

  let allowed = false;
  for (const root of allowedRoots) {
    let realRoot: string;
    try {
      realRoot = await realpath(root);
    } catch {
      continue; // folder missing on disk
    }
    if (isInside(realRoot, real) && normalizePathKey(realRoot) !== normalizePathKey(real)) {
      allowed = true;
      break;
    }
  }
  if (!allowed) throw new GuardError(`O destino está fora das pastas permitidas (a pasta dos clones dos projetos e as pastas permitidas): ${dest}`);
  return { destino: real, cwd: realAncestor };
}

export interface CloneArgs {
  url: string;
  destino: string;
  branch?: string;
  profundidade?: number;
}

export interface CloneContext {
  allowedRoots: string[];
  /** Replaces the host check. Only for tests that clone a local bare repository. */
  validateUrl?: (url: string) => string;
  realpath?: (path: string) => Promise<string>;
}

export interface CloneResult {
  /** URL with credentials masked. */
  url: string;
  destino: string;
  branch: string | undefined;
  hash: string | undefined;
  profundidade: number | undefined;
}

export async function gitClone(git: GitRunner, args: CloneArgs, ctx: CloneContext): Promise<CloneResult> {
  const url = ctx.validateUrl ? ctx.validateUrl(args.url) : validateCloneUrl(args.url).url;
  if (args.profundidade !== undefined && (!Number.isInteger(args.profundidade) || args.profundidade < 1 || args.profundidade > CLONE_MAX_DEPTH)) {
    throw new GuardError(`profundidade tem de ser um inteiro entre 1 e ${CLONE_MAX_DEPTH}.`);
  }
  const dest = await assertCloneDestination(args.destino, ctx.allowedRoots, ctx.realpath);
  if (args.branch !== undefined) await assertRefName(args.branch, { git, cwd: dest.cwd });

  const argv = ["clone"];
  if (args.branch !== undefined) argv.push("--branch", args.branch);
  if (args.profundidade !== undefined) argv.push("--depth", String(args.profundidade));
  argv.push("--", url, dest.destino);
  rejectForbiddenFlags(argv);
  await git(dest.cwd, argv); // a GitError already carries the masked text
  return {
    url: maskCredentials(url),
    destino: dest.destino,
    branch: await currentBranch(git, dest.destino),
    hash: await headHash(git, dest.destino),
    profundidade: args.profundidade,
  };
}
