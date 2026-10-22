// Authenticated HTTP of the provider layer, always through the `secrets` service of Environment
// Keys: the token is a placeholder in a header and is replaced there, never here. A non-2xx answer
// is returned as is (the providers decide what a 202 or a 404 means); only failures before or
// around the answer become a RemoteError.
import type { HttpRequest, HttpResponse, SecureHttp } from "../ports";
import type { SecretInfo } from "../../ecosystem/types";
import { RemoteError, cleanText, secretNaoConfigurada } from "./errors";
import type { ProviderContext } from "./provider";
import { SECRETS_CALLER, isVaultLocked, policyCode } from "./secrets";
import type { SecretsGetter } from "./secrets";

export const USER_AGENT = "obsidian-ai-git-tools";
export const DEFAULT_TIMEOUT_MS = 30_000;

export interface SecureHttpOptions {
  /** Timeout of each request. Default 30 s. */
  timeoutMs?: number;
  /** Id sent to Environment Keys as the caller. */
  moduleId?: string;
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
  const lower = name.toLowerCase();
  return Object.keys(headers).some((k) => k.toLowerCase() === lower);
}

function lowerKeys(headers: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers ?? {})) out[k.toLowerCase()] = String(v);
  return out;
}

const POLICY_MESSAGES: Record<string, string> = {
  unknown_secret: "A secret configurada não existe no Environment Keys.",
  host_not_allowed: "A secret não permite este host. Adicione o host nas permissões da secret no Environment Keys.",
  insecure_scheme: "O Environment Keys só envia segredos por https.",
  placement_not_allowed: "A secret não pode ser usada nesta parte da requisição.",
  secret_not_permitted: "Este módulo não tem permissão para usar a secret.",
  invalid_placeholder: "O placeholder da secret está mal formado.",
};

/** Converts what `secrets.request` throws into a RemoteError (message cleaned of credentials). */
export function toRemoteError(err: unknown, redact?: (text: string) => string): RemoteError {
  if (err instanceof RemoteError) return err;
  if (isVaultLocked(err)) {
    return new RemoteError("cofre_bloqueado", "O cofre de segredos do Environment Keys está bloqueado.", {
      dica: "desbloqueie o Environment Keys no Obsidian",
    });
  }
  const text = cleanText(err instanceof Error ? err.message : String(err), redact);
  const code = policyCode(err);
  if (code !== undefined) {
    const base = POLICY_MESSAGES[code] ?? "O Environment Keys recusou a requisição.";
    const mensagem = code === "unknown_secret" ? base : `${base} (${text})`;
    return new RemoteError(code === "unknown_secret" ? "secret_nao_configurada" : "politica_secret", mensagem, {
      dica: "confira a secret nas configurações do plugin e no Environment Keys",
    });
  }
  return new RemoteError("rede", `Falha de rede ao chamar o provedor: ${text}`);
}

/**
 * `SecureHttp` over the `secrets` service. The service is read at every call; without it the call
 * fails with `servico_secrets_ausente`. `User-Agent` and `Accept` (default `application/json`) are
 * added when the caller did not set them; an object body gets `Content-Type: application/json`.
 */
export function createSecureHttp(getSecrets: SecretsGetter, options: SecureHttpOptions = {}): SecureHttp {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const moduleId = options.moduleId ?? SECRETS_CALLER;
  return async (req: HttpRequest): Promise<HttpResponse> => {
    const service = getSecrets();
    if (!service || typeof service.request !== "function") {
      throw new RemoteError("servico_secrets_ausente", "O Environment Keys (serviço secrets) não está ativo.", {
        dica: "ative o plugin Environment Keys e o AI Ecosystem no Obsidian",
      });
    }
    const headers: Record<string, string> = { ...req.headers };
    if (!hasHeader(headers, "user-agent")) headers["User-Agent"] = USER_AGENT;
    if (!hasHeader(headers, "accept")) headers.Accept = "application/json";
    if (typeof req.body === "object" && req.body !== null && !hasHeader(headers, "content-type")) {
      headers["Content-Type"] = "application/json";
    }
    const secretReq: { method: HttpRequest["method"]; url: string; headers: Record<string, string>; body?: string | Record<string, unknown>; timeoutMs: number; rawBody?: boolean } = {
      method: req.method,
      url: req.url,
      headers,
      timeoutMs,
    };
    if (req.body !== undefined) secretReq.body = req.body;
    if (req.rawBody === true) secretReq.rawBody = true;
    try {
      const res = await service.request(secretReq, moduleId);
      return { status: res.status, headers: lowerKeys(res.headers), body: typeof res.body === "string" ? res.body : "" };
    } catch (err) {
      throw toRemoteError(err, (text) => {
        try {
          return service.redact(text);
        } catch {
          return text;
        }
      });
    }
  };
}

const SECRET_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

/**
 * Value of the `Authorization` header: `{{basic:NAME}}` for a secret of the basic type (or with a
 * username), `{{bearer:NAME}}` otherwise. The name must be a valid secret name, so it cannot close
 * the placeholder and inject another one.
 */
export function authHeader(secretName: string, info?: Pick<SecretInfo, "type" | "hasUsername">): string {
  if (!SECRET_NAME.test(secretName)) {
    throw new RemoteError("argumento_invalido", "Nome de secret inválido. Use letras, números e _ (máximo 64), sem começar por número.");
  }
  const kind = info !== undefined && (info.type === "basic" || info.hasUsername) ? "basic" : "bearer";
  return `{{${kind}:${secretName}}}`;
}

/** Headers with the `Authorization` of the context secret. Throws `secret_nao_configurada` when there is none. */
export function authHeaders(ctx: Pick<ProviderContext, "ref" | "secretName" | "secretInfo">, extra: Record<string, string> = {}): Record<string, string> {
  if (ctx.secretName === "") throw secretNaoConfigurada(ctx.ref.provider);
  return { ...extra, Authorization: authHeader(ctx.secretName, ctx.secretInfo) };
}

/** Parses a JSON answer. An empty body gives `undefined`; a body that is not JSON throws `resposta_invalida`. */
export function parseJson(res: Pick<HttpResponse, "status" | "body">): unknown {
  if (res.body.trim() === "") return undefined;
  try {
    return JSON.parse(res.body) as unknown;
  } catch {
    throw new RemoteError("resposta_invalida", `O provedor respondeu ${res.status} com um corpo que não é JSON.`, { status: res.status });
  }
}

type Json = Record<string, unknown>;

/** The value as an object (empty when it is not one). */
export const obj = (v: unknown): Json => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Json) : {});
/** The value as an array of objects. */
export const list = (v: unknown): Json[] => (Array.isArray(v) ? v.map(obj) : []);
/** A non-empty string, or undefined. */
export const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);
/** A finite number (a numeric string counts), or undefined. */
export const num = (v: unknown): number | undefined => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return undefined;
};

/** `base` with the query values encoded; undefined and empty values are left out. */
export function withQuery(base: string, query: Record<string, string | number | boolean | undefined> = {}): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === "") continue;
    parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  }
  if (parts.length === 0) return base;
  return `${base}${base.includes("?") ? "&" : "?"}${parts.join("&")}`;
}
