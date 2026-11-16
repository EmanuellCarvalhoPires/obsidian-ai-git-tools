// Cofre de segredos visto do processo filho: cada chamada vai ao app pelo canal JSON-RPC e o app
// (dono do cofre) resolve os placeholders. Nenhum valor secreto chega até aqui.
import type { SecretInfo, SecretRequest, SecretResponse, SecretType, SecretVaultService } from "../ecosystem/types";
import { RpcRemoteError } from "./rpc";
import type { RpcChannel } from "./rpc";

interface RemoteRequestResult {
  status: number;
  cabecalhos?: Record<string, string>;
  corpo?: string;
}

interface RemoteSecretMeta {
  nome: string;
  tipo: string;
  hosts?: string[];
}

/** Converte o erro do app no erro que `isVaultLocked` e `policyCode` reconhecem (pelo name). */
function mapError(err: unknown): Error {
  if (!(err instanceof RpcRemoteError)) return err instanceof Error ? err : new Error(String(err));
  const data = (typeof err.data === "object" && err.data !== null ? err.data : {}) as { codigo?: unknown; codigo_politica?: unknown };
  if (data.codigo === "cofre_ausente") {
    const e = new Error(err.message);
    e.name = "VaultLockedError";
    return e;
  }
  if (data.codigo === "politica") {
    const e = new Error(err.message) as Error & { code?: string };
    e.name = "PolicyError";
    e.code = typeof data.codigo_politica === "string" ? data.codigo_politica : undefined;
    return e;
  }
  return new Error(err.message);
}

export function createSecretsProxy(rpc: Pick<RpcChannel, "request">): SecretVaultService {
  return {
    isLocked: () => false,
    async request(req: SecretRequest): Promise<SecretResponse> {
      const headers = { ...(req.headers ?? {}) };
      let corpo: string | null = null;
      if (typeof req.body === "string") corpo = req.body;
      else if (req.body !== undefined) {
        // Objeto: o app recebe JSON como texto, com o Content-Type que o cofre local poria.
        corpo = JSON.stringify(req.body);
        if (!Object.keys(headers).some((k) => k.toLowerCase() === "content-type")) headers["Content-Type"] = "application/json";
      }
      try {
        const res = (await rpc.request(
          "segredos/requisicao",
          { metodo: req.method, url: req.url, cabecalhos: headers, corpo, tempo_limite_ms: req.timeoutMs ?? null, corpo_cru: req.rawBody ?? false },
          120_000,
        )) as RemoteRequestResult;
        return { status: res.status, headers: res.cabecalhos ?? {}, body: res.corpo ?? "" };
      } catch (err) {
        throw mapError(err);
      }
    },
    // O app já redige o que devolve; aqui não há valor secreto para trocar.
    redact: (text) => text,
    async listSecretMetadata(): Promise<SecretInfo[]> {
      try {
        const res = (await rpc.request("segredos/metadados", {}, 30_000)) as { segredos?: RemoteSecretMeta[] };
        return (res.segredos ?? []).map((s) => ({
          name: s.nome,
          type: s.tipo as SecretType,
          hasUsername: s.tipo === "basic",
          allowedHosts: s.hosts ?? [],
          allowAnyHost: false,
          approval: "never" as const,
        }));
      } catch (err) {
        throw mapError(err);
      }
    },
  };
}
