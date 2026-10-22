// Draws a repository graph (an SVG string from the history service) inside an element, without
// innerHTML. Two users: the ```ai-git-graph code block of the event notes, and the module screen
// (which calls `renderGraphInto` directly).
//
// CSS classes used here (the stylesheet belongs to the screen task): `aigt-graph-block` (the block
// container), `aigt-graph` (wrapper of the SVG), `aigt-empty` and `aigt-muted` (messages). The SVG
// itself carries `aigt-graph-svg` and takes its colors from the Obsidian theme variables.
import { parseGraphBlock, GRAPH_BLOCK_LANGUAGE } from "../core/history/events";
import type { HistoryService } from "../core/history/history-service";
import type { ProjectLookup } from "../core/ports";
import { t } from "../i18n";

/** What the graph needs from the plugin. Both members are `Pick`s so tests and other callers can pass small fakes. */
export interface GraphDeps {
  history: Pick<HistoryService, "graph">;
  projects: Pick<ProjectLookup, "byName">;
}

/** Parameters of a graph: the same ones the code block accepts, plus the drawing width. */
export interface GraphOptions {
  /** Name of the project note. Required: without it a message is shown. */
  projeto?: string;
  /** Branch whose labels are emphasized. */
  branch?: string;
  /** Commit (full or abbreviated hash) to emphasize. */
  hash?: string;
  /** Number of commits drawn (default of the history service: 60). */
  limite?: number;
  /** Width of the SVG in pixels (default: 440). */
  width?: number;
}

/** Width of the graph inside a note, when the block does not say. */
export const BLOCK_GRAPH_WIDTH = 440;

/** Parses an SVG string and appends it to `parent`. Anything that is not an `<svg>` root is dropped. */
export function appendSvg(parent: HTMLElement, svg: string): void {
  const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
  const root = doc.documentElement;
  if (root.nodeName.toLowerCase() !== "svg") return;
  parent.appendChild(parent.ownerDocument.importNode(root, true));
}

function message(el: HTMLElement, text: string): false {
  el.createDiv({ text, cls: "aigt-empty aigt-muted" });
  return false;
}

/**
 * Renders the graph of a project into `el` (the element is emptied first).
 *
 * Returns true when a graph was drawn. Returns false, after writing a clear message into `el`, when
 * the project is not given, is unknown, has no clone, has no commits yet, or the repository could
 * not be read. Never throws.
 */
export async function renderGraphInto(el: HTMLElement, deps: GraphDeps, opts: GraphOptions): Promise<boolean> {
  el.empty();
  const name = opts.projeto?.trim();
  if (!name) return message(el, t("graph.missingProject"));
  try {
    const project = await deps.projects.byName(name);
    if (!project) return message(el, t("graph.noProject", { name }));
    if (!project.clonePath) return message(el, t("graph.noClone", { name: project.name }));
    const g = await deps.history.graph(project, {
      limit: opts.limite,
      width: opts.width,
      highlight: { branch: opts.branch, hash: opts.hash },
    });
    if (g.rows.length === 0) return message(el, t("graph.empty"));
    appendSvg(el.createDiv({ cls: "aigt-graph" }), g.svg);
    return true;
  } catch (err) {
    return message(el, t("graph.failed", { reason: err instanceof Error ? err.message : String(err) }));
  }
}

/** The registration function of the plugin (`registerMarkdownCodeBlockProcessor`). */
export type RegisterCodeBlock = (language: string, handler: (source: string, el: HTMLElement) => void | Promise<void>) => unknown;

/**
 * Registers the processor of the ```ai-git-graph block. Parameters, one `key: value` per line:
 * `projeto`, `branch`, `hash`, `limite`. The alias `ai-log-graph` is NOT registered here (phase 9).
 */
export function registerGraphBlock(register: RegisterCodeBlock, deps: () => GraphDeps): void {
  register(GRAPH_BLOCK_LANGUAGE, async (source, el) => {
    const box = el.createDiv({ cls: "aigt-graph-block" });
    await renderGraphInto(box, deps(), { ...parseGraphBlock(source), width: BLOCK_GRAPH_WIDTH });
  });
}
