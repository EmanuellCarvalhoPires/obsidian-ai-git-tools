// Ports of the core: what the git and history layers need from the outside world. The Node and
// Obsidian implementations live next to the plugin entry point; tests use real or in-memory ones.

/** Options of one git call. */
export interface GitRunOptions {
  /** Text sent to the standard input of git (e.g. a commit message for `commit -F -`). */
  input?: string;
  /** Overrides the default timeout of the subcommand. */
  timeoutMs?: number;
}

/** Runs `git <args>` in a folder and returns stdout. Rejects with a GitError on failure. */
export type GitRunner = (cwd: string, args: string[], opts?: GitRunOptions) => Promise<string>;

export interface ProjectInfo {
  /** Name of the project note. */
  name: string;
  /** Vault folder of the project, e.g. "Projetos/AI Ecosystem". */
  folder: string;
  /** Absolute path of the local clone, when the note says one. */
  clonePath: string | undefined;
}

/**
 * Lookup of the development projects (notes tagged dev/projeto). The implementation is the
 * ProjectTracker (core/history/project-tracker.ts); the repository resolver only depends on this contract.
 */
export interface ProjectLookup {
  list(): Promise<ProjectInfo[]>;
  /** Case-insensitive match by project name. */
  byName(name: string): Promise<ProjectInfo | undefined>;
  /** Project whose clone contains the absolute path. */
  byClone(path: string): Promise<ProjectInfo | undefined>;
}

/** Vault access used by the history layer. Paths are vault-relative with "/". */
export interface VaultPort {
  /** Absolute path of the vault folder on disk. */
  rootPath(): string;
  exists(path: string): boolean;
  read(path: string): Promise<string>;
  /** Creates the note (and its folders). Fails when it exists. */
  create(path: string, content: string): Promise<void>;
  /** Atomic read-modify-write of a note. */
  process(path: string, fn: (content: string) => string): Promise<void>;
  /** Changes the frontmatter of a note. */
  updateFrontmatter(path: string, fn: (frontmatter: Record<string, unknown>) => void): Promise<void>;
  /** Makes sure a folder exists. */
  ensureFolder(path: string): Promise<void>;
  /**
   * Path of a note inside `folder` (any depth) whose frontmatter property `key` equals `value`, if
   * any. The history layer uses it to find an event note by `evento_id`, whoever wrote it.
   */
  findNoteByProperty(folder: string, key: string, value: string): string | undefined;
  /** Notes with the tag dev/projeto. */
  projects(): Promise<ProjectInfo[]>;
}

export interface HttpRequest {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  url: string;
  headers: Record<string, string>;
  /** A string is sent as is; an object is sent as JSON. */
  body?: string | Record<string, unknown>;
  /** Sends a string body exactly as given, with no placeholder resolution (raw content such as release files). */
  rawBody?: boolean;
}

export interface HttpResponse {
  status: number;
  /** Header names in lower case. */
  headers: Record<string, string>;
  body: string;
}

/** Authenticated HTTP through Environment Keys (placeholders are resolved there, never here). */
export type SecureHttp = (req: HttpRequest) => Promise<HttpResponse>;
