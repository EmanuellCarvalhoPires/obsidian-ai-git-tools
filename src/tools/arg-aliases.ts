// Argument names that agents guess (path for caminho, projeto for repo, ...) are mapped to the
// names the schema of the tool declares, in one place, before the handler runs. An argument that
// maps to nothing is still an error, and the message lists the accepted ones.
import { GuardError } from "../core/guards";
import type { JsonSchema } from "./schemas";

type Args = Record<string, unknown>;

/** Lower case, no accents, camelCase and "-" turned into "_". */
export function normalizeKey(key: string): string {
  return key
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[-\s]+/g, "_")
    .toLowerCase();
}

/** Synonyms by meaning. The first name of the schema that is in a group is the target. */
// One group for a single file and for a list of files: the shape is adjusted after the name is chosen.
const FILE_ONE = ["caminho", "caminhos", "path", "paths", "arquivo", "arquivos", "file", "files", "filepath", "file_path"];
const REPO = ["repo", "repositorio", "repository", "projeto", "project", "pasta", "folder", "diretorio", "directory", "dir", "cwd", "path", "caminho", "local"];

const GROUPS: string[][] = [
  FILE_ONE,
  REPO,
  ["branch", "ramo", "branch_name", "nome_branch"],
  ["ref", "referencia", "reference", "revisao", "rev"],
  ["commit", "sha", "hash", "commit_hash", "commit_sha"],
  ["numero", "number", "num", "pr", "pr_number", "pr_id", "numero_pr", "pr_numero"],
  ["mensagem", "message", "msg"],
  ["titulo", "title"],
  ["descricao", "description", "desc"],
  ["texto", "text", "comentario", "comment", "body"],
  ["origem", "source", "from", "head", "source_branch"],
  ["destino", "destination", "dest", "base", "target_branch", "destination_branch"],
  ["alvo", "target"],
  ["remoto", "remote"],
  ["limite", "limit"],
  ["estrategia", "strategy", "merge_strategy"],
  ["max_bytes", "maxbytes", "max_bytes_diff"],
  ["incluir", "include"],
  ["contexto", "context"],
  ["nome", "name"],
  ["estado", "state"],
  ["definir_upstream", "set_upstream"],
  ["pipeline", "pipeline_id", "pipeline_numero", "numero_pipeline", "build", "build_number", "run", "run_id"],
  ["timeout_segundos", "timeout", "timeout_s", "timeout_seconds", "tempo_limite"],
  ["intervalo_segundos", "intervalo", "interval", "intervalo_s", "interval_seconds", "poll_interval"],
];

const GROUP_KEYS: string[][] = GROUPS.map((g) => g.map(normalizeKey));

/** Schema names that hold a list of paths, and the ones that hold a single path. */
const PLURAL_TARGETS = new Set(["caminhos", "arquivos"]);
const SINGULAR_TARGETS = new Set(["caminho", "arquivo"]);
/** Meanings of "path" that are the repository, not a file of it. */
const REPO_ONLY = new Set(REPO.filter((r) => !FILE_ONE.includes(r)));

function isAbsolutePathText(value: unknown): boolean {
  return typeof value === "string" && (/^[a-zA-Z]:[\\/]/.test(value) || value.startsWith("/") || value.startsWith("\\\\"));
}

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Names the schema declares. */
export function knownArgs(schema: JsonSchema): string[] {
  return Object.keys((schema.properties as Record<string, unknown> | undefined) ?? {});
}

/** Candidate schema names for an unknown argument, in order of preference. */
function candidates(key: string, known: string[]): string[] {
  const n = normalizeKey(key);
  const direct = known.filter((k) => normalizeKey(k) === n);
  if (direct.length > 0) return direct;
  const out: string[] = [];
  GROUP_KEYS.forEach((group, i) => {
    if (!group.includes(n)) return;
    for (const member of GROUPS[i] ?? []) {
      if (known.includes(member) && !out.includes(member)) out.push(member);
    }
  });
  return out;
}

/**
 * Returns the arguments with the names of the schema (known names win over synonyms). Throws
 * GuardError for an argument that maps to nothing, listing the accepted ones.
 */
export function normalizeArgs(args: Args, schema: JsonSchema): Args {
  const known = knownArgs(schema);
  const out: Args = {};
  const rest: Array<[string, unknown]> = [];
  for (const [k, v] of Object.entries(args)) {
    if (known.includes(k)) out[k] = v;
    else rest.push([k, v]);
  }
  const unknown: string[] = [];
  for (const [key, value] of rest) {
    let options = candidates(key, known);
    if (options.length === 0) {
      unknown.push(key);
      continue;
    }
    // Several meanings (path: the repository or a file of it): keep the one that is still free.
    const free = options.filter((o) => out[o] === undefined || out[o] === null);
    if (free.length > 0) options = free;
    let target = options[0] ?? "";
    if (options.length > 1) {
      const repoTarget = options.find((o) => REPO_ONLY.has(o));
      const other = options.find((o) => o !== repoTarget);
      if (repoTarget !== undefined && other !== undefined) target = isAbsolutePathText(value) ? repoTarget : other;
    }
    let final = value;
    // caminho -> caminhos (and back) when the schema only has the other form.
    if (PLURAL_TARGETS.has(target) && typeof value === "string") final = [value];
    if (SINGULAR_TARGETS.has(target) && Array.isArray(value) && value.length === 1) final = value[0];
    if (out[target] !== undefined && out[target] !== null && !sameValue(out[target], final)) {
      throw new GuardError(`Os argumentos "${key}" e "${target}" são o mesmo parâmetro, com valores diferentes. Use só "${target}".`);
    }
    out[target] = final;
  }
  if (unknown.length > 0) {
    throw new GuardError(`Argumento desconhecido: ${unknown.join(", ")}. Argumentos aceitos: ${known.join(", ")}.`);
  }
  return out;
}
