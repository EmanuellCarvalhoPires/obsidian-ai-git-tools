// Turns what the tools did into event notes. The tools call `afterTool` once they have succeeded;
// the recorder maps the tool and its result to a DevEvent and hands it to the HistoryService, which
// writes the note once (the ids are the same ones the sync of the watcher builds, so a commit made
// by git_commit and then seen by the watcher is one note).
//
// Contract with the tools: `afterTool` NEVER throws and never turns a successful tool into a
// failure. A note that could not be written becomes a warning (`avisos`) in the answer.
//
// Tool -> event (the ids come from events.ts and are the ones of the AI Log Manager):
//   git_commit                       commit      commit-<hash>
//   git_merge (a new merge commit)   commit      commit-<hash>      (fast-forward and "already up to date" make no commit)
//   git_revert (a new commit)        commit      commit-<hash>
//   git_push (a branch)              push        push-<remote>/<branch>-<hash7>, the same key as the sync (the remote-tracking name)
//                                    + branch    branch-<name>-<hash7> when the branch is new on the remote and no branch note exists yet
//   git_push (a tag), "em_dia"       nothing
//   git_checkout criar               branch      branch-<name>-<hash7>
//   git_tag criar                    deploy      deploy-tag-<name>-<hash7>  (environment = the tag name, state "criada")
//   git_pr_criar                     pr          pr-<host>-<owner/repo>-<n>, state "open"
//   git_pr_merge                     pr          the same id, state "merged" (updates the note of the open PR)
// PR states follow the notes of the AI Log Manager: open, merged, declined.
import type { GitRunner, ProjectInfo, ProjectLookup } from "../ports";
import type { ResolvedRepo } from "../repo-resolver";
import type { HubToolResult } from "../../ecosystem/types";
import { branchId, commitId, prId, pushId } from "./events";
import type { DevEvent } from "./events";
import type { HistoryService } from "./history-service";

export interface RecorderOutcome {
  /** Path of the note of the main event of the call. */
  nota?: string;
  /** Paths of every note of the call, when it made more than one (a push of a new branch). */
  notas?: string[];
  avisos: string[];
}

/** What the tools use (GitToolDeps.recorder). */
export interface ToolRecorder {
  afterTool(toolName: string, repo: ResolvedRepo, result: HubToolResult): Promise<RecorderOutcome>;
}

export interface RecorderDeps {
  history: HistoryService;
  projects: ProjectLookup;
  /** Reads the subject, author and date of a commit. */
  git: GitRunner;
  now?: () => number;
}

/** An event to write, and how. */
interface Planned {
  ev: DevEvent;
  /** `remote` events keep the state of a pull request note up to date. */
  remote?: boolean;
}

type Data = Record<string, unknown>;

const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

export class Recorder implements ToolRecorder {
  private readonly now: () => number;

  constructor(private readonly deps: RecorderDeps) {
    this.now = deps.now ?? Date.now;
  }

  async afterTool(toolName: string, repo: ResolvedRepo, result: HubToolResult): Promise<RecorderOutcome> {
    const out: RecorderOutcome = { avisos: [] };
    if (result.isError === true || !RECORDED_TOOLS.includes(toolName)) return out;
    try {
      const project = await this.projectOf(repo);
      if (!project) return out;
      const data: Data = result.structuredContent ?? {};
      const planned = await this.plan(toolName, project, repo, data);
      const notes: string[] = [];
      for (const p of planned) {
        try {
          const r = p.remote ? await this.deps.history.recordRemote(project, p.ev) : await this.deps.history.record(project, p.ev);
          if (r.ignorado === true) continue;
          notes.push(r.path);
        } catch (err) {
          out.avisos.push(`A nota do evento (${p.ev.tipo}) não foi gravada: ${message(err)}`);
        }
      }
      if (notes[0] !== undefined) out.nota = notes[0];
      if (notes.length > 1) out.notas = notes;
    } catch (err) {
      out.avisos.push(`A nota do evento não foi gravada: ${message(err)}`);
    }
    return out;
  }

  // ---------------------------------------------------------------- internals

  /** The project that owns the repository, or undefined (then nothing is recorded). */
  private async projectOf(repo: ResolvedRepo): Promise<ProjectInfo | undefined> {
    const { projects } = this.deps;
    const byName = repo.projeto !== undefined ? await projects.byName(repo.projeto) : undefined;
    return byName ?? (await projects.byClone(repo.root));
  }

  private async plan(tool: string, project: ProjectInfo, repo: ResolvedRepo, data: Data): Promise<Planned[]> {
    switch (tool) {
      case "git_commit":
        return this.commit(project, repo, str(data.hash), str(data.titulo), str(data.branch));
      case "git_merge":
        if (data.abortado === true || data.ja_atualizado === true || data.fast_forward === true) return [];
        return this.commit(project, repo, str(data.hash), undefined, str(data.branch));
      case "git_revert":
        if (data.abortado === true) return [];
        return this.commit(project, repo, str(data.hash), str(data.titulo), str(data.branch));
      case "git_push":
        return this.push(project, data);
      case "git_checkout":
        return this.checkout(project, repo, data);
      case "git_tag":
        return this.tag(project, data);
      case "git_pr_criar":
      case "git_pr_merge":
        return this.pullRequest(tool, project, repo, data);
      default:
        return [];
    }
  }

