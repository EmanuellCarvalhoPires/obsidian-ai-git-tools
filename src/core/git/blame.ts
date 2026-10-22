// git_blame: who last changed each line of a file (`git blame --porcelain`).
import { GuardError, assertPathspec, rejectForbiddenFlags } from "../guards";
import type { GitRunner } from "../ports";
import { assertRevision } from "./diff";

/** Safety cap: a blame of a huge file would fill the answer. */
export const BLAME_MAX_LINES = 2000;

export interface BlameArgs {
  caminho: string;
  linhaInicio?: number;
  linhaFim?: number;
  ref?: string;
}

export interface BlameLine {
  linha: number;
  hash: string;
  autor: string;
  email: string;
  /** Author date, ISO 8601 in UTC. */
  data: string;
  resumo: string;
  conteudo: string;
}

export interface BlameResult {
  caminho: string;
  linhas: BlameLine[];
  truncado: boolean;
}

interface CommitMeta {
  autor: string;
  email: string;
  data: string;
  resumo: string;
}

const HEADER = /^([0-9a-f]{40,64}) (\d+) (\d+)(?: (\d+))?$/;

/** Parses the output of `git blame --porcelain`. */
export function parseBlame(raw: string): BlameLine[] {
  const metas = new Map<string, CommitMeta>();
  const lines: BlameLine[] = [];
  let current: { hash: string; final: number } | undefined;
  for (const text of raw.split("\n")) {
    if (text.startsWith("\t")) {
      if (!current) continue;
      const meta = metas.get(current.hash) ?? { autor: "", email: "", data: "", resumo: "" };
      lines.push({ linha: current.final, hash: current.hash, ...meta, conteudo: text.slice(1).replace(/\r$/, "") });
      current = undefined;
      continue;
    }
    const header = HEADER.exec(text);
    if (header) {
      current = { hash: header[1] ?? "", final: Number(header[3]) };
      if (!metas.has(current.hash)) metas.set(current.hash, { autor: "", email: "", data: "", resumo: "" });
      continue;
    }
    if (!current) continue;
    const meta = metas.get(current.hash);
    if (!meta) continue;
    const at = text.indexOf(" ");
    const key = at < 0 ? text : text.slice(0, at);
    const value = at < 0 ? "" : text.slice(at + 1);
    if (key === "author") meta.autor = value;
    else if (key === "author-mail") meta.email = value.replace(/^<|>$/g, "");
    else if (key === "author-time") meta.data = new Date(Number(value) * 1000).toISOString();
    else if (key === "summary") meta.resumo = value;
  }
  return lines;
}

export async function gitBlame(git: GitRunner, root: string, args: BlameArgs): Promise<BlameResult> {
  const [caminho] = assertPathspec([args.caminho]);
  const { linhaInicio, linhaFim } = args;
  for (const n of [linhaInicio, linhaFim]) {
    if (n !== undefined && (!Number.isInteger(n) || n < 1)) throw new GuardError("As linhas começam em 1 e são números inteiros.");
  }
  if (linhaInicio !== undefined && linhaFim !== undefined && linhaFim < linhaInicio) throw new GuardError("linha_fim não pode ser menor que linha_inicio.");

  const argv = ["blame", "--porcelain"];
  if (linhaInicio !== undefined || linhaFim !== undefined) argv.push("-L", `${linhaInicio ?? 1},${linhaFim ?? ""}`);
  if (args.ref !== undefined) argv.push(assertRevision(args.ref));
  rejectForbiddenFlags(argv);
  argv.push("--", caminho ?? "");

  const lines = parseBlame(await git(root, argv));
  const truncado = lines.length > BLAME_MAX_LINES;
  return { caminho: caminho ?? "", linhas: truncado ? lines.slice(0, BLAME_MAX_LINES) : lines, truncado };
}
