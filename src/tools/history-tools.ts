// The documentation tools: git_graph, git_changelog, git_sync and git_registrar_evento. They work
// on a PROJECT (`projeto` = the name of a note tagged dev/projeto, resolved by the ProjectTracker),
// not on a repository path: the notes they write live in that project's folder of the vault.
// Ownership: these four tools are the owner of the task in the AI Ecosystem. The equivalent dev_graph, dev_changelog,
// dev_sync and dev_record_event tools of the AI Log Manager have to be switched off in that module (not done in this
// repository), so that each task has a single owner. Ported from them.
//
// An unknown project, or one whose note has no clone (or whose clone is not a git repository), is
// `argumento_invalido` with the list of the projects that can be used.
//
// Ids of git_registrar_evento (the one that makes the event "once"):
//   - tipo commit with `hash`: `commit-<full hash>` (the hash is resolved in the clone), the id of
//     the watcher and of git_commit, so the note is never written twice;
//   - tipo branch with `branch` and `hash`: `branch-<branch>-<hash7>`, same reason;
//   - anything else: `<tipo>-<branch>-<hash>-<titulo>` with only the parts given, joined by "-"
//     (the format of dev_record_event of the AI Log Manager; `hash` as typed).
// Repeating the call with the same data finds the note by its id and creates nothing (`criado: false`).
//
// This file is imported by git-tools.ts (GIT_TOOL_FACTORIES) and imports helpers from it; nothing
// here uses those helpers while the module loads, so the import cycle is harmless.
import { assertRevision } from "../core/git/revision";
import { assertRefNameSyntax, GuardError } from "../core/guards";
import { branchId, commitId, DEV_EVENT_TYPES, isDevEventType, prId } from "../core/history/events";
import type { DevEvent } from "../core/history/events";
import type { RemoteSyncResult } from "../core/history/remote-sync";
import type { ProjectInfo } from "../core/ports";
import { readRemote } from "../core/repo-resolver";
import type { HubTool, HubToolResult } from "../ecosystem/types";
import { assertKnownArgs, optBool, optInt, optString, reqString } from "./git-tools";
import type { Args, GitToolDeps, ToolAnnotations } from "./git-tools";
import { fail, fromError, ok } from "./results";
import { GIT_CHANGELOG_SCHEMA, GIT_GRAPH_SCHEMA, GIT_REGISTRAR_EVENTO_SCHEMA, GIT_SYNC_SCHEMA } from "./schemas";
import type { JsonSchema } from "./schemas";

// Literal (not spread from git-tools.ts) so that the module can load before git-tools.ts finishes.
const READ_ONLY_DOC: ToolAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
/** Writes notes in the vault, nothing else; running it again gives the same result. */
const WRITE_VAULT: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };
/** git_sync may read the remote (GitHub or Bitbucket). */
const WRITE_VAULT_REMOTE: ToolAnnotations = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true };

type HistoryDeps = GitToolDeps & { history: NonNullable<GitToolDeps["history"]> };

const projectNames = (list: ProjectInfo[]): string => (list.length > 0 ? list.map((p) => p.name).join(", ") : "nenhum");

/** The project of `name`, with a clone that is a git repository. Throws GuardError (argumento_invalido) otherwise. */
async function resolveProject(deps: HistoryDeps, name: string): Promise<ProjectInfo> {
  const lookup = deps.tracker ?? deps.projects;
  const project = await lookup.byName(name);
  if (!project) {
    throw new GuardError(`Projeto "${name}" não encontrado. Projetos com a tag dev/projeto: ${projectNames(await lookup.list())}. Use o nome do projeto, não um caminho.`);
  }
  if (!project.clonePath) {
    throw new GuardError(`O projeto "${project.name}" não tem clone local: a nota do projeto precisa da linha "Clone local" com a pasta do repositório.`);
  }
  if ((await deps.history.repoOf(project)) === undefined) {
    throw new GuardError(`A pasta do clone do projeto "${project.name}" (${project.clonePath}) não é um repositório git.`);
  }
  return project;
}

