// Changelog note of a release, written from the git history of a project clone.
//
// Port of `DevService.changelog` of the AI Log Manager (same folder, same note name, same
// `dev/changelog` tag), with the extras of the plan (Fase 5, passo 8):
//   - the default range is "last tag up to HEAD" (`desde` and `ate` are optional refs, validated with
//     `assertRevision`). When HEAD is itself the tagged commit of a release, that release is the
//     subject of the note: the range goes from the tag before it to the tag, and `versao` is the tag.
//     Without any tag the range starts at the first commit;
//   - the items are grouped by merged pull request when there is one: a Bitbucket merge commit
//     ("Merged in <branch> (pull request #N)"), a GitHub merge commit ("Merge pull request #N from ...")
//     or a squash ("Title (#N)"). The commits that came in with a merged PR are listed under it. The
//     commits that belong to no PR are listed one by one under "Commits";
//   - the note lives in `<project folder>/<changelogsFolder>/<Project> - <versao>.md`, with the tag
//     `dev/changelog` written by this code (there is no template that could drop it). The index of
//     the releases (`<Project> - Changelog`, a Dataview list of the notes that point to it with `up`)
//     is created when it is missing.
// A release that already has its note (same project and same `versao`) is REWRITTEN with the current
// history instead of getting a second note: running the tool again only refreshes it.
import { GuardError } from "../guards";
import { assertRevision } from "../git/revision";
import type { GitRunner, ProjectInfo, VaultPort } from "../ports";
import { GRAPH_BLOCK_LANGUAGE, sanitizeFilename } from "./events";

/** Commits read for one changelog. */
export const CHANGELOG_COMMIT_LIMIT = 500;

export interface ChangelogOptions {
  /** Start ref (tag, branch or hash), exclusive. Default: the last tag before `ate`; without tags, the first commit. */
  desde?: string;
  /** End ref, inclusive. Default: HEAD. */
  ate?: string;
  /** Name of the release. Default: the tag at `ate`, else today's date (yyyy-mm-dd). */
  versao?: string;
}

export interface ChangelogCommit {
  hash: string;
  titulo: string;
  autor: string;
}

export interface ChangelogItem {
  /** `pr`: a merged pull request (with the commits that came with it); `commit`: a commit of no PR. */
  tipo: "pr" | "commit";
  /** Number of the PR (only for `pr`). */
  numero?: number;
  titulo: string;
  /** The merge commit or squash of the PR, or the commit. */
  hash: string;
  autor: string;
  /** The commits of the PR branch, newest first (only for `pr` made by a merge commit). */
  commits: ChangelogCommit[];
}

export interface ChangelogResult {
  /** Vault path of the note. */
  path: string;
  /** False when the note of this release already existed and was rewritten. */
  created: boolean;
  /** True when an existing note was rewritten. */
  updated: boolean;
  /** True when the folder index was created by this call. */
  indexCreated: boolean;
  versao: string;
  desde: string | undefined;
  ate: string;
  /** Commits in the range. */
  commits: number;
  /** Merged pull requests found in the range. */
  prs: number;
  itens: ChangelogItem[];
  /** The range had more commits than the limit; the oldest ones are not listed. */
  truncado: boolean;
}

export interface ChangelogDeps {
  git: GitRunner;
  vault: Pick<VaultPort, "exists" | "create" | "process">;
  /** Name of the changelogs folder inside the project folder (default "Changelogs"). */
  folderName: string;
  now?: () => number;
}

interface RawCommit {
  hash: string;
  parents: string[];
  autor: string;
  assunto: string;
  corpo: string;
}

const US = "\x1f";
const RS = "\x1e";
const FORMAT = "--format=%H%x1f%P%x1f%an%x1f%s%x1f%b%x1e";

const yamlString = (s: string): string => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

async function tryGit(git: GitRunner, cwd: string, args: string[]): Promise<string | undefined> {
  try {
    return (await git(cwd, args)).trim() || undefined;
  } catch {
    return undefined;
  }
}

function parseCommits(out: string): RawCommit[] {
  return out
    .split(RS)
    .map((chunk) => chunk.replace(/^\s+/, ""))
    .filter((chunk) => chunk !== "")
    .map((chunk) => {
      const [hash = "", parents = "", autor = "", assunto = "", ...rest] = chunk.split(US);
      return { hash, parents: parents.split(" ").filter(Boolean), autor, assunto, corpo: rest.join(US).trim() };
    });
}

