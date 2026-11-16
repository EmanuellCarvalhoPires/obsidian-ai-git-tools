// Matches a project name typed by the agent against the projects of the vault. Forgiving on
// purpose: with or without [[ ]], without case or accent differences, and by a unique prefix
// ("Timesheet Reports" finds "Timesheet Reports App" when it is the only one that starts so).
import type { ProjectInfo } from "./ports";

/** Lower case, no accents, no [[ ]] or "|alias", single spaces. */
export function normalizeProjectName(input: string): string {
  let text = input.trim();
  const wiki = /^\[\[(.*?)\]\]$/.exec(text);
  if (wiki) text = (wiki[1] ?? "").split("|")[0] ?? "";
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[_\-\s]+/g, " ")
    .trim();
}

export interface ProjectMatch {
  project?: ProjectInfo;
  /** Closest names, when there was no match (or the prefix was ambiguous). */
  sugestoes: string[];
}

function levenshtein(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0] ?? 0;
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const up = prev[j] ?? 0;
      prev[j] = Math.min(up + 1, (prev[j - 1] ?? 0) + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = up;
    }
  }
  return prev[b.length] ?? 0;
}

/**
 * Exact name (normalized) first; then a unique prefix. Without a match (or with an ambiguous prefix),
 * `sugestoes` lists the closest names (up to 3); a name that only contains the text is never picked.
 */
export function matchProject(list: ProjectInfo[], input: string): ProjectMatch {
  const key = normalizeProjectName(input);
  if (key === "") return { sugestoes: [] };
  const named = list.map((p) => ({ p, n: normalizeProjectName(p.name) }));
  const exact = named.filter((x) => x.n === key);
  if (exact.length >= 1) return { project: exact[0]?.p, sugestoes: [] };
  const prefix = named.filter((x) => x.n.startsWith(key));
  if (prefix.length === 1) return { project: prefix[0]?.p, sugestoes: [] };
  if (prefix.length > 1) return { sugestoes: prefix.slice(0, 3).map((x) => x.p.name) };
  const contains = named.filter((x) => x.n.includes(key));
  if (contains.length > 0) return { sugestoes: contains.slice(0, 3).map((x) => x.p.name) };
  const ranked = named
    .map((x) => ({ name: x.p.name, d: levenshtein(key, x.n.slice(0, Math.max(key.length, 1) + 3)) }))
    .sort((a, b) => a.d - b.d)
    .filter((x) => x.d <= Math.max(3, Math.floor(key.length / 2)));
  return { sugestoes: ranked.slice(0, 3).map((x) => x.name) };
}

/** " Quis dizer: A, B?" or an empty string. */
export function suggestionText(sugestoes: string[]): string {
  return sugestoes.length > 0 ? ` Quis dizer: ${sugestoes.join(", ")}?` : "";
}
