// Development events (commit, push, branch, pull request, deploy) and the notes they become.
// Same note format and same event ids as the AI Log Manager (decision D7: no migration), so a note
// written by one module is recognized by the other. Only the graph block language is new.

export type DevEventType = "commit" | "push" | "branch" | "pr" | "deploy";

export const DEV_EVENT_TYPES: DevEventType[] = ["commit", "push", "branch", "pr", "deploy"];

export interface DevEvent {
  tipo: DevEventType;
  projeto: string;
  /** Stable key: the same event never makes two notes. Build it with the id helpers below. */
  id: string;
  titulo: string;
  data: Date;
  branch?: string;
  hash?: string;
  url?: string;
  autor?: string;
  detalhes?: string;
  /** pr: open, merged, declined. deploy: environment status. */
  estado?: string;
  ambiente?: string;
}

/** Language of the code block that draws the repository graph in the notes of this module. */
export const GRAPH_BLOCK_LANGUAGE = "ai-git-graph";

// ---------------------------------------------------------------- event ids
// The ids are the contract with the AI Log Manager: it writes the same ones in `evento_id`.

/** `commit-<hash>` (full hash). */
export const commitId = (hash: string): string => `commit-${hash}`;

/** `branch-<name>-<hash7>`. */
export const branchId = (name: string, hash: string): string => `branch-${name}-${hash.slice(0, 7)}`;

/** `push-<key>-<hash7>` where key is the remote-tracking name, e.g. "origin/main". */
export const pushId = (key: string, hash: string): string => `push-${key}-${hash.slice(0, 7)}`;

/** `pr-<host>-<repo>-<number>`, e.g. `pr-github-o/r-12`. */
export const prId = (host: "github" | "bitbucket", repo: string, number: number | string): string => `pr-${host}-${repo}-${String(number)}`;

const LABEL: Record<DevEventType, string> = { commit: "Commit", push: "Push", branch: "Branch", pr: "PR", deploy: "Deploy" };

export function isDevEventType(v: unknown): v is DevEventType {
  return typeof v === "string" && (DEV_EVENT_TYPES as string[]).includes(v);
}

/** Removes characters that Windows does not accept in file names. */
export function sanitizeFilename(name: string): string {
  return name.replace(/[\\/*?:"<>|]/g, "").trim();
}

const slug = (s: string): string => sanitizeFilename(s.replace(/[\\/]/g, "-")).replace(/\s+/g, " ").slice(0, 70).trim();

/** Vault path of the note of an event, inside the project's events folder. */
export function eventPath(folder: string, ev: DevEvent): string {
  const short = ev.hash ? ev.hash.slice(0, 7) : "";
  let name: string;
  switch (ev.tipo) {
    case "commit":
      name = `Commit ${short} - ${slug(ev.titulo)}`;
      break;
    case "push":
      name = `Push ${slug(ev.branch ?? "")} - ${short}`;
      break;
    case "branch":
      name = `Branch ${slug(ev.branch ?? ev.titulo)}`;
      break;
    case "pr":
      name = `PR ${slug(ev.id.split("-").pop() ?? ev.id)} - ${slug(ev.titulo)}`;
      break;
    default:
      name = `Deploy ${slug(ev.ambiente ?? "")} - ${slug(ev.id.split("-").pop() ?? ev.id)}`;
  }
  return `${folder}/${name.replace(/\s+-\s*$/, "").trim()}.md`;
}

const yamlString = (s: string): string => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

/** Content of the note of an event. The `ai-git-graph` block draws the repository graph when the note is open. */
export function renderEventNote(ev: DevEvent, indexNote: string): string {
  const fm = [
    "---",
    "tags:",
    `  - dev/${ev.tipo}`,
    `up: "[[${indexNote}]]"`,
    `projeto: "[[${ev.projeto}]]"`,
    `evento: ${ev.tipo}`,
    `evento_id: ${yamlString(ev.id)}`,
    `data: ${ev.data.toISOString()}`,
  ];
  if (ev.branch) fm.push(`branch: ${yamlString(ev.branch)}`);
  if (ev.hash) fm.push(`hash: ${ev.hash}`);
  if (ev.estado) fm.push(`estado: ${yamlString(ev.estado)}`);
  if (ev.ambiente) fm.push(`ambiente: ${yamlString(ev.ambiente)}`);
  fm.push("---");

  const rows: Array<[string, string]> = [["Projeto", `[[${ev.projeto}]]`]];
  if (ev.branch) rows.push(["Branch", `\`${ev.branch}\``]);
  if (ev.hash) rows.push(["Commit", `\`${ev.hash.slice(0, 7)}\``]);
  if (ev.autor) rows.push(["Autor", ev.autor]);
  if (ev.estado) rows.push(["Estado", ev.estado]);
  if (ev.ambiente) rows.push(["Ambiente", ev.ambiente]);
  rows.push(["Data", ev.data.toLocaleString("pt-BR")]);
  if (ev.url) rows.push(["Link", ev.url]);

  const body = [
    `# ${LABEL[ev.tipo]} - ${ev.titulo}`,
    "",
    "| Campo | Valor |",
    "| :-- | :-- |",
    ...rows.map(([k, v]) => `| ${k} | ${v.replace(/\|/g, "\\|")} |`),
    "",
  ];
  if (ev.detalhes) body.push(ev.detalhes.trim(), "");
  body.push("## Grafo do repositório", "", `\`\`\`${GRAPH_BLOCK_LANGUAGE}`, `projeto: ${ev.projeto}`);
  if (ev.branch) body.push(`branch: ${ev.branch}`);
  if (ev.hash) body.push(`hash: ${ev.hash}`);
  body.push("```", "");
  return `${fm.join("\n")}\n${body.join("\n")}`;
}

/** Value of `evento_id` in the frontmatter of a note's text, or undefined. */
export function eventIdOf(content: string): string | undefined {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content)?.[1];
  const raw = fm ? /^evento_id:\s*(.+?)\s*$/m.exec(fm)?.[1] : undefined;
  if (raw === undefined) return undefined;
  if (raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2) return raw.slice(1, -1).replace(/\\(["\\])/g, "$1");
  if (raw.startsWith("'") && raw.endsWith("'") && raw.length >= 2) return raw.slice(1, -1).replace(/''/g, "'");
  return raw;
}

/** Parameters of an `ai-git-graph` (or legacy `ai-log-graph`) block ("key: value" lines). */
export function parseGraphBlock(source: string): { projeto?: string; branch?: string; hash?: string; limite?: number } {
  const out: { projeto?: string; branch?: string; hash?: string; limite?: number } = {};
  for (const line of source.split("\n")) {
    const m = /^\s*(projeto|branch|hash|limite)\s*:\s*(.+?)\s*$/i.exec(line);
    if (!m) continue;
    const key = (m[1] ?? "").toLowerCase();
    const value = m[2] ?? "";
    if (key === "limite") {
      const n = Number(value);
      if (Number.isFinite(n) && n > 0) out.limite = Math.floor(n);
    } else if (key === "projeto") out.projeto = value;
    else if (key === "branch") out.branch = value;
    else out.hash = value;
  }
  return out;
}
