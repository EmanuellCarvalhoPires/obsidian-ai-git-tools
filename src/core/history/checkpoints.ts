// What the history layer already saw, so every sync is incremental and idempotent. This is the
// state of the AI Git Tools only (a file of its own in the plugin folder, never the state of the
// AI Log Manager): per project the repository cursor, and per event the note that holds it.

/** What was seen of a project repository at the last sync. */
export interface DevState {
  /** Epoch ms of the last sync: only commits after it are new. */
  cursorMs: number;
  /** "origin/main" -> hash of the remote-tracking branch (a change means a push). */
  tips: Record<string, string>;
  /** Local branch names. */
  branches: string[];
  /** Pull request id -> last known state. */
  prStates: Record<string, string>;
}

export interface CheckpointFile {
  version: 1;
  /** Repository state per project name. */
  dev: Record<string, DevState>;
  /** Event id -> vault path of its note ("-" marks a commit that existed when the baseline was taken). */
  devEvents: Record<string, string>;
}

export function emptyCheckpointFile(): CheckpointFile {
  return { version: 1, dev: {}, devEvents: {} };
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export function normalizeCheckpointFile(raw: unknown): CheckpointFile {
  if (!isRecord(raw)) return emptyCheckpointFile();
  return {
    version: 1,
    dev: isRecord(raw.dev) ? (raw.dev as Record<string, DevState>) : {},
    devEvents: isRecord(raw.devEvents) ? (raw.devEvents as Record<string, string>) : {},
  };
}

export interface CheckpointStorage {
  load(): Promise<unknown>;
  save(data: CheckpointFile): Promise<void>;
}

/** The part of the Obsidian `DataAdapter` the file storage needs (a fake in the tests). */
export interface FileAdapter {
  exists(path: string): Promise<boolean>;
  read(path: string): Promise<string>;
  write(path: string, data: string): Promise<void>;
}

/** Stores the checkpoints as JSON in one file (e.g. `<plugin folder>/checkpoints.json`). A corrupt file reads as empty. */
export function createFileStorage(adapter: FileAdapter, path: string): CheckpointStorage {
  return {
    load: async () => {
      try {
        if (!(await adapter.exists(path))) return undefined;
        return JSON.parse(await adapter.read(path)) as unknown;
      } catch {
        return undefined;
      }
    },
    save: (data) => adapter.write(path, JSON.stringify(data)),
  };
}

export const MAX_COMMIT_PUSH_ENTRIES = 200;

/**
 * Keeps the newest `max` entries whose id starts with "commit-" or "push-" (the bulk of the notes) and every other entry.
 * Insertion order is the age order: the ids are not integer-like, so the object keeps it. Dropping an old entry is safe:
 * the sync only looks at new commits and `recordNow` finds a note by `evento_id` in the vault when the id is unknown.
 */
export function pruneDevEvents(events: Record<string, string>, max: number = MAX_COMMIT_PUSH_ENTRIES): Record<string, string> {
  const volatile = Object.keys(events).filter((id) => id.startsWith("commit-") || id.startsWith("push-"));
  if (volatile.length <= max) return events;
  const drop = new Set(volatile.slice(0, volatile.length - max));
  const kept: Record<string, string> = {};
  for (const [id, path] of Object.entries(events)) if (!drop.has(id)) kept[id] = path;
  return kept;
}

const SAVE_DELAY_MS = 500;

export class CheckpointStore {
  private data: CheckpointFile;
  private saveTimer: number | undefined;

  constructor(
    private readonly storage: CheckpointStorage,
    initial?: unknown,
  ) {
    this.data = normalizeCheckpointFile(initial);
  }

  static async open(storage: CheckpointStorage): Promise<CheckpointStore> {
    let raw: unknown;
    try {
      raw = await storage.load();
    } catch {
      raw = undefined;
    }
    return new CheckpointStore(storage, raw);
  }

  getDev(project: string): DevState | undefined {
    return this.data.dev[project];
  }

  setDev(project: string, state: DevState): void {
    this.data.dev[project] = state;
    this.scheduleSave();
  }

  eventNote(id: string): string | undefined {
    return this.data.devEvents[id];
  }

  setEventNote(id: string, path: string): void {
    this.data.devEvents[id] = path;
    this.scheduleSave();
  }

  /** Writes now (also used on unload). */
  async flush(): Promise<void> {
    if (this.saveTimer !== undefined) window.clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
    this.prune();
    await this.storage.save(this.data);
  }

  private prune(): void {
    this.data.devEvents = pruneDevEvents(this.data.devEvents);
  }

  private scheduleSave(): void {
    if (this.saveTimer !== undefined) return;
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = undefined;
      this.prune();
      void this.storage.save(this.data).catch(() => undefined);
    }, SAVE_DELAY_MS);
  }
}
