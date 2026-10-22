// Errors of the provider layer (GitHub and Bitbucket): one RemoteError type with a stable code,
// the Portuguese messages of the HTTP statuses, the hints of the contract and the conversion to the
// standard failure of a tool. Nothing here knows a secret value: texts pass through `redact`.
import { maskCredentials } from "../git-runner";
import { fail, fromError, httpCode } from "../../tools/results";
import type { Dica } from "../../tools/results";
import type { HubToolResult } from "../../ecosystem/types";
import type { HttpResponse } from "../ports";
import type { ProviderId } from "./provider";

/**
 * Codes of a RemoteError. `secret_nao_configurada` and `provedor_http_<status>` are in the contract
 * of the tools; the others describe what can go wrong before or around the HTTP answer.
 */
export type RemoteErrorCode =
  | "secret_nao_configurada"
  | "servico_secrets_ausente"
  | "cofre_bloqueado"
  | "politica_secret"
  | "rede"
  | "resposta_invalida"
  | "argumento_invalido"
  | "merge_em_andamento"
  | `provedor_http_${number}`;

export interface RemoteErrorOptions {
  /** HTTP status, when the provider answered. */
  status?: number;
  dica?: Dica;
}

export class RemoteError extends Error {
  readonly codigo: RemoteErrorCode;
  readonly status: number | undefined;
  readonly mensagem: string;
  readonly dica: Dica | undefined;

  constructor(codigo: RemoteErrorCode, mensagem: string, opts: RemoteErrorOptions = {}) {
    super(mensagem);
    this.name = "RemoteError";
    this.codigo = codigo;
    this.mensagem = mensagem;
    this.status = opts.status;
    this.dica = opts.dica;
  }
}

/** Display name of a provider. */
export function nomeDoProvedor(provedor: ProviderId): string {
  return provedor === "github" ? "GitHub" : "Bitbucket";
}

export const DICA_CONFIGURAR_SECRET = "rode a skill configurar-ai-git-tools ou escolha a secret nas configurações do plugin";

/** No secret was chosen for the provider (decision D6: the secrets are optional). */
export function secretNaoConfigurada(provedor: ProviderId): RemoteError {
  return new RemoteError("secret_nao_configurada", `Nenhuma secret do ${nomeDoProvedor(provedor)} está configurada no AI Git Tools.`, {
    dica: DICA_CONFIGURAR_SECRET,
  });
}

/**
 * Hint for an operation the tools do not cover: Bitbucket has the notes of the Environment Keys
 * package; GitHub has no package, so the hint points to `http_request` with the bearer placeholder.
 */
export function foraDaLista(provedor: ProviderId, secretName?: string): Dica {
  if (provedor === "bitbucket") return { mcp: "Bitbucket", usar: "search_vault_tools + run_vault_tool" };
  const nome = secretName !== undefined && secretName !== "" ? secretName : "NOME";
  return { usar: "http_request", cabecalho: `Authorization: {{bearer:${nome}}}`, host: "api.github.com" };
}

/** Pulls the message the provider put in an error body (GitHub `message` and `errors`, Bitbucket `error.message`). */
export function providerMessage(body: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const o = parsed as Record<string, unknown>;
  const parts: string[] = [];
  const nested = o.error;
  if (typeof nested === "object" && nested !== null) {
    const m = (nested as Record<string, unknown>).message;
    if (typeof m === "string" && m !== "") parts.push(m);
    const detail = (nested as Record<string, unknown>).detail;
    if (typeof detail === "string" && detail !== "") parts.push(detail);
  } else if (typeof nested === "string" && nested !== "") {
    parts.push(nested);
  }
  if (typeof o.message === "string" && o.message !== "") parts.push(o.message);
  if (Array.isArray(o.errors)) {
    for (const e of o.errors) {
      if (typeof e === "string") parts.push(e);
      else if (typeof e === "object" && e !== null) {
        const m = (e as Record<string, unknown>).message;
        if (typeof m === "string" && m !== "") parts.push(m);
      }
    }
  }
  const text = [...new Set(parts)].join("; ");
  return text === "" ? undefined : text.length > 300 ? `${text.slice(0, 300)}...` : text;
}

