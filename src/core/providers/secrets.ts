// Typed access to the `secrets` service of Environment Keys. The service is looked up at every call
// (it can appear, disappear or be replaced while Obsidian runs), never cached. No function here can
// return a secret value: only names, types and hosts (`SecretInfo`) leave this file.
import type { SecretInfo, SecretVaultService } from "../../ecosystem/types";
import { RemoteError, cleanText } from "./errors";

/** Module id sent as `callerModuleId`; it labels the audit log of Environment Keys. */
export const SECRETS_CALLER = "ai-git-tools";

/** Returns the service, or undefined when Environment Keys is not active. Called at every use. */
export type SecretsGetter = () => SecretVaultService | undefined;

/** Why a listing came back as it did. */
export type SecretsStatus = "ok" | "sem_servico" | "sem_listagem" | "cofre_bloqueado" | "erro";

export interface SecretListing {
  status: SecretsStatus;
  /** Metadata only. Empty unless status is "ok". */
  secrets: SecretInfo[];
}

function isNamed(err: unknown, name: string): boolean {
  return typeof err === "object" && err !== null && (err as { name?: unknown }).name === name;
}

/** `VaultLockedError` of Environment Keys (matched by name: the class lives in another plugin). */
export function isVaultLocked(err: unknown): boolean {
  return isNamed(err, "VaultLockedError");
}

/** `PolicyError` of Environment Keys, with its `code`, or undefined. */
export function policyCode(err: unknown): string | undefined {
  if (!isNamed(err, "PolicyError")) return undefined;
  const code = (err as { code?: unknown }).code;
  return typeof code === "string" ? code : "desconhecido";
}

/** Redacts with the Environment Keys `redact` when the service is there (identity otherwise). */
export function redactWith(getSecrets: SecretsGetter, text: string): string {
  try {
    return getSecrets()?.redact(text) ?? text;
  } catch {
    return text;
  }
}

/**
 * Metadata of the stored secrets: `listSecretMetadata` when the service has it (Environment Keys
 * 2.2.0+), `[]` otherwise (service missing or too old). Throws RemoteError `cofre_bloqueado` while
 * the vault is locked.
 */
export async function listSecrets(getSecrets: SecretsGetter, moduleId: string = SECRETS_CALLER): Promise<SecretInfo[]> {
  const service = getSecrets();
  if (!service || typeof service.listSecretMetadata !== "function") return [];
  try {
    return await service.listSecretMetadata(moduleId);
  } catch (err) {
    if (isVaultLocked(err)) {
      throw new RemoteError("cofre_bloqueado", "O cofre de segredos do Environment Keys está bloqueado.", {
        dica: "desbloqueie o Environment Keys no Obsidian",
      });
    }
    throw new RemoteError("rede", cleanText(err instanceof Error ? err.message : String(err), (text) => service.redact(text)));
  }
}

/** Like `listSecrets`, but never throws and tells why the list is empty. */
export async function inspectSecrets(getSecrets: SecretsGetter, moduleId: string = SECRETS_CALLER): Promise<SecretListing> {
  const service = getSecrets();
  if (!service) return { status: "sem_servico", secrets: [] };
  if (typeof service.listSecretMetadata !== "function") return { status: "sem_listagem", secrets: [] };
  try {
    return { status: "ok", secrets: await listSecrets(getSecrets, moduleId) };
  } catch (err) {
    return { status: err instanceof RemoteError && err.codigo === "cofre_bloqueado" ? "cofre_bloqueado" : "erro", secrets: [] };
  }
}

/** The metadata of one secret by name, or undefined (unknown name, no listing, locked vault). Never throws. */
export async function findSecret(getSecrets: SecretsGetter, name: string, moduleId: string = SECRETS_CALLER): Promise<SecretInfo | undefined> {
  if (name === "") return undefined;
  const { secrets } = await inspectSecrets(getSecrets, moduleId);
  return secrets.find((s) => s.name === name);
}
