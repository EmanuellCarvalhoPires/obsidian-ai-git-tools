// Repository graph: parses `git log`, lays commits out in lanes and draws one SVG.
// Ported from the AI Log Manager (itself from the local mod bitbucket-branch-graph), with a highlight for the
// branch and commit of an event, so the same picture is used in the vault.

export interface Commit {
  hash: string;
  parents: string[];
  refs: string[];
  isHead: boolean;
  subject: string;
  /** Epoch seconds. */
  time: number;
  author: string;
}

export interface Segment {
  from: number;
  to: number;
  lane: number;
}

export interface Row {
  hash: string;
  subject: string;
  author: string;
  time: number;
  refs: string[];
  isHead: boolean;
  lane: number;
  segments: Segment[];
}

const US = "\x1f";
const RS = "\x1e";

/** Arguments of `git log` that `parseLog` understands. */
export const LOG_FORMAT = "--format=%H%x1f%P%x1f%D%x1f%s%x1f%ct%x1f%an%x1e";

/** `HEAD -> develop, origin/develop, origin/HEAD, tag: v1` into labels. */
export function parseDecoration(deco: string): { refs: string[]; isHead: boolean } {
  let isHead = false;
  const refs: string[] = [];
  for (const raw of deco.split(",").map((s) => s.trim()).filter(Boolean)) {
    if (raw === "HEAD") {
      isHead = true;
      refs.push("HEAD");
    } else if (raw.startsWith("HEAD -> ")) {
      isHead = true;
      refs.push(raw.slice("HEAD -> ".length));
    } else if (!raw.endsWith("/HEAD") && raw !== "refs/stash" && !raw.startsWith("refs/notes/")) {
      refs.push(raw);
    }
  }
  return { refs, isHead };
}

/** `git log` output (LOG_FORMAT) into commits, newest first. */
export function parseLog(out: string): Commit[] {
  return out
    .split(RS)
    .map((chunk) => chunk.replace(/^\s+/, ""))
    .filter((chunk) => chunk.length > 0)
    .map((chunk) => {
      const [hash = "", parents = "", deco = "", subject = "", ct = "0", author = ""] = chunk.split(US);
      const { refs, isHead } = parseDecoration(deco);
      return { hash, parents: parents.split(" ").filter(Boolean), refs, isHead, subject, time: Number(ct) || 0, author };
    });
}

/** Assigns each commit a lane and the segments that join its row to the next one. */
export function layout(commits: Commit[]): { rows: Row[]; lanes: number } {
  const lanes: Array<string | null> = [];
  const placed: Array<{ commit: Commit; lane: number; passing: Array<string | null>; after: Array<string | null>; parentLanes: number[] }> = [];
  let widest = 1;

  const slot = (): number => {
    const free = lanes.indexOf(null);
    if (free !== -1) return free;
    lanes.push(null);
    return lanes.length - 1;
  };

  for (const commit of commits) {
    let lane = lanes.indexOf(commit.hash);
    if (lane === -1) lane = slot();
    for (let j = 0; j < lanes.length; j += 1) if (lanes[j] === commit.hash) lanes[j] = null;
    const passing = [...lanes];

    const parentLanes: number[] = [];
    commit.parents.forEach((parent, i) => {
      const existing = lanes.indexOf(parent);
      if (existing !== -1) parentLanes.push(existing);
      else if (i === 0) {
        lanes[lane] = parent;
        parentLanes.push(lane);
      } else {
        const k = slot();
        lanes[k] = parent;
        parentLanes.push(k);
      }
    });

    while (lanes.length > 0 && lanes[lanes.length - 1] === null) lanes.pop();
    widest = Math.max(widest, lanes.length, lane + 1);
    placed.push({ commit, lane, passing, after: [...lanes], parentLanes });
  }

  const rows: Row[] = placed.map((cur, i) => {
    const following = placed[i + 1];
    const segments: Segment[] = [];
    cur.after.forEach((hash, j) => {
      if (hash === null) return;
      const to = following !== undefined && following.commit.hash === hash ? following.lane : j;
      if (cur.passing[j] === hash && j !== cur.lane) segments.push({ from: j, to, lane: j });
      if (cur.parentLanes.includes(j)) segments.push({ from: cur.lane, to, lane: cur.passing[j] === hash ? cur.lane : j });
    });
    return {
      hash: cur.commit.hash,
      subject: cur.commit.subject,
      author: cur.commit.author,
      time: cur.commit.time,
      refs: cur.commit.refs,
      isHead: cur.commit.isHead,
      lane: cur.lane,
      segments,
    };
  });

  return { rows, lanes: widest };
}

