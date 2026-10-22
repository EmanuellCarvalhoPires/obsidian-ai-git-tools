// Guided setup of the module (the AI Ecosystem flow that runs the skill `configurar-ai-git-tools`
// the first time the module is installed): reports what the plugin detects and applies the answers.
import { HOOKS_SERVICE } from "./types";
import type { AIEcosystemAPI, HooksService, SetupHandler } from "./types";
import type { Settings } from "../types";
import type { SecretListing } from "../core/providers/secrets";

export const SETUP_MODULE_ID = "ai-git-tools";

/** Value the guided setup accepts to mean "no secret". */
export const NONE = "nenhuma";

/** Keys the guided setup may save. */
export const SETUP_KEYS = ["secret_github", "secret_bitbucket", "pasta_dos_projetos"] as const;

export interface SetupDeps {
  getSettings: () => Settings;
  saveSettings: () => Promise<void>;
  /** Whether a vault folder exists. */
  folderExists: (path: string) => boolean;
  /** Metadata of the Environment Keys secrets (never values) and why the list may be empty. Must not throw. */
  listSecrets: () => Promise<SecretListing>;
}

/** Accepts a vault-relative folder without "..", hidden segments or a drive letter. */
export function isVaultFolder(value: string): boolean {
  const parts = value.trim().replace(/\\/g, "/").split("/").filter((p) => p !== "" && p !== ".");
  return parts.length > 0 && !parts.some((p) => p === ".." || p.startsWith(".")) && !/^[A-Za-z]:$/.test(parts[0] ?? "");
}

export function createSetupHandler(deps: SetupDeps): SetupHandler {
  return {
    detect: async () => {
      const s = deps.getSettings();
      let listing: SecretListing;
      try {
        listing = await deps.listSecrets();
      } catch {
        listing = { status: "erro", secrets: [] };
      }
      return {
        projectsRoot: s.projectsRoot,
        projectsRootExists: deps.folderExists(s.projectsRoot),
        // Names, types and hosts only; `secretsStatus` tells why the list is empty
        // (sem_servico, sem_listagem for Environment Keys older than 2.2.0, cofre_bloqueado, erro).
        secrets: listing.secrets,
        secretsStatus: listing.status,
        secretGithub: s.secretGithub || NONE,
        secretBitbucket: s.secretBitbucket || NONE,
      };
    },
    save: async (key, value) => {
      const s = deps.getSettings();
      if (key === "pasta_dos_projetos") {
        if (typeof value !== "string" || !isVaultFolder(value)) {
          return "pasta_dos_projetos must be a vault-relative folder without '..' or hidden segments";
        }
        s.projectsRoot = value.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
      } else if (key === "secret_github" || key === "secret_bitbucket") {
        if (typeof value !== "string") return `${key} must be the name of a secret, or "${NONE}"`;
        const name = value.trim() === NONE ? "" : value.trim();
        if (key === "secret_github") s.secretGithub = name;
        else s.secretBitbucket = name;
      } else {
        return `Unknown key "${key}". Accepted keys: ${SETUP_KEYS.join(", ")}`;
      }
      await deps.saveSettings();
      return undefined;
    },
    validate: async () =>
      deps.folderExists(deps.getSettings().projectsRoot)
        ? { ok: true }
        : { ok: false, missing: ["projects folder does not exist"] },
  };
}

/** Registers the setup handler in the hooks service. Returns the unregister function (a no-op when the service is missing). */
export function registerSetupHandler(api: AIEcosystemAPI, handler: SetupHandler): () => void {
  try {
    const hooks = api.getService<HooksService>(HOOKS_SERVICE);
    if (!hooks || typeof hooks.registerSetupHandler !== "function") return () => undefined;
    return hooks.registerSetupHandler(SETUP_MODULE_ID, handler);
  } catch (err) {
    console.debug("[AI Git Tools] Could not register the setup handler", err);
    return () => undefined;
  }
}