interface ProjectToolSpec {
  name: string;
  title: string;
  description: string;
  inputSchema: JsonSchema;
  annotations: ToolAnnotations;
  run(deps: HistoryDeps, args: Args): Promise<HubToolResult>;
}

function defineHistoryTool(deps: HistoryDeps, spec: ProjectToolSpec): HubTool {
  return {
    name: spec.name,
    title: spec.title,
    description: spec.description,
    inputSchema: spec.inputSchema,
    annotations: spec.annotations,
    handler: async (args) => {
      try {
        assertKnownArgs(args, spec.inputSchema);
        return await spec.run(deps, args);
      } catch (err) {
        return fromError(err, deps.redact);
      }
    },
  };
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

// ---------------------------------------------------------------------------
// git_graph
// ---------------------------------------------------------------------------

function graphTool(deps: HistoryDeps): HubTool {
  return defineHistoryTool(deps, {
    name: "git_graph",
    title: "Grafo do repositório",
    description:
      "Desenha o grafo de commits de um projeto (os mais novos de todas as branches). Por padrão devolve só as linhas em texto (formato texto); formato arquivo grava o SVG na pasta Anexos do projeto e devolve o caminho; formato svg devolve o SVG inteiro na resposta (caro). branch e hash destacam uma branch e um commit. Só lê (o formato arquivo só grava no cofre).",
    inputSchema: GIT_GRAPH_SCHEMA,
    annotations: READ_ONLY_DOC,
    async run(d, args) {
      const project = await resolveProject(d, reqString(args, "projeto"));
      const branch = optString(args, "branch");
      const hash = optString(args, "hash");
      const limite = optInt(args, "limite");
      const formato = optString(args, "formato") ?? "texto";
      if (formato !== "texto" && formato !== "arquivo" && formato !== "svg") {
        throw new GuardError(`formato inválido: ${formato} (use texto, arquivo ou svg).`);
      }
      if (branch !== undefined) assertRefNameSyntax(branch);
      if (hash !== undefined) assertRevision(hash);
      let g: Awaited<ReturnType<typeof d.history.graph>>;
      try {
        g = await d.history.graph(project, { ...(limite !== undefined ? { limit: limite } : {}), highlight: { ...(branch !== undefined ? { branch } : {}), ...(hash !== undefined ? { hash } : {}) } });
      } catch {
        // An empty repository has no commits yet.
        g = { rows: [], lanes: 0, svg: "" };
      }
      const header = `Grafo de ${project.name}: ${plural(g.rows.length, "commit", "commits")} em ${plural(g.lanes, "faixa", "faixas")}.`;
      if (g.rows.length === 0) {
        return ok(`${header}\nO repositório ainda não tem commits.`, { projeto: project.name, commits: 0, faixas: g.lanes, formato });
      }
      const text = g.rows.map((r) => `${"| ".repeat(r.lane)}* ${r.hash.slice(0, 7)}${r.refs.length > 0 ? ` (${r.refs.join(", ")})` : ""} ${r.subject} - ${r.author}`);
      const corpo = `${header}\n${text.join("\n")}`;
      if (formato === "arquivo") {
        const caminho = await d.history.saveGraphSvg(project, g.svg);
        return ok(`${corpo}\n\nSVG gravado em ${caminho}`, { projeto: project.name, commits: g.rows.length, faixas: g.lanes, formato, caminho });
      }
      if (formato === "svg") {
        const linhas = g.rows.map((r) => ({
          hash: r.hash,
          hash_curto: r.hash.slice(0, 7),
          assunto: r.subject,
          autor: r.author,
          data: new Date(r.time * 1000).toISOString(),
          refs: r.refs,
          faixa: r.lane,
          head: r.isHead,
        }));
        return ok(`${corpo}\n\nSVG:\n${g.svg}`, { projeto: project.name, commits: g.rows.length, faixas: g.lanes, formato, linhas, svg: g.svg });
      }
      return ok(corpo, { projeto: project.name, commits: g.rows.length, faixas: g.lanes, formato });
    },
  });
}

// ---------------------------------------------------------------------------
// git_changelog
// ---------------------------------------------------------------------------

function changelogTool(deps: HistoryDeps): HubTool {
  return defineHistoryTool(deps, {
    name: "git_changelog",
    title: "Changelog de release",
    description:
      "Grava a nota de changelog de uma release do projeto (pasta Changelogs, tag dev/changelog) a partir do git: do último tag até HEAD por padrão, ou de desde até ate. Agrupa por PR mesclado quando há (merge do Bitbucket ou do GitHub, squash com (#N)) e por commit quando não. A mesma versão reescreve a nota em vez de criar outra. Cria o índice de releases se faltar.",
    inputSchema: GIT_CHANGELOG_SCHEMA,
    annotations: WRITE_VAULT,
    async run(d, args) {
      const project = await resolveProject(d, reqString(args, "projeto"));
      const desde = optString(args, "desde");
      const ate = optString(args, "ate");
      const versao = optString(args, "versao");
      const res = await d.history.changelog(project, { ...(desde !== undefined ? { desde } : {}), ...(ate !== undefined ? { ate } : {}), ...(versao !== undefined ? { versao } : {}) });
      const quando = res.created ? "criada" : "atualizada";
      const faixa = res.desde !== undefined ? `de ${res.desde} até ${res.ate}` : `desde o primeiro commit até ${res.ate}`;
      const avisos: string[] = [];
      if (res.truncado) avisos.push("O intervalo tem mais de 500 commits: os mais antigos não entraram na nota.");
      if (res.commits === 0) avisos.push("Nenhum commit no intervalo.");
      const itens = res.itens.map((i) => ({ tipo: i.tipo, ...(i.numero !== undefined ? { numero: i.numero } : {}), titulo: i.titulo, hash: i.hash, autor: i.autor, commits: i.commits.length }));
      const resumo = itens.map((i) => (i.tipo === "pr" ? `- #${i.numero ?? "?"} ${i.titulo}` : `- ${i.hash.slice(0, 7)} ${i.titulo}`));
      return ok(
        `Nota de changelog ${quando}: ${res.path}\nVersão ${res.versao}, ${faixa}: ${plural(res.commits, "commit", "commits")}${res.prs > 0 ? `, ${plural(res.prs, "pull request", "pull requests")}` : ""}.${resumo.length > 0 ? `\n${resumo.join("\n")}` : ""}`,
        {
          projeto: project.name,
          caminho: res.path,
          criada: res.created,
          atualizada: res.updated,
          indice_criado: res.indexCreated,
          versao: res.versao,
          desde: res.desde ?? null,
          ate: res.ate,
          commits: res.commits,
          prs: res.prs,
          truncado: res.truncado,
          itens,
        },
        { nota: res.path, avisos },
      );
    },
  });
}

// ---------------------------------------------------------------------------
// git_sync
// ---------------------------------------------------------------------------

interface SyncReport {
  projeto: string;
  linha_de_base: boolean;
  criadas: string[];
  erros: string[];
  remoto?: { lido: boolean; ignorado?: string; linha_de_base: boolean; criadas: string[]; atualizadas: string[]; erros: string[] };
}

function remoteReport(r: RemoteSyncResult): NonNullable<SyncReport["remoto"]> {
  return { lido: r.skipped === undefined, ...(r.skipped !== undefined ? { ignorado: r.skipped } : {}), linha_de_base: r.baseline, criadas: r.created, atualizadas: r.updated, erros: r.errors };
}

function syncTool(deps: HistoryDeps): HubTool {
  return defineHistoryTool(deps, {
    name: "git_sync",
    title: "Sincronizar o histórico",
    description:
      "Lê o repositório do projeto (ou de todos os projetos com clone, sem o argumento projeto) e grava como notas o que é novo: commits, pushes e branches novas. A primeira leitura de um projeto só guarda a linha de base, sem notas retroativas. Com remoto=true também lê PRs e deploys do GitHub ou do Bitbucket; sem secret do provedor isso só vira aviso.",
    inputSchema: GIT_SYNC_SCHEMA,
    annotations: WRITE_VAULT_REMOTE,
    async run(d, args) {
      const name = optString(args, "projeto");
      const remoto = optBool(args, "remoto") === true;
      const avisos: string[] = [];
      let projects: ProjectInfo[];
      const ignorados: { projeto: string; motivo: string }[] = [];
      if (name !== undefined) projects = [await resolveProject(d, name)];
      else {
        projects = [];
        for (const p of await (d.tracker ?? d.projects).list()) {
          if (!p.clonePath) ignorados.push({ projeto: p.name, motivo: "sem clone local" });
          else if ((await d.history.repoOf(p)) === undefined) ignorados.push({ projeto: p.name, motivo: "a pasta do clone não é um repositório git" });
          else projects.push(p);
        }
        for (const i of ignorados) avisos.push(`Projeto ${i.projeto} ignorado: ${i.motivo}.`);
      }

      const relatorios: SyncReport[] = [];
      for (const project of projects) {
        const res = await d.history.sync(project);
        const report: SyncReport = { projeto: project.name, linha_de_base: res.baseline, criadas: [...res.created], erros: [...res.errors] };
        if (remoto) {
          if (!d.remoteSync) avisos.push("A leitura do remoto não está disponível neste momento.");
          else {
            const r = await d.remoteSync.syncProject(project);
            report.remoto = remoteReport(r);
            report.criadas.push(...r.created);
            if (r.skipped !== undefined) avisos.push(`Remoto de ${project.name} não lido: ${r.skipped}.`);
          }
        }
        for (const e of report.erros) avisos.push(`${project.name}: ${e}`);
        for (const e of report.remoto?.erros ?? []) avisos.push(`${project.name} (remoto): ${e}`);
        relatorios.push(report);
      }

      const criadas = relatorios.flatMap((r) => r.criadas);
      const atualizadas = relatorios.flatMap((r) => r.remoto?.atualizadas ?? []);
      if (relatorios.length > 0 && relatorios.every((r) => r.erros.length > 0) && criadas.length === 0) {
        return fail("git_falhou", `Não foi possível sincronizar: ${relatorios.flatMap((r) => r.erros).join("; ")}`);
      }
      const baselines = relatorios.filter((r) => r.linha_de_base).map((r) => r.projeto);
      const partes = [
        projects.length === 0 ? "Nenhum projeto com clone para sincronizar." : `Sincronizado: ${plural(projects.length, "projeto", "projetos")}.`,
        `${plural(criadas.length, "nota criada", "notas criadas")}${atualizadas.length > 0 ? `, ${plural(atualizadas.length, "atualizada", "atualizadas")}` : ""}.`,
        ...(baselines.length > 0 ? [`Primeira leitura (só a linha de base, sem notas): ${baselines.join(", ")}.`] : []),
        ...criadas.map((c) => `- ${c}`),
      ];
      return ok(partes.join("\n"), { projetos: relatorios, criadas, atualizadas, total_criadas: criadas.length, ignorados, remoto }, { avisos });
    },
  });
}

// ---------------------------------------------------------------------------
// git_registrar_evento
// ---------------------------------------------------------------------------

const URL_OK = /^https?:\/\/\S+$/i;

/** Full hash of a commit of the clone, or undefined when the clone does not know it. */
async function fullHash(deps: HistoryDeps, cwd: string, hash: string): Promise<string | undefined> {
  try {
    return (await deps.git(cwd, ["rev-parse", "--verify", "-q", `${hash}^{commit}`])).trim() || undefined;
  } catch {
    return undefined;
  }
}

function registrarTool(deps: HistoryDeps): HubTool {
  return defineHistoryTool(deps, {
    name: "git_registrar_evento",
    title: "Registrar evento do projeto",
    description:
      "Grava um evento de desenvolvimento (commit, push, branch, pr ou deploy) como nota em Eventos do projeto, uma vez por evento: repetir a chamada não duplica. Commits, pushes e branches já são gravados sozinhos; use para o que o repositório não mostra (PR aberto por fora, deploy, push de outra máquina). Com tipo commit e hash, ou tipo branch com branch e hash, usa o mesmo id da gravação automática. Para um PR informe numero: o id passa a ser o mesmo da leitura do remoto e o PR não duplica.",
    inputSchema: GIT_REGISTRAR_EVENTO_SCHEMA,
    annotations: WRITE_VAULT,
    async run(d, args) {
      const project = await resolveProject(d, reqString(args, "projeto"));
      const tipo = reqString(args, "tipo");
      if (!isDevEventType(tipo)) throw new GuardError(`tipo inválido: ${tipo} (use ${DEV_EVENT_TYPES.join(", ")}).`);
      const titulo = reqString(args, "titulo").replace(/\s+/g, " ").trim();
      const branch = optString(args, "branch");
      const hashGiven = optString(args, "hash");
      const url = optString(args, "url");
      const numero = optInt(args, "numero");
      if (numero !== undefined) {
        if (tipo !== "pr") throw new GuardError('"numero" só vale com tipo pr.');
        if (numero < 1) throw new GuardError('"numero" tem de ser maior que zero.');
      }
      if (branch !== undefined) assertRefNameSyntax(branch);
      if (hashGiven !== undefined) assertRevision(hashGiven);
      if (url !== undefined && !URL_OK.test(url)) throw new GuardError('"url" tem de começar com http:// ou https://.');

      const resolved = hashGiven !== undefined ? await fullHash(d, project.clonePath ?? "", hashGiven) : undefined;
      const hash = resolved ?? hashGiven;
      let id: string;
      if (tipo === "pr" && numero !== undefined) {
        const remoto = await readRemote(d.git, project.clonePath ?? "");
        if (!remoto?.ref) throw new GuardError(`O remoto do clone de "${project.name}" não é do GitHub nem do Bitbucket: não dá para montar o id do PR. Registre sem "numero".`);
        id = prId(remoto.ref.provider, remoto.ref.repo, numero);
      } else if (tipo === "commit" && hash !== undefined) id = commitId(hash);
      else if (tipo === "branch" && branch !== undefined && hash !== undefined) id = branchId(branch, hash);
      else id = `${tipo}-${[branch, hashGiven, titulo].filter((p) => p !== undefined && p !== "").join("-")}`;

      const ev: DevEvent = {
        tipo,
        projeto: project.name,
        id,
        titulo,
        data: new Date(),
        ...(branch !== undefined ? { branch } : {}),
        ...(hash !== undefined ? { hash } : {}),
        ...(url !== undefined ? { url } : {}),
        ...(optString(args, "estado") !== undefined ? { estado: optString(args, "estado") } : {}),
        ...(optString(args, "ambiente") !== undefined ? { ambiente: optString(args, "ambiente") } : {}),
        ...(optString(args, "detalhes") !== undefined ? { detalhes: optString(args, "detalhes")?.trim() } : {}),
      };
      const res = await d.history.record(project, ev, { forcar: true });
      return ok(res.created ? `Evento ${id} gravado em ${res.path}.` : `O evento ${id} já estava gravado em ${res.path}; nada foi criado.`, { projeto: project.name, id, criado: res.created, caminho: res.path }, { nota: res.path });
    },
  });
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/** The four documentation tools. Without `deps.history` (tests of the git tools alone) there are none. */
export function buildHistoryTools(deps: GitToolDeps): HubTool[] {
  if (!deps.history) return [];
  const d = deps as HistoryDeps;
  return [graphTool(d), changelogTool(d), syncTool(d), registrarTool(d)];
}