  private async commit(project: ProjectInfo, repo: ResolvedRepo, hash: string | undefined, titulo: string | undefined, branch: string | undefined): Promise<Planned[]> {
    if (hash === undefined) return [];
    const meta = await this.commitMeta(repo.root, hash);
    return [
      {
        ev: {
          tipo: "commit",
          projeto: project.name,
          id: commitId(hash),
          titulo: titulo ?? meta.assunto ?? hash.slice(0, 7),
          data: meta.data,
          ...(branch !== undefined ? { branch } : {}),
          hash,
          ...(meta.autor !== undefined ? { autor: meta.autor } : {}),
        },
      },
    ];
  }

  private push(project: ProjectInfo, data: Data): Planned[] {
    const branch = str(data.branch);
    const hash = str(data.hash);
    const remoto = str(data.remoto);
    // A tag is not a push of a branch; nothing new went out when the remote was up to date.
    if (str(data.tag) !== undefined || branch === undefined || hash === undefined || remoto === undefined || data.em_dia === true) return [];
    const planned: Planned[] = [
      {
        ev: {
          tipo: "push",
          projeto: project.name,
          id: pushId(`${remoto}/${branch}`, hash),
          titulo: branch,
          data: new Date(this.now()),
          branch,
          hash,
        },
      },
    ];
    // A branch that a note already describes (created by git_checkout, or seen by the watcher) is not described twice.
    if (data.branch_nova === true && !this.deps.history.branchNoteExists(project, branch)) {
      planned.push({ ev: { tipo: "branch", projeto: project.name, id: branchId(branch, hash), titulo: branch, data: new Date(this.now()), branch, hash } });
    }
    return planned;
  }

  private async checkout(project: ProjectInfo, repo: ResolvedRepo, data: Data): Promise<Planned[]> {
    const branch = str(data.branch);
    if (data.criada !== true || branch === undefined) return [];
    let hash = str(data.hash);
    if (hash === undefined) {
      try {
        hash = (await this.deps.git(repo.root, ["rev-parse", "--verify", `refs/heads/${branch}`])).trim() || undefined;
      } catch {
        hash = undefined;
      }
    }
    if (hash === undefined) return [];
    // The sync must not describe this branch again when it has moved by the time it looks.
    this.deps.history.markBranchSeen(project, branch);
    return [{ ev: { tipo: "branch", projeto: project.name, id: branchId(branch, hash), titulo: branch, data: new Date(this.now()), branch, hash } }];
  }

  private tag(project: ProjectInfo, data: Data): Planned[] {
    const nome = str(data.nome);
    const hash = str(data.hash);
    if (data.acao !== "criar" || nome === undefined || hash === undefined) return [];
    return [
      {
        ev: {
          tipo: "deploy",
          projeto: project.name,
          id: `deploy-tag-${nome}-${hash.slice(0, 7)}`,
          titulo: `Tag ${nome}`,
          data: new Date(this.now()),
          hash,
          ambiente: nome,
          estado: "criada",
        },
      },
    ];
  }

  private pullRequest(tool: string, project: ProjectInfo, repo: ResolvedRepo, data: Data): Planned[] {
    const ref = repo.remoto?.ref;
    const numero = num(data.numero);
    if (!ref || numero === undefined) return [];
    const merge = tool === "git_pr_merge";
    if (merge && data.mesclado !== true) return [];
    const origem = str(data.origem);
    const destino = str(data.destino);
    const hash = merge ? str(data.commit) : str(data.head_sha);
    const url = str(data.url);
    const autor = str(data.autor);
    const created = str(data.criado_em);
    return [
      {
        remote: true,
        ev: {
          tipo: "pr",
          projeto: project.name,
          id: prId(ref.provider, ref.repo, numero),
          titulo: str(data.titulo) ?? `PR ${numero}`,
          data: !merge && created !== undefined && !Number.isNaN(Date.parse(created)) ? new Date(created) : new Date(this.now()),
          ...(origem !== undefined ? { branch: origem } : {}),
          ...(hash !== undefined ? { hash } : {}),
          ...(url !== undefined ? { url } : {}),
          ...(autor !== undefined ? { autor } : {}),
          estado: merge ? "merged" : "open",
          ...(origem !== undefined && destino !== undefined ? { detalhes: `Origem \`${origem}\` para \`${destino}\`.` } : {}),
        },
      },
    ];
  }

  /** Subject, author and date of a commit. Best effort: a failure gives the defaults. */
  private async commitMeta(root: string, hash: string): Promise<{ assunto?: string; autor?: string; data: Date }> {
    try {
      const [autor = "", assunto = "", ct = ""] = (await this.deps.git(root, ["show", "-s", "--format=%an%x1f%s%x1f%ct", hash])).trim().split("\x1f");
      const secs = Number(ct);
      return {
        ...(assunto !== "" ? { assunto } : {}),
        ...(autor !== "" ? { autor } : {}),
        data: Number.isFinite(secs) && secs > 0 ? new Date(secs * 1000) : new Date(this.now()),
      };
    } catch {
      return { data: new Date(this.now()) };
    }
  }
}

/** Tools that make events. Anything else returns without work. */
export const RECORDED_TOOLS = ["git_commit", "git_merge", "git_revert", "git_push", "git_checkout", "git_tag", "git_pr_criar", "git_pr_merge"];

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