// ---------------------------------------------------------------- drawing

const PALETTE = ["#d97757", "#6a9bcc", "#7fa86b", "#a98bd4", "#d4a24c", "#5fa8a0", "#c7799e", "#8f8a80"];
const ROW_H = 40;
const LANE_W = 12;
const LANE_X = 9;
const MAX_LANES = 8;
const CHAR_W = 6.3;
const META_CHAR_W = 5.6;

const color = (lane: number): string => PALETTE[lane % PALETTE.length] ?? "#8f8a80";
const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function fit(text: string, px: number, charW: number): string {
  const room = Math.max(0, Math.floor(px / charW));
  if (text.length <= room) return text;
  return room <= 1 ? "" : `${text.slice(0, room - 1)}…`;
}

export function relativeAge(seconds: number, now: number): string {
  const d = Math.max(0, Math.round(now / 1000 - seconds));
  if (d < 60) return "agora";
  if (d < 3600) return `${Math.floor(d / 60)} min`;
  if (d < 86400) return `${Math.floor(d / 3600)} h`;
  if (d < 86400 * 30) return `${Math.floor(d / 86400)} d`;
  if (d < 86400 * 365) return `${Math.floor(d / (86400 * 30))} m`;
  return `${Math.floor(d / (86400 * 365))} a`;
}

export interface Highlight {
  /** Commit (full or abbreviated hash) to emphasize. */
  hash?: string;
  /** Branch whose labels are emphasized. */
  branch?: string;
}

function hashMatches(full: string, wanted: string | undefined): boolean {
  return !!wanted && wanted.length >= 4 && full.startsWith(wanted);
}

function labelMatches(ref: string, branch: string | undefined): boolean {
  if (!branch) return false;
  const name = ref.replace(/^tag: /, "");
  return name === branch || name.endsWith(`/${branch}`);
}

