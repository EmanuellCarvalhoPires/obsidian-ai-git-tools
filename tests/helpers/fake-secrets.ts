// Fake of the `secrets` service of Environment Keys for the provider tests: no network, no real
// value. The only "secret value" is FAKE_VALUE, to check that redaction hides it.
import type { SecretInfo, SecretRequest, SecretResponse, SecretVaultService } from "../../src/ecosystem/types";
import type { SecretsGetter } from "../../src/core/providers/secrets";

export const FAKE_VALUE = "valor-ficticio-123";

/** Same names as the classes of Environment Keys (the code matches by name). */
export class VaultLockedError extends Error {
  constructor() {
    super("The vault is locked.");
    this.name = "VaultLockedError";
  }
}

export class PolicyError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "PolicyError";
  }
}

export interface RecordedCall {
  req: SecretRequest;
  caller: string;
}

export type FakeHandler = (req: SecretRequest, caller: string) => SecretResponse | Promise<SecretResponse>;

export interface FakeSecrets {
  service: SecretVaultService;
  getSecrets: SecretsGetter;
  calls: RecordedCall[];
  /** Replaces the handler of `request`. */
  onRequest(handler: FakeHandler): void;
  lock(): void;
}

export interface FakeSecretsOptions {
  /** Answer of `request`; default is 200 with `{}`. */
  handler?: FakeHandler;
  /** Metadata; leave it out to simulate an Environment Keys without `listSecretMetadata`. */
  metadata?: SecretInfo[];
}

export function reply(status: number, body: unknown = {}, headers: Record<string, string> = {}): SecretResponse {
  return { status, headers, body: typeof body === "string" ? body : JSON.stringify(body) };
}

export function secretInfo(name: string, type: SecretInfo["type"] = "bearer", extra: Partial<SecretInfo> = {}): SecretInfo {
  return { name, type, hasUsername: type === "basic", allowedHosts: ["api.github.com"], allowAnyHost: false, approval: "never", ...extra };
}

export function makeFakeSecrets(opts: FakeSecretsOptions = {}): FakeSecrets {
  const calls: RecordedCall[] = [];
  let handler: FakeHandler = opts.handler ?? (() => reply(200, {}));
  let locked = false;
  const service: SecretVaultService = {
    isLocked: () => locked,
    request: async (req, caller) => {
      calls.push({ req, caller });
      if (locked) throw new VaultLockedError();
      return handler(req, caller);
    },
    redact: (text) => text.split(FAKE_VALUE).join("[REDACTED]"),
  };
  if (opts.metadata) {
    const metadata = opts.metadata;
    service.listSecretMetadata = async () => {
      if (locked) throw new VaultLockedError();
      return metadata.map((m) => ({ ...m }));
    };
  }
  return {
    service,
    getSecrets: () => service,
    calls,
    onRequest: (h) => void (handler = h),
    lock: () => void (locked = true),
  };
}