/** Headers of a rate limit, in the GitHub and Bitbucket styles. */
function rateLimited(headers: Record<string, string>): boolean {
  return headers["x-ratelimit-remaining"] === "0" || headers["retry-after"] !== undefined;
}

/**
 * Turns a non-2xx answer into a RemoteError with a Portuguese message. `redact` (the Environment
 * Keys `redact`) runs over the provider text, which is the only part that comes from outside.
 */
export function httpError(provedor: ProviderId, res: Pick<HttpResponse, "status" | "headers" | "body">, redact?: (text: string) => string): RemoteError {
  const nome = nomeDoProvedor(provedor);
  const status = res.status;
  const raw = providerMessage(res.body);
  const detalhe = raw === undefined ? "" : ` Detalhe do ${nome}: ${redact ? redact(raw) : raw}`;
  const codigo = httpCode(status);
  const opts = (dica?: Dica): RemoteErrorOptions => (dica === undefined ? { status } : { status, dica });
  const trocarSecret = "confira o token da secret e as permissões dele no provedor";

  if (status === 401) {
    return new RemoteError(codigo, `O ${nome} recusou as credenciais (401).${detalhe}`, opts(trocarSecret));
  }
  if (status === 403 || status === 429) {
    if (status === 429 || rateLimited(res.headers)) {
      const espera = res.headers["retry-after"];
      const quando = espera !== undefined && espera !== "" ? ` Tente de novo em ${espera} s.` : " Tente de novo em alguns minutos.";
      return new RemoteError(codigo, `O ${nome} limitou as requisições (${status}).${quando}${detalhe}`, opts());
    }
    return new RemoteError(codigo, `Sem permissão no ${nome} (403): a secret não tem acesso a esta operação.${detalhe}`, opts(trocarSecret));
  }
  if (status === 404) {
    return new RemoteError(
      codigo,
      `Não encontrado no ${nome} (404): o repositório, o PR ou a branch não existe, ou a secret não enxerga o repositório.${detalhe}`,
      opts(trocarSecret),
    );
  }
  if (status === 409) {
    return new RemoteError(codigo, `Conflito no ${nome} (409): o estado do PR ou da branch mudou ou impede a operação.${detalhe}`, opts());
  }
  if (status === 422) {
    return new RemoteError(codigo, `O ${nome} recusou os dados enviados (422).${detalhe}`, opts());
  }
  if (status >= 500) {
    return new RemoteError(codigo, `O ${nome} falhou (${status}). Tente de novo em instantes.${detalhe}`, opts());
  }
  return new RemoteError(codigo, `O ${nome} respondeu ${status}.${detalhe}`, opts());
}

/** Throws the RemoteError of a non-2xx answer; returns the answer otherwise. */
export function assertOk(provedor: ProviderId, res: HttpResponse, redact?: (text: string) => string): HttpResponse {
  if (res.status >= 200 && res.status < 300) return res;
  throw httpError(provedor, res, redact);
}

/** Cleans a text that may carry a credential: URLs with user:password and, when given, the Environment Keys `redact`. */
export function cleanText(text: string, redact?: (text: string) => string): string {
  let out = maskCredentials(text);
  if (redact) {
    try {
      out = redact(out);
    } catch {
      // A failing redactor must not hide the error that was being reported.
    }
  }
  return out;
}

/**
 * Converts what the provider layer throws into the failure of a tool. RemoteError keeps its code,
 * message and hint (every RemoteErrorCode is also an `ErrorCode`); anything else goes through `fromError`.
 */
export function toFail(err: unknown, redact?: (text: string) => string): HubToolResult {
  if (err instanceof RemoteError) {
    return fail(err.codigo, cleanText(err.mensagem, redact), err.dica);
  }
  return fromError(err, redact);
}