const TRAILER = /^(Approved-by|Reviewed-by|Co-authored-by|Signed-off-by|Merged-by|Acked-by):/i;
const firstLine = (body: string): string | undefined => body.split(/\r?\n/).map((l) => l.trim()).find((l) => l !== "" && !TRAILER.test(l));

interface PrMatch {
  numero: number;
  titulo: string;
  /** A merge commit: the commits of the PR branch come with it. */
  merge: boolean;
}

/** The pull request a commit stands for, if any (Bitbucket merge, GitHub merge or squash). */
export function pullRequestOf(c: { parents: string[]; assunto: string; corpo: string }): PrMatch | undefined {
  const merge = c.parents.length >= 2;
  const bb = /^Merged in (\S+) \(pull request #(\d+)\)/.exec(c.assunto);
  if (bb?.[2]) return { numero: Number(bb[2]), titulo: firstLine(c.corpo) ?? bb[1] ?? c.assunto, merge };
  const gh = /^Merge pull request #(\d+) from (\S+)/.exec(c.assunto);
  if (gh?.[1]) return { numero: Number(gh[1]), titulo: firstLine(c.corpo) ?? gh[2] ?? c.assunto, merge };
  const squash = /^(.*?)\s*\((?:pull request )?#(\d+)\)\s*$/.exec(c.assunto);
  if (squash?.[2]) return { numero: Number(squash[2]), titulo: squash[1] !== "" ? (squash[1] ?? c.assunto) : c.assunto, merge: false };
  return undefined;
}

async function resolveCommit(git: GitRunner, cwd: string, ref: string, label: string): Promise<string> {
  const hash = await tryGit(git, cwd, ["rev-parse", "--verify", "-q", `${ref}^{commit}`]);
  if (hash === undefined) throw new GuardError(`A referência "${ref}" (${label}) não existe no repositório.`);
  return hash;
}

function localDate(ms: number): string {
  const d = new Date(ms);
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function cleanVersion(raw: string): string {
  const v = raw.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();
  if (v === "") throw new GuardError('"versao" não pode ser vazia.');
  if (v.length > 80) throw new GuardError('"versao" tem mais de 80 caracteres.');
  return v;
}

function indexNote(project: string): string {
  return (
    `---\ntags:\n  - moc\nup: "[[${project}]]"\n---\n# ${project} - Changelog\n\nUma nota por release, gerada pela tool git_changelog do AI Git Tools.\n\n` +
    '```dataview\nTABLE WITHOUT ID file.link AS "Nota", file.ctime AS "Criada em"\nFROM [[]]\n' +
    "WHERE contains(flat(list(up)), this.file.link)\nSORT file.ctime DESC\n```\n"
  );
}

function renderNote(project: ProjectInfo, versao: string, desde: string | undefined, ate: string, date: string, itens: ChangelogItem[], total: number, prs: number, truncado: boolean): string {
  const name = `${project.name} - ${versao}`;
  const lines = [
    "---",
    "tags:",
    "  - dev/changelog",
    `up: "[[${project.name} - Changelog]]"`,
    `projeto: "[[${project.name}]]"`,
    `versao: ${yamlString(versao)}`,
    ...(desde ? [`desde: ${yamlString(desde)}`] : []),
    `ate: ${yamlString(ate)}`,
    `data: ${date}`,
    `commits: ${total}`,
    "---",
    `# ${name}`,
    "",
    `Alterações ${desde ? `de \`${desde}\` até \`${ate}\`` : `desde o primeiro commit até \`${ate}\``} (${total} commit${total === 1 ? "" : "s"}${prs > 0 ? `, ${prs} pull request${prs === 1 ? "" : "s"}` : ""}).`,
    "",
  ];
  if (truncado) lines.push(`> O intervalo tem mais de ${CHANGELOG_COMMIT_LIMIT} commits; os mais antigos não estão listados.`, "");
  const pullRequests = itens.filter((i) => i.tipo === "pr");
  if (pullRequests.length > 0) {
    lines.push("## Pull requests", "");
    for (const pr of pullRequests) {
      lines.push(`- #${pr.numero ?? "?"} ${pr.titulo} (\`${pr.hash.slice(0, 7)}\`, ${pr.autor})`);
      for (const c of pr.commits) lines.push(`  - \`${c.hash.slice(0, 7)}\` ${c.titulo} (${c.autor})`);
    }
    lines.push("");
  }
  const commits = itens.filter((i) => i.tipo === "commit");
  lines.push("## Commits", "");
  if (commits.length > 0) for (const c of commits) lines.push(`- \`${c.hash.slice(0, 7)}\` ${c.titulo} (${c.autor})`);
  else lines.push(pullRequests.length > 0 ? "- Nenhum commit fora dos pull requests." : "- Nenhum commit no intervalo.");
  lines.push("", "## Grafo do repositório", "", `\`\`\`${GRAPH_BLOCK_LANGUAGE}`, `projeto: ${project.name}`, "```", "");
  return lines.join("\n");
}

/**
 * Writes (or rewrites) the changelog note of a release of `project`, whose clone is `cwd`.
 * Throws GuardError for a bad ref or version, and the GitError of the runner for a git failure.
 */
export async function writeChangelog(deps: ChangelogDeps, project: ProjectInfo, cwd: string, options: ChangelogOptions = {}): Promise<ChangelogResult> {
  const { git, vault } = deps;
  const ateRef = options.ate !== undefined ? assertRevision(options.ate) : "HEAD";
  const desdeRef = options.desde !== undefined ? assertRevision(options.desde) : undefined;
  const versaoGiven = options.versao !== undefined ? cleanVersion(options.versao) : undefined;

  const ateHash = await resolveCommit(git, cwd, ateRef, "ate");
  if (desdeRef !== undefined) await resolveCommit(git, cwd, desdeRef, "desde");

  // The tag that names the release: the one at the end of the range, if there is one.
  const exact = await tryGit(git, cwd, ["describe", "--tags", "--exact-match", ateHash]);
  let desde = desdeRef;
  if (desde === undefined) desde = await tryGit(git, cwd, ["describe", "--tags", "--abbrev=0", exact !== undefined ? `${ateHash}^` : ateHash]);
  const versao = versaoGiven ?? exact ?? localDate((deps.now ?? Date.now)());

  const range = desde !== undefined ? `${desde}..${ateHash}` : ateHash;
  const raw = parseCommits(await git(cwd, ["log", range, FORMAT, "-n", String(CHANGELOG_COMMIT_LIMIT)]));
  const truncado = raw.length >= CHANGELOG_COMMIT_LIMIT;
  const inRange = new Set(raw.map((c) => c.hash));

  // Group: PRs first (a merge commit takes the commits of its branch with it), then the loose commits.
  const itens: ChangelogItem[] = [];
  const covered = new Set<string>();
  const seenPr = new Set<number>();
  const byHash = new Map(raw.map((r) => [r.hash, r]));
  for (const c of raw) {
    const pr = pullRequestOf(c);
    if (!pr || seenPr.has(pr.numero) || covered.has(c.hash)) continue;
    seenPr.add(pr.numero);
    covered.add(c.hash);
    const members: ChangelogCommit[] = [];
    const [first, second] = c.parents;
    if (pr.merge && first && second) {
      const out = await tryGit(git, cwd, ["rev-list", `${first}..${second}`, "-n", String(CHANGELOG_COMMIT_LIMIT)]);
      for (const h of out ? out.split(/\r?\n/) : []) {
        const m = byHash.get(h);
        if (!m || !inRange.has(h)) continue;
        covered.add(h);
        members.push({ hash: m.hash, titulo: m.assunto, autor: m.autor });
      }
    }
    itens.push({ tipo: "pr", numero: pr.numero, titulo: pr.titulo, hash: c.hash, autor: c.autor, commits: members });
  }
  for (const c of raw) {
    if (!covered.has(c.hash)) itens.push({ tipo: "commit", titulo: c.assunto, hash: c.hash, autor: c.autor, commits: [] });
  }

  const date = localDate((deps.now ?? Date.now)());
  const body = renderNote(project, versao, desde, ateRef, date, itens, raw.length, seenPr.size, truncado);
  const folder = `${project.folder}/${deps.folderName}`;
  const path = `${folder}/${sanitizeFilename(`${project.name} - ${versao}`)}.md`;

  let indexCreated = false;
  const indexPath = `${folder}/${sanitizeFilename(`${project.name} - Changelog`)}.md`;
  if (!vault.exists(indexPath)) {
    await vault.create(indexPath, indexNote(project.name));
    indexCreated = true;
  }
  const existed = vault.exists(path);
  if (existed) await vault.process(path, () => body);
  else await vault.create(path, body);

  return { path, created: !existed, updated: existed, indexCreated, versao, desde, ate: ateRef, commits: raw.length, prs: seenPr.size, itens, truncado };
}
