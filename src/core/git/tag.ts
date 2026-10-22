// git_tag: listar (`for-each-ref refs/tags`) and criar (`git tag -a <nome> -F - <commit>`, message
// through stdin). Existing tags are never replaced and there is no deletion.
import { GitError } from "../git-runner";
import { GuardError, assertRefName, rejectForbiddenFlags } from "../guards";
import type { GitRunner } from "../ports";
import { assertRevision, refExists } from "./revision";

export const TAG_LIST_LIMIT = 200;

export interface TagArgs {
  acao: string;
  nome?: string;
  commit?: string;
  mensagem?: string;
}

export interface TagInfo {
  nome: string;
  /** Commit the tag points to. */
  hash: string;
  anotada: boolean;
  data: string;
  assunto: string;
}

export type TagResult =
  | { acao: "listar"; tags: TagInfo[]; total: number; truncado: boolean }
  | { acao: "criar"; nome: string; hash: string; mensagem: string };

const SEP_FIELD = "%1f";
const SEP_RECORD = "%1e";

export async function listTags(git: GitRunner, root: string): Promise<TagInfo[]> {
  const format = ["%(refname:short)", "%(objecttype)", "%(objectname)", "%(*objectname)", "%(creatordate:iso-strict)", "%(contents:subject)"].join(SEP_FIELD) + SEP_RECORD;
  const out = await git(root, ["for-each-ref", "refs/tags", "--sort=-creatordate", `--format=${format}`]);
  const tags: TagInfo[] = [];
  for (const rec of out.split("\x1e")) {
    const text = rec.replace(/^\r?\n/, "");
    if (text.trim() === "") continue;
    const [nome = "", tipo = "", objeto = "", apontado = "", data = "", assunto = ""] = text.split("\x1f");
    tags.push({ nome, hash: apontado !== "" ? apontado : objeto, anotada: tipo === "tag", data, assunto });
  }
  return tags;
}

export async function gitTag(git: GitRunner, root: string, args: TagArgs): Promise<TagResult> {
  if (args.acao !== "listar" && args.acao !== "criar") {
    throw new GuardError(`Ação inválida: ${String(args.acao)} (use listar ou criar; apagar tag não existe).`);
  }

  if (args.acao === "listar") {
    if (args.nome !== undefined || args.commit !== undefined || args.mensagem !== undefined) {
      throw new GuardError("nome, commit e mensagem só valem com acao=criar.");
    }
    const all = await listTags(git, root);
    return { acao: "listar", tags: all.slice(0, TAG_LIST_LIMIT), total: all.length, truncado: all.length > TAG_LIST_LIMIT };
  }

  if (typeof args.nome !== "string" || args.nome.trim() === "") throw new GuardError('"nome" é obrigatório para criar a tag.');
  if (typeof args.mensagem !== "string" || args.mensagem.trim() === "") throw new GuardError('"mensagem" é obrigatória: a tag é anotada (git tag -a).');
  if (args.mensagem.includes("\0")) throw new GuardError("A mensagem não pode ter caractere nulo.");
  const nome = args.nome;
  await assertRefName(nome, { git, cwd: root });
  try {
    await git(root, ["check-ref-format", `refs/tags/${nome}`]);
  } catch {
    throw new GuardError(`Nome de tag recusado pelo git: ${nome}`);
  }
  const commit = assertRevision(args.commit ?? "HEAD");
  if (await refExists(git, root, `refs/tags/${nome}`)) throw new GuardError(`A tag ${nome} já existe (tags não são substituídas nem apagadas).`);

  let hash: string;
  try {
    hash = (await git(root, ["rev-parse", "--verify", "-q", `${commit}^{commit}`])).trim();
  } catch (err) {
    if (err instanceof GitError && err.codigo === 1) throw new GuardError(`Commit não encontrado: ${commit}`);
    throw err;
  }

  const argv = ["tag", "-a", nome, "-F", "-", "--cleanup=whitespace", hash];
  rejectForbiddenFlags(argv);
  const mensagem = `${args.mensagem.replace(/\r\n/g, "\n").trim()}\n`;
  await git(root, argv, { input: mensagem });
  return { acao: "criar", nome, hash, mensagem: mensagem.trimEnd() };
}
