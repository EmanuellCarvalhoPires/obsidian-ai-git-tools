// Index metadata of the AI Git Tools module (tools.db and indexed exposure).
import type { HubTool } from "../ecosystem/types";

export type HubToolMetadata = Pick<
  HubTool,
  "categoria" | "tags" | "resumo" | "efeito" | "exposicao" | "exemplo"
>;

/** The AI Ecosystem hook never asks the user before a tool of this module runs (even with efeito "externo"). */
export const GIT_TOOLS_APPROVAL = "dispensada";

export const GIT_TOOL_METADATA: Record<string, HubToolMetadata> = {
  // ---------------------------------------------------------------------------
  // git/leitura (status, diff, log, blame, branches, remote_info, graph)
  // ---------------------------------------------------------------------------
  git_status: {
    categoria: "git/leitura",
    tags: ["git", "status", "branch", "stage", "leitura"],
    resumo: "Estado da árvore de trabalho e do stage do repositório",
    efeito: "leitura",
    exposicao: "indice",
    exemplo: { repo: "meu-projeto" },
  },
  git_diff: {
    categoria: "git/leitura",
    tags: ["git", "diff", "alteracoes", "staged", "refs", "leitura"],
    resumo: "Diferenças da worktree, do stage ou entre referências",
    efeito: "leitura",
    exposicao: "indice",
    exemplo: { repo: "meu-projeto", alvo: "worktree" },
  },
  git_log: {
    categoria: "git/leitura",
    tags: ["git", "log", "commits", "historico", "leitura"],
    resumo: "Histórico de commits com filtros por autor, data e caminho",
    efeito: "leitura",
    exposicao: "indice",
    exemplo: { repo: "meu-projeto", limite: 10 },
  },
  git_blame: {
    categoria: "git/leitura",
    tags: ["git", "blame", "autoria", "linhas", "leitura"],
    resumo: "Autoria e data da última alteração de cada linha",
    efeito: "leitura",
    exposicao: "indice",
    exemplo: { repo: "meu-projeto", caminho: "src/index.ts", linha_inicio: 1, linha_fim: 50 },
  },
  git_branches: {
    categoria: "git/leitura",
    tags: ["git", "branches", "remotas", "mescladas", "leitura"],
    resumo: "Lista branches locais e remotas com status de upstream",
    efeito: "leitura",
    exposicao: "indice",
    exemplo: { repo: "meu-projeto", remotas: true },
  },
  git_remote_info: {
    categoria: "git/leitura",
    tags: ["git", "remote", "remotos", "github", "bitbucket", "leitura"],
    resumo: "Informações dos remotos configurados no repositório",
    efeito: "leitura",
    exposicao: "indice",
    exemplo: { repo: "meu-projeto" },
  },
  git_graph: {
    categoria: "git/leitura",
    tags: ["git", "grafo", "commits", "branches", "svg", "leitura"],
    resumo: "Desenha o grafo visual de commits e branches do projeto",
    efeito: "leitura",
    exposicao: "indice",
    exemplo: { projeto: "meu-projeto", limite: 30 },
  },

  // ---------------------------------------------------------------------------
  // git/escrita (add, commit, push, checkout, pull, merge, revert, stash, tag, clone, sync, fetch)
  // ---------------------------------------------------------------------------
  git_fetch: {
    categoria: "git/escrita",
    tags: ["git", "fetch", "remoto", "tags", "branches"],
    resumo: "Busca branches e tags novas do remoto sem alterar o código",
    efeito: "externo",
    exposicao: "indice",
    exemplo: { repo: "meu-projeto", remoto: "origin" },
  },
  git_checkout: {
    categoria: "git/escrita",
    tags: ["git", "checkout", "switch", "branch", "criar"],
    resumo: "Troca de branch ou cria nova branch de trabalho",
    efeito: "externo",
    exposicao: "indice",
    exemplo: { repo: "meu-projeto", branch: "feature/nova", criar: true },
  },
  git_add: {
    categoria: "git/escrita",
    tags: ["git", "add", "stage", "arquivos"],
    resumo: "Adiciona arquivos alterados ao stage para commit",
    efeito: "externo",
    exposicao: "indice",
    exemplo: { repo: "meu-projeto", caminhos: ["src/index.ts"] },
  },
  git_commit: {
    categoria: "git/escrita",
    tags: ["git", "commit", "salvar", "mensagem"],
    resumo: "Cria um commit com as alterações que estão no stage",
    efeito: "externo",
    exposicao: "indice",
    exemplo: { repo: "meu-projeto", mensagem: "feat: adiciona nova funcionalidade" },
  },
  git_push: {
    categoria: "git/escrita",
    tags: ["git", "push", "remoto", "enviar", "branch", "tag"],
    resumo: "Envia commits da branch ou tag para o repositório remoto",
    efeito: "externo",
    exposicao: "indice",
    exemplo: { repo: "meu-projeto", branch: "feature/nova", remoto: "origin", definir_upstream: true },
  },
  git_pull: {
    categoria: "git/escrita",
    tags: ["git", "pull", "remoto", "integrar", "ff-only", "merge"],
    resumo: "Traz e integra atualizações do remoto na branch atual",
    efeito: "externo",
    exposicao: "indice",
    exemplo: { repo: "meu-projeto", modo: "ff-only" },
  },
  git_merge: {
    categoria: "git/escrita",
    tags: ["git", "merge", "mesclar", "branch"],
    resumo: "Mescla outra branch ou referência na branch atual",
    efeito: "externo",
    exposicao: "indice",
    exemplo: { repo: "meu-projeto", origem: "feature/concluida" },
  },
  git_revert: {
    categoria: "git/escrita",
    tags: ["git", "revert", "reverter", "desfazer", "commit"],
    resumo: "Cria um commit desfazendo as alterações de um commit anterior",
    efeito: "externo",
    exposicao: "indice",
    exemplo: { repo: "meu-projeto", commit: "a1b2c3d" },
  },
  git_stash: {
    categoria: "git/escrita",
    tags: ["git", "stash", "guardar", "pop", "aplicar"],
    resumo: "Guarda ou recupera alterações temporárias da worktree",
    efeito: "externo",
    exposicao: "indice",
    exemplo: { repo: "meu-projeto", acao: "salvar", mensagem: "trabalho em progresso" },
  },
  git_tag: {
    categoria: "git/escrita",
    tags: ["git", "tag", "versao", "release"],
    resumo: "Lista ou cria tags anotadas no repositório",
    efeito: "externo",
    exposicao: "indice",
    exemplo: { repo: "meu-projeto", acao: "criar", nome: "v1.0.0", mensagem: "Release 1.0.0" },
  },
  git_clone: {
    categoria: "git/escrita",
    tags: ["git", "clone", "clonar", "repositorio"],
    resumo: "Clona um repositório remoto para uma pasta local",
    efeito: "externo",
    exposicao: "indice",
    exemplo: { url: "git@github.com:org/repo.git", destino: "C:/Projetos/repo" },
  },
  git_sync: {
    categoria: "git/escrita",
    tags: ["git", "sync", "sincronizar", "historico", "eventos"],
    resumo: "Sincroniza histórico do repositório local e remoto no cofre",
    efeito: "externo",
    exposicao: "indice",
    exemplo: { projeto: "meu-projeto", remoto: true },
  },

  // ---------------------------------------------------------------------------
  // git/pr (criar, listar, obter, comentar, merge, pipeline_status)
  // ---------------------------------------------------------------------------
  git_pr_criar: {
    categoria: "git/pr",
    tags: ["git", "pr", "pull-request", "abrir", "github", "bitbucket"],
    resumo: "Abre um novo pull request no GitHub ou Bitbucket",
    efeito: "externo",
    exposicao: "indice",
    exemplo: { repo: "meu-projeto", titulo: "feat: nova tela", destino: "develop" },
  },
  git_pr_listar: {
    categoria: "git/pr",
    tags: ["git", "pr", "pull-request", "listar", "github", "bitbucket"],
    resumo: "Lista pull requests abertos, mesclados ou recusados",
    efeito: "externo",
    exposicao: "indice",
    exemplo: { repo: "meu-projeto", estado: "open" },
  },
  git_pr_obter: {
    categoria: "git/pr",
    tags: ["git", "pr", "pull-request", "detalhes", "comentarios", "commits"],
    resumo: "Obtém detalhes completos de um pull request pelo número",
    efeito: "externo",
    exposicao: "indice",
    exemplo: { repo: "meu-projeto", numero: 42 },
  },
  git_pr_comentar: {
    categoria: "git/pr",
    tags: ["git", "pr", "pull-request", "comentario", "github", "bitbucket"],
    resumo: "Publica um comentário em um pull request existente",
    efeito: "externo",
    exposicao: "indice",
    exemplo: { repo: "meu-projeto", numero: 42, texto: "Revisão concluída com sucesso." },
  },
  git_pr_merge: {
    categoria: "git/pr",
    tags: ["git", "pr", "pull-request", "merge", "mesclar"],
    resumo: "Faz o merge de um pull request aprovado",
    efeito: "externo",
    exposicao: "indice",
    exemplo: { repo: "meu-projeto", numero: 42, destino: "develop" },
  },
  git_pipeline_status: {
    categoria: "git/pr",
    tags: ["git", "pipeline", "ci", "status", "runs", "github", "bitbucket"],
    resumo: "Consulta status das execuções de pipeline e CI/CD",
    efeito: "externo",
    exposicao: "indice",
    exemplo: { repo: "meu-projeto", limite: 5 },
  },

  // ---------------------------------------------------------------------------
  // git/repo (criar, release_criar, release_anexar)
  // ---------------------------------------------------------------------------
  git_repo_criar: {
    categoria: "git/repo",
    tags: ["git", "repo", "criar", "github", "repositorio"],
    resumo: "Cria um novo repositório no GitHub e configura remoto opcional",
    efeito: "externo",
    exposicao: "indice",
    exemplo: { nome: "novo-app", privado: true },
  },
  git_release_criar: {
    categoria: "git/repo",
    tags: ["git", "release", "publicar", "github", "tag", "versao"],
    resumo: "Publica uma nova release no GitHub com notas e anexos opcionais",
    efeito: "externo",
    exposicao: "indice",
    exemplo: { repo: "meu-projeto", tag: "1.0.0", titulo: "Versão 1.0.0" },
  },
  git_release_anexar: {
    categoria: "git/repo",
    tags: ["git", "release", "anexar", "arquivos", "github"],
    resumo: "Anexa arquivos de distribuição a uma release existente no GitHub",
    efeito: "externo",
    exposicao: "indice",
    exemplo: { repo: "meu-projeto", tag: "1.0.0", arquivos: ["main.js", "manifest.json"] },
  },

  // ---------------------------------------------------------------------------
  // git/registro (changelog, registrar_evento)
  // ---------------------------------------------------------------------------
  git_changelog: {
    categoria: "git/registro",
    tags: ["git", "changelog", "release", "notas", "registro"],
    resumo: "Gera nota de changelog entre duas referências do git",
    efeito: "cofre",
    exposicao: "indice",
    exemplo: { projeto: "meu-projeto", desde: "v1.0.0", ate: "HEAD", versao: "1.1.0" },
  },
  git_registrar_evento: {
    categoria: "git/registro",
    tags: ["git", "evento", "registrar", "nota", "historico"],
    resumo: "Grava evento de desenvolvimento em nota do cofre",
    efeito: "cofre",
    exposicao: "indice",
    exemplo: { projeto: "meu-projeto", tipo: "commit", titulo: "feat: novo recurso" },
  },
};

/** Metadata for a tool by name, with safe defaults. */
export function metadataFor(name: string): HubToolMetadata {
  return (
    GIT_TOOL_METADATA[name] ?? {
      categoria: "git",
      tags: ["git"],
      efeito: "externo",
      exposicao: "indice",
    }
  );
}

/** Decorates a HubTool with its index metadata. */
export function withToolMetadata(tool: HubTool): HubTool {
  const meta = metadataFor(tool.name);
  return {
    ...tool,
    categoria: meta.categoria,
    tags: meta.tags,
    resumo: meta.resumo ?? tool.description.slice(0, 100),
    efeito: meta.efeito,
    exposicao: meta.exposicao,
    aprovacao: GIT_TOOLS_APPROVAL,
    exemplo: meta.exemplo,
  };
}
