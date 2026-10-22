// Guards against dangerous arguments. They run before git is called: a refused argument never
// reaches the executor. All failures carry the code `argumento_invalido`.
import type { GitRunner } from "./ports";

export class GuardError extends Error {
  readonly codigo = "argumento_invalido";
  constructor(message: string) {
    super(message);
    this.name = "GuardError";
  }
}

// ---------------------------------------------------------------------------
// Reference names
// ---------------------------------------------------------------------------

// eslint-disable-next-line no-control-regex -- control characters are exactly what a ref name must not have
const REF_FORBIDDEN_CHARS = /[\s~^:?*[\\\u0000-\u001f\u007f]/;

/** Static check of a branch, tag or remote ref name (no git involved). */
export function assertRefNameSyntax(name: string): void {
  if (typeof name !== "string" || name === "") throw new GuardError("Nome de referência vazio.");
  if (name.length > 255) throw new GuardError("Nome de referência longo demais.");
  if (name.startsWith("-")) throw new GuardError(`Nome de referência não pode começar com "-": ${name}`);
  if (name === "@") throw new GuardError('Nome de referência inválido: "@".');
  if (name.includes("..")) throw new GuardError(`Nome de referência não pode conter "..": ${name}`);
  if (name.includes("@{")) throw new GuardError(`Nome de referência não pode conter "@{": ${name}`);
  if (REF_FORBIDDEN_CHARS.test(name)) throw new GuardError(`Nome de referência com caractere proibido: ${name}`);
  if (name.startsWith("/") || name.endsWith("/") || name.includes("//")) throw new GuardError(`Nome de referência com "/" inválida: ${name}`);
  if (name.endsWith(".") || name.endsWith(".lock")) throw new GuardError(`Nome de referência não pode terminar com "." ou ".lock": ${name}`);
  if (name.split("/").some((part) => part.startsWith(".") || part.endsWith(".lock"))) {
    throw new GuardError(`Nome de referência com componente inválido: ${name}`);
  }
}

/**
 * Syntax check plus `git check-ref-format --branch` when a runner is given.
 * Throws GuardError; the git call only happens for names that passed the static check.
 */
export async function assertRefName(name: string, ctx?: { git: GitRunner; cwd: string }): Promise<void> {
  assertRefNameSyntax(name);
  if (!ctx) return;
  try {
    await ctx.git(ctx.cwd, ["check-ref-format", "--branch", name]);
  } catch {
    throw new GuardError(`Nome de referência recusado pelo git: ${name}`);
  }
}

/** `src`, `src:dst`, `refs/tags/x`. Refuses forced (`+`) and deleting (`:ref`) refspecs. */
export function assertRefspec(spec: string): void {
  if (typeof spec !== "string" || spec === "") throw new GuardError("Refspec vazio.");
  if (spec.startsWith("+")) throw new GuardError(`Refspec forçado (+) não é permitido: ${spec}`);
  if (spec.startsWith(":")) throw new GuardError(`Refspec que apaga referência remota não é permitido: ${spec}`);
  const parts = spec.split(":");
  if (parts.length > 2) throw new GuardError(`Refspec inválido: ${spec}`);
  for (const part of parts) {
    if (part === "") throw new GuardError(`Refspec com lado vazio: ${spec}`);
    if (part.startsWith("+")) throw new GuardError(`Refspec forçado (+) não é permitido: ${spec}`);
    assertRefNameSyntax(part);
  }
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/**
 * Validates paths for a pathspec: relative, without "..", not starting with "-" or ":" (git
 * pathspec magic). Returns the paths unchanged.
 */
export function assertPathspec(paths: string[]): string[] {
  if (!Array.isArray(paths) || paths.length === 0) throw new GuardError("Nenhum caminho informado.");
  for (const p of paths) {
    if (typeof p !== "string" || p.trim() === "") throw new GuardError("Caminho vazio.");
    if (p.includes("\u0000")) throw new GuardError("Caminho com caractere nulo.");
    if (p.startsWith("-")) throw new GuardError(`Caminho não pode começar com "-": ${p}`);
    if (p.startsWith(":")) throw new GuardError(`Caminho não pode começar com ":" (magia de pathspec): ${p}`);
    if (p.startsWith("/") || p.startsWith("\\") || /^[a-zA-Z]:/.test(p)) throw new GuardError(`Caminho tem de ser relativo: ${p}`);
    if (p.split(/[\\/]/).some((seg) => seg === "..")) throw new GuardError(`Caminho não pode conter "..": ${p}`);
  }
  return paths;
}

/** Validates the paths and returns the argument tail `["--", ...paths]` (always after `--`). */
export function pathspecArgs(paths: string[]): string[] {
  return ["--", ...assertPathspec(paths)];
}

const SENSITIVE_BASENAME = [
  /^\.env/i,
  /\.pem$/i,
  /\.key$/i,
  /\.p12$/i,
  /\.pfx$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)/i,
  /^\.deploy-target$/i,
  /^data\.json$/i,
];

/** Files that must not go to a repository without an explicit confirmation. */
export function isSensitivePath(path: string): boolean {
  const base = path.replace(/\\/g, "/").split("/").pop() ?? "";
  return SENSITIVE_BASENAME.some((re) => re.test(base));
}

// ---------------------------------------------------------------------------
// Flags
// ---------------------------------------------------------------------------

const FORBIDDEN_LONG = [
  "force",
  "force-with-lease",
  "force-if-includes",
  "delete",
  "hard",
  "mirror",
  "prune",
  "amend",
  "no-verify",
  "rebase",
  "interactive",
];
const FORBIDDEN_SHORT = ["f", "d", "D", "i"];

/**
 * Refuses the flags the tools must never pass (force, delete, reset --hard, amend, no-verify,
 * rebase, interactive). Also catches `--flag=value`, unambiguous abbreviations that git would
 * accept (`--forc`, `--del`) and short clusters (`-fu`, `-df`). Arguments after `--` are paths.
 */
export function rejectForbiddenFlags(args: string[]): void {
  for (const arg of args) {
    if (arg === "--") return;
    if (arg.startsWith("--")) {
      const name = (arg.slice(2).split("=")[0] ?? "").toLowerCase();
      if (name.length >= 2 && FORBIDDEN_LONG.some((f) => f.startsWith(name))) {
        throw new GuardError(`Flag proibida: ${arg}`);
      }
      continue;
    }
    if (/^-[A-Za-z]+$/.test(arg) && [...arg.slice(1)].some((ch) => FORBIDDEN_SHORT.includes(ch))) {
      throw new GuardError(`Flag proibida: ${arg}`);
    }
  }
}
