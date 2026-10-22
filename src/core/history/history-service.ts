// History of a project: reads the git repository of its clone, records commits, pushes and new
// branches as event notes (once each), receives events from other sources (the tools, the remote)
// through `record`, and draws the repository graph.
// Ported from the DevService of the AI Log Manager: same notes, same ids (decision D7).
import { writeChangelog } from "./changelog";
import type { ChangelogOptions, ChangelogResult } from "./changelog";
import { CheckpointStore } from "./checkpoints";
import type { DevState } from "./checkpoints";
import { branchId, commitId, eventIdOf, eventPath, pushId, renderEventNote, sanitizeFilename } from "./events";
import type { DevEvent } from "./events";
import { LOG_FORMAT, layout, parseLog, toSvg } from "./graph";
import type { Highlight, Row } from "./graph";
import type { GitRunner, ProjectInfo, VaultPort } from "../ports";
import type { Settings } from "../../types";

/** Commits drawn in a repository graph when the caller does not say. */
export const DEFAULT_GRAPH_LIMIT = 60;

/** Marks a commit that already existed when the baseline of its project was taken. */
const BASELINE_MARK = "-";

export interface HistorySyncResult {
  project: string;
  /** First time seen: only the baseline was stored, nothing was recorded. */
  baseline: boolean;
  /** Paths of the notes created by this sync. */
  created: string[];
  errors: string[];
}

export interface RecordResult {
  /** Path of the note of the event (the existing one when it was not created now). */
  path: string;
  created: boolean;
}

export interface GraphResult {
  svg: string;
  rows: Row[];
  lanes: number;
}

/**
 * Revisions that `git log` walks for the history: branches, tags, remote-tracking branches and a
 * detached HEAD. Not `--all`, which also walks `refs/stash` (the internal commits of a stash) and
 * `refs/notes`, and those are not commits of the project.
 */
export const HISTORY_REVS = ["--branches", "--tags", "--remotes", "HEAD"];

