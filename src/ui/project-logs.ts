// Conversation logs of a project, read from the metadata cache. Same index rule as the AI Log
// Manager (notes tagged `log` whose `projeto` property links to the project note), but with no
// dependency on that plugin: the logs show up in this screen whether or not it is installed.
import type { CachedMetadata, TFile } from "obsidian";
import { tagsOf } from "../core/project-lookup";

/** One log of a project. */
export interface ProjectLog {
  /** Vault path of the log note. */
  path: string;
  /** Name of the note without the date prefix ("21-10-2026 - 12h00 - "). */
  titulo: string;
  /** Epoch ms of the last request of the conversation (last entry heading, else the file name stamp, else the creation time). */
  data: number;
  /** "ativo", "arquivado" or whatever the note says. */
  status: string;
}

/** The part of the Obsidian App this query uses (a fake in the tests). */
export interface LogsApp {
  vault: { getMarkdownFiles(): TFile[] };
  metadataCache: { getFileCache(file: TFile): CachedMetadata | null };
}

const LOG_TAG = "log";

const fold = (s: string): string => s.normalize("NFD").replace(/[̀-ͯ]/g, "").trim().toLowerCase();

/** Every string inside a property value (a list, or the list of lists that an unquoted `[[Note]]` becomes). */
function strings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap((v) => strings(v));
  return [];
}

/**
 * Name of the note a `projeto` value points to: `[[Name]]`, `[[Name|alias]]`, `[[Folder/Name]]`,
 * `[[Name#heading]]` and plain `Name` all give `Name`.
 */
export function projectNameOf(value: string): string {
  const text = value.trim();
  const link = /^\[\[([^\]]*)\]\]$/.exec(text);
  let target = link ? (link[1] ?? "") : text;
  target = (target.split("|")[0] ?? "").split("#")[0] ?? "";
  target = target.replace(/\\/g, "/");
  const last = target.split("/").pop() ?? target;
  return last.replace(/\.md$/i, "").trim();
}

function dateFromName(name: string): number | undefined {
  const m = /(\d{2})-(\d{2})-(\d{4}) - (\d{2})h(\d{2})/.exec(name);
  return m ? new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]), Number(m[4]), Number(m[5])).getTime() : undefined;
}

function dateFromLastEntry(headings: string[]): number | undefined {
  for (let i = headings.length - 1; i >= 0; i--) {
    const m = /^(\d{2})\/(\d{2})\/(\d{4}) - (\d{2}):(\d{2})/.exec(headings[i] ?? "");
    if (m) return new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]), Number(m[4]), Number(m[5])).getTime();
  }
  return undefined;
}

function statusOf(cache: CachedMetadata, tags: string[]): string {
  const tag = tags.find((t) => t.startsWith("sessao/"))?.slice("sessao/".length);
  if (tag) return tag;
  const prop = strings(cache.frontmatter?.["Status da Sessão"])[0];
  return prop && prop.trim() !== "" ? prop.trim().toLowerCase() : "ativo";
}

/**
 * The conversation logs of a project: notes with the tag `log` and a `projeto` property that points
 * to the project note (with or without brackets, with an alias or a folder). Newest first.
 */
export function logsDoProjeto(app: LogsApp, projeto: string): ProjectLog[] {
  const wanted = fold(projectNameOf(projeto));
  if (wanted === "") return [];
  const out: ProjectLog[] = [];
  for (const file of app.vault.getMarkdownFiles()) {
    const cache = app.metadataCache.getFileCache(file);
    if (!cache) continue;
    const tags = tagsOf(cache);
    if (!tags.includes(LOG_TAG)) continue;
    if (!strings(cache.frontmatter?.projeto).some((v) => fold(projectNameOf(v)) === wanted)) continue;
    const headings = (cache.headings ?? []).filter((h) => h.level === 2).map((h) => h.heading);
    out.push({
      path: file.path,
      titulo: file.basename.replace(/^\d{2}-\d{2}-\d{4} - \d{2}h\d{2} - /, ""),
      data: dateFromLastEntry(headings) ?? dateFromName(file.basename) ?? file.stat.ctime,
      status: statusOf(cache, tags),
    });
  }
  return out.sort((a, b) => b.data - a.data);
}