/** The graph as one SVG document: lanes on the left, subject over labels, age and hash per commit. */
export function toSvg(rows: Row[], lanes: number, now: number, width = 320, highlight: Highlight = {}): string {
  const W = Math.max(200, Math.round(width));
  const height = rows.length * ROW_H + 6;
  const shownLanes = Math.min(Math.max(1, lanes), MAX_LANES);
  const x = (lane: number): number => LANE_X + Math.min(lane, MAX_LANES - 1) * LANE_W;
  const y = (i: number): number => 3 + i * ROW_H + ROW_H / 2;
  const textX = LANE_X + (shownLanes - 1) * LANE_W + 14;
  const textW = W - textX - 6;
  const parts: string[] = [];

  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${height}" width="${W}" height="${height}" class="aigt-graph-svg" role="img" font-family="var(--font-interface, system-ui, sans-serif)">`,
    "<style>",
    ".subj{fill:var(--text-normal,#29261b);font-size:12.5px}.head{font-weight:600}.meta{fill:var(--text-muted,#83827d);font-size:10.5px}.ref{font-size:10.5px;font-weight:500}.rule{stroke:var(--background-modifier-border,#ccc);stroke-opacity:.5}.node{stroke:var(--background-primary,#fff)}.hl{fill:var(--interactive-accent,#d97757);fill-opacity:.12}",
    "</style>",
  );

  rows.forEach((row, i) => {
    if (hashMatches(row.hash, highlight.hash) || row.refs.some((r) => labelMatches(r, highlight.branch))) {
      parts.push(`<rect class="hl" x="0" y="${3 + i * ROW_H}" width="${W}" height="${ROW_H}"/>`);
    }
    if (i > 0) parts.push(`<line class="rule" x1="${textX}" x2="${W}" y1="${3 + i * ROW_H}" y2="${3 + i * ROW_H}"/>`);
  });

  rows.forEach((row, i) => {
    for (const s of row.segments) {
      const x1 = x(s.from);
      const x2 = x(s.to);
      const y1 = y(i);
      const y2 = i === rows.length - 1 ? height : y(i + 1);
      const mid = (y1 + y2) / 2;
      const d = x1 === x2 ? `M${x1} ${y1}V${y2}` : `M${x1} ${y1}C${x1} ${mid} ${x2} ${mid} ${x2} ${y2}`;
      parts.push(`<path d="${d}" stroke="${color(s.lane)}" stroke-width="1.6" fill="none" stroke-linecap="round" stroke-opacity=".9"/>`);
    }
  });

  rows.forEach((row, i) => {
    const cx = x(row.lane);
    const cy = y(i);
    const c = color(row.lane);
    const marked = hashMatches(row.hash, highlight.hash);
    if (row.isHead || marked) {
      parts.push(`<circle cx="${cx}" cy="${cy}" r="6" fill="none" stroke="${PALETTE[0]}" stroke-width="1.5"/>`);
      parts.push(`<circle class="node" cx="${cx}" cy="${cy}" r="3" fill="${PALETTE[0]}" stroke-width="1"/>`);
    } else {
      parts.push(`<circle class="node" cx="${cx}" cy="${cy}" r="3.5" fill="${c}" stroke-width="1.5"/>`);
    }

    parts.push(`<text class="${row.isHead || marked ? "subj head" : "subj"}" x="${textX}" y="${cy - 3}">${esc(fit(row.subject, textW, CHAR_W))}</text>`);

    const meta = `${relativeAge(row.time, now)} · ${row.hash.slice(0, 7)}`;
    const metaW = Math.ceil(meta.length * META_CHAR_W);
    let tx = textX;
    const labelRoom = textW - metaW - 8;
    let shown = 0;
    for (const ref of row.refs) {
      const isTag = ref.startsWith("tag: ");
      const label = isTag ? ref.slice(5) : ref;
      const w = Math.ceil(label.length * META_CHAR_W) + 10;
      if (tx + w - textX > labelRoom) {
        parts.push(`<text class="meta" x="${tx}" y="${cy + 12}">+${row.refs.length - shown}</text>`);
        tx += 20;
        break;
      }
      const isRemote = !isTag && /^(origin|upstream)\//.test(ref);
      const emphasized = labelMatches(ref, highlight.branch);
      const fill = isTag ? "#d4a24c" : emphasized || (row.isHead && !isRemote) ? PALETTE[0] : c;
      parts.push(
        `<rect x="${tx}" y="${cy + 3}" width="${w - 4}" height="13" rx="3" fill="${fill}" fill-opacity="${emphasized ? 0.32 : isRemote ? 0.08 : 0.18}" stroke="${fill}" stroke-opacity="${emphasized ? 0.9 : isRemote ? 0.45 : 0}" stroke-width="1"/>`,
      );
      parts.push(`<text class="ref" x="${tx + 3}" y="${cy + 13}" fill="${fill}">${esc(label)}</text>`);
      shown += 1;
      tx += w;
    }
    parts.push(`<text class="meta" x="${W - 6}" y="${cy + 13}" text-anchor="end">${esc(meta)}</text>`);
  });

  parts.push("</svg>");
  return parts.join("");
}
