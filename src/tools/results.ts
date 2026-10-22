// Standard result of every tool: `ok` and `fail` build the HubToolResult of the contract, and
// `fromError` turns the errors of the core layer into the right `fail`.
import { GitError } from "../core/git-runner";
import { GuardError } from "../core/guards";
import { RepoError } from "../core/repo-resolver";
import type { HubToolResult } from "../ecosystem/types";

/** Error codes of the contract. `provedor_http_<status>` is built with `httpCode`. */
export type ErrorCode =
  | "repo_nao_permitido"
  | "argumento_invalido"
  | "git_falhou"
  | "conflito"
  | "nada_a_commitar"
  | "secret_nao_configurada"
  | "aprovacao_divergente"
  | "servico_secrets_ausente"
  | "cofre_bloqueado"
  | "politica_secret"
  | "rede"
  | "resposta_invalida"
  | "merge_em_andamento"
  | `provedor_http_${number}`;

export function httpCode(status: number): `provedor_http_${number}` {
  return `provedor_http_${status}`;
}

/** Hint of a failure: plain text, or a structure such as `{ mcp: "Bitbucket", usar: "search_vault_tools + run_vault_tool" }`. */
export type Dica = string | Record<string, unknown>;

export interface OkExtras {
  /** Path of the event note the call created. */
  nota?: string;
  avisos?: string[];
}

/** Success: `texto` is the Portuguese summary, `dados` goes to structuredContent next to `ok: true`. */
export function ok(texto: string, dados: Record<string, unknown> = {}, extras: OkExtras = {}): HubToolResult {
  const structured: Record<string, unknown> = { ok: true, ...dados };
  if (extras.nota !== undefined) structured.nota = extras.nota;
  if (extras.avisos !== undefined && extras.avisos.length > 0) structured.avisos = extras.avisos;
  return { content: [{ type: "text", text: texto }], structuredContent: structured };
}

/** Failure with a contract code. */
export function fail(codigo: ErrorCode, mensagem: string, dica?: Dica): HubToolResult {
  const structured: Record<string, unknown> = { ok: false, codigo, mensagem };
  if (dica !== undefined) structured.dica = dica;
  return { isError: true, content: [{ type: "text", text: mensagem }], structuredContent: structured };
}

/**
 * Converts what the core layer throws. GuardError -> argumento_invalido, RepoError ->
 * repo_nao_permitido, GitError -> git_falhou (its text is already masked). Anything else is
 * reported as git_falhou with its message. `redact` (the Environment Keys `redact`) runs last.
 */
export function fromError(err: unknown, redact?: (text: string) => string): HubToolResult {
  const clean = (text: string): string => (redact ? redact(text) : text);
  if (err instanceof GuardError) return fail("argumento_invalido", clean(err.message));
  if (err instanceof RepoError) return fail("repo_nao_permitido", clean(err.message));
  if (err instanceof GitError) return fail("git_falhou", clean(err.message));
  return fail("git_falhou", clean(err instanceof Error ? err.message : String(err)));
}