const branchOf = (ref: string): string => ref.replace(/^refs\/(heads|remotes\/[^/]+)\//, "");

export class HistoryService {
  /** Serializes `record` so two sources (a tool and the watcher) never write the same note twice. */
  private tail: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly git: GitRunner,
    private readonly vault: VaultPort,
    private readonly store: CheckpointStore,
    private readonly settings: () => Pick<Settings, "eventsFolder"> & Partial<Pick<Settings, "changelogsFolder">>,
    private readonly now: () => number = Date.now,
  ) {}

  /** Vault folder that receives the event notes of a project. */
  eventsFolder(project: ProjectInfo): string {
    return `${project.folder}/${this.settings().eventsFolder}`;
  }

  /**
   * Records one event as a note, once. Looks for an existing note of the same event (by the id the
   * service stored, by `evento_id` in the frontmatter of the whole events folder, and by the path
   * of the note), so a note written by the AI Log Manager is never written again.
   */
  record(project: ProjectInfo, ev: DevEvent): Promise<RecordResult> {
    return this.serial(() => this.recordNow(project, ev));
  }

  /**
   * Records an event that comes from the remote (pull request, deploy). For a pull request that
   * already has a note, the state in the note follows the remote (open, merged, declined).
   */
  recordRemote(project: ProjectInfo, ev: DevEvent): Promise<RecordResult & { updated: boolean }> {
    return this.serial(async () => {
      const result = await this.recordNow(project, ev);
      let updated = false;
      if (ev.tipo === "pr" && ev.estado) {
        if (!result.created && result.path !== BASELINE_MARK) {
          const current = /^estado: "(.*)"$/m.exec(await this.vault.read(result.path))?.[1];
          if (current !== undefined && current !== ev.estado) {
            const estado = ev.estado;
            await this.vault.process(result.path, (c) =>
              c.replace(/^estado: ".*"$/m, `estado: "${estado}"`).replace(/^\| Estado \| .* \|$/m, `| Estado | ${estado} |`),
            );
            updated = true;
          }
        }
        const state = this.store.getDev(project.name);
        if (state) this.store.setDev(project.name, { ...state, prStates: { ...state.prStates, [ev.id]: ev.estado } });
      }
      return { ...result, updated };
    });
  }

  /** True once the first sync of the project stored its baseline (before that, nothing is retroactive yet). */
  hasBaseline(project: ProjectInfo): boolean {
    return this.store.getDev(project.name) !== undefined;
  }

  /**
   * Tells the sync that a local branch is already documented, so it does not write a second note for
   * it when the branch has moved by the time the sync looks (the tool recorded it at its creation).
   * Does nothing while the project has no baseline.
   */
  markBranchSeen(project: ProjectInfo, branch: string): void {
    const state = this.store.getDev(project.name);
    if (state && !state.branches.includes(branch)) this.store.setDev(project.name, { ...state, branches: [...state.branches, branch] });
  }

  /** True when a note of a branch event with this branch name already exists (whoever wrote it). */
  branchNoteExists(project: ProjectInfo, branch: string): boolean {
    return this.vault.exists(eventPath(this.eventsFolder(project), { tipo: "branch", projeto: project.name, id: "", titulo: branch, data: new Date(0), branch }));
  }

  /**
   * What the remote reads (pull requests and deploys) already saw: id -> last known state. Undefined
   * while the project has no git baseline.
   */
  remoteMarks(project: ProjectInfo): Record<string, string> | undefined {
    const state = this.store.getDev(project.name);
    return state ? { ...state.prStates } : undefined;
  }

  /** Stores remote marks (see `remoteMarks`). Does nothing while the project has no baseline. */
  setRemoteMarks(project: ProjectInfo, marks: Record<string, string>): void {
    const state = this.store.getDev(project.name);
    if (state) this.store.setDev(project.name, { ...state, prStates: { ...state.prStates, ...marks } });
  }

  /** The repository folder of a project, or undefined when it has no clone or the clone is not a git repository. */
  async repoOf(project: ProjectInfo): Promise<string | undefined> {
    if (!project.clonePath) return undefined;
    try {
      await this.git(project.clonePath, ["rev-parse", "--git-dir"]);
      return project.clonePath;
    } catch {
      return undefined;
    }
  }

  /**
   * Looks at the repository and records what is new since the last sync (also what happened while
   * Obsidian was closed). The first sync of a project only stores the baseline.
   */
  async sync(project: ProjectInfo): Promise<HistorySyncResult> {
    const result: HistorySyncResult = { project: project.name, baseline: false, created: [], errors: [] };
    const cwd = await this.repoOf(project);
    if (!cwd) return result;
    const started = this.now();

    try {
      const refsOut = await this.git(cwd, ["for-each-ref", "--format=%(refname)%1f%(objectname)", "refs/heads", "refs/remotes"]);
      const locals: Record<string, string> = {};
      const tips: Record<string, string> = {};
      for (const line of refsOut.split("\n")) {
        const [ref = "", hash = ""] = line.trim().split("\x1f");
        if (!ref || !hash || ref.endsWith("/HEAD")) continue;
        if (ref.startsWith("refs/heads/")) locals[branchOf(ref)] = hash;
        else if (ref.startsWith("refs/remotes/")) tips[ref.slice("refs/remotes/".length)] = hash;
      }

      const state = this.store.getDev(project.name);
      if (!state) {
        this.store.setDev(project.name, { cursorMs: started, tips, branches: Object.keys(locals), prStates: {} });
        result.baseline = true;
        // Commits of the last seconds already exist: they are not events (the next sync overlaps by 2 s).
        try {
          const recent = parseLog(await this.git(cwd, ["log", ...HISTORY_REVS, LOG_FORMAT, `--since=${new Date(started - 10_000).toISOString()}`, "-n", "50"]));
          for (const c of recent) if (!this.store.eventNote(commitId(c.hash))) this.store.setEventNote(commitId(c.hash), BASELINE_MARK);
        } catch {
          // An empty repository has no log yet.
        }
      } else {
        const events: DevEvent[] = [];
        await this.commitEvents(project, cwd, state, events);
        await this.pushEvents(project, cwd, state, tips, events);
        for (const [name, hash] of Object.entries(locals)) {
          if (state.branches.includes(name)) continue;
          events.push({ tipo: "branch", projeto: project.name, id: branchId(name, hash), titulo: name, data: new Date(started), branch: name, hash });
        }
        for (const ev of events) {
          const r = await this.record(project, ev);
          if (r.created) result.created.push(r.path);
        }
        // Read the state again: a tool or the remote read may have stored marks while this sync ran.
        const fresh = this.store.getDev(project.name) ?? state;
        const branches = [...new Set([...Object.keys(locals), ...fresh.branches.filter((b) => !state.branches.includes(b))])];
        this.store.setDev(project.name, { ...fresh, cursorMs: started, tips, branches });
      }
    } catch (err) {
      result.errors.push(err instanceof Error ? err.message : String(err));
    }
    return result;
  }

  /**
   * Writes the changelog note of a release of the project (see changelog.ts). The same release
   * (same `versao`) rewrites its note instead of creating a second one.
   */
  async changelog(project: ProjectInfo, options: ChangelogOptions = {}): Promise<ChangelogResult> {
    const cwd = await this.repoOf(project);
    if (!cwd) throw new Error(`The project "${project.name}" has no git clone.`);
    return writeChangelog({ git: this.git, vault: this.vault, folderName: this.settings().changelogsFolder ?? "Changelogs", now: this.now }, project, cwd, options);
  }

  /** The repository graph of a project (newest commits of all branches). */
  async graph(project: ProjectInfo, options: { limit?: number; highlight?: Highlight; width?: number } = {}): Promise<GraphResult> {
    const cwd = await this.repoOf(project);
    if (!cwd) throw new Error(`The project "${project.name}" has no git clone.`);
    const limit = options.limit ?? DEFAULT_GRAPH_LIMIT;
    const commits = parseLog(await this.git(cwd, ["log", ...HISTORY_REVS, "--date-order", LOG_FORMAT, "-n", String(limit)]));
    const { rows, lanes } = layout(commits);
    return { svg: toSvg(rows, lanes, this.now(), options.width ?? 320, options.highlight ?? {}), rows, lanes };
  }

  // ---------------------------------------------------------------- internals

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.tail.then(fn, fn);
    this.tail = run.catch(() => undefined);
    return run;
  }

  private async recordNow(project: ProjectInfo, ev: DevEvent): Promise<RecordResult> {
    const known = this.store.eventNote(ev.id);
    if (known && this.vault.exists(known)) return { path: known, created: false };

    const folder = this.eventsFolder(project);
    const existing = this.vault.findNoteByProperty(folder, "evento_id", ev.id);
    if (existing) {
      this.store.setEventNote(ev.id, existing);
      return { path: existing, created: false };
    }

    const indexName = `${project.name} - Eventos`;
    const indexPath = `${folder}/${sanitizeFilename(indexName)}.md`;
    if (!this.vault.exists(indexPath)) {
      await this.vault.create(
        indexPath,
        `---\ntags:\n  - moc\nup: "[[${project.name}]]"\n---\n# ${indexName}\n\nEventos de desenvolvimento do projeto (commits, pushes, branches, PRs e deploys), um por nota.\n\n` +
          '```dataview\nTABLE WITHOUT ID file.link AS "Evento", evento AS "Tipo", branch AS "Branch", data AS "Data"\nFROM [[]]\n' +
          "WHERE contains(flat(list(up)), this.file.link)\nSORT data DESC\n```\n",
      );
    }

    // The path is the second line of defense. A note there with this id (or with no id, written by
    // hand or by an older format) is the event itself; a note with another id is a different
    // event that happens to have the same name, so this one gets a suffix.
    const base = eventPath(folder, ev);
    for (let n = 0; n < 20; n++) {
      const path = n === 0 ? base : base.replace(/\.md$/, ` ${ev.id.slice(-6)}${n > 1 ? ` ${n}` : ""}.md`);
      if (!this.vault.exists(path)) {
        await this.vault.create(path, renderEventNote(ev, indexName));
        this.store.setEventNote(ev.id, path);
        return { path, created: true };
      }
      const owner = eventIdOf(await this.vault.read(path));
      if (owner === undefined || owner === ev.id) {
        this.store.setEventNote(ev.id, path);
        return { path, created: false };
      }
    }
    throw new Error(`Could not find a free note name for the event ${ev.id}.`);
  }

  private async commitEvents(project: ProjectInfo, cwd: string, state: DevState, events: DevEvent[]): Promise<void> {
    const since = new Date(Math.max(0, state.cursorMs - 2000)).toISOString();
    const commits = parseLog(await this.git(cwd, ["log", ...HISTORY_REVS, LOG_FORMAT, `--since=${since}`, "-n", "200"])).reverse();
    for (const c of commits) {
      if (this.store.eventNote(commitId(c.hash))) continue;
      let branch = c.refs.find((r) => !r.startsWith("tag: ") && !/^(origin|upstream)\//.test(r) && r !== "HEAD");
      if (!branch) {
        try {
          branch = (await this.git(cwd, ["name-rev", "--name-only", "--refs=refs/heads/*", c.hash])).trim().replace(/[~^].*$/, "") || undefined;
        } catch {
          branch = undefined;
        }
        if (branch === "undefined") branch = undefined;
      }
      events.push({ tipo: "commit", projeto: project.name, id: commitId(c.hash), titulo: c.subject, data: new Date(c.time * 1000), branch, hash: c.hash, autor: c.author });
    }
  }

  private async pushEvents(project: ProjectInfo, cwd: string, state: DevState, tips: Record<string, string>, events: DevEvent[]): Promise<void> {
    for (const [key, tip] of Object.entries(tips)) {
      const old = state.tips[key];
      if (old === tip) continue;
      const branch = key.slice(key.indexOf("/") + 1);
      let details: string | undefined;
      let count: number | undefined;
      if (old) {
        try {
          count = Number((await this.git(cwd, ["rev-list", "--count", `${old}..${tip}`])).trim());
          const lines = (await this.git(cwd, ["log", `${old}..${tip}`, "--format=- `%h` %s", "-n", "20"])).trim();
          details = lines ? `Commits enviados:\n\n${lines}` : undefined;
        } catch {
          count = undefined;
        }
      }
      events.push({
        tipo: "push",
        projeto: project.name,
        id: pushId(key, tip),
        titulo: `${branch}${count ? ` (${count} commit${count === 1 ? "" : "s"})` : ""}`,
        data: new Date(this.now()),
        branch,
        hash: tip,
        detalhes: details,
      });
    }
  }
}
