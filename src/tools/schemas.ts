// JSON Schemas of the tools. One per tool, always with additionalProperties: false. The next
// tasks add the schemas of the write, provider and history tools at the end of this file.

export type JsonSchema = Record<string, unknown>;

/** Builds the object schema of a tool. */
export function objectSchema(properties: Record<string, JsonSchema>, required: string[] = []): JsonSchema {
  const schema: JsonSchema = { type: "object", properties, additionalProperties: false };
  if (required.length > 0) schema.required = required;
  return schema;
}

/** `repo` argument shared by every git tool that works on a repository. */
export const REPO_PROP: JsonSchema = {
  type: "string",
  description: "Nome do projeto (nota com a tag dev/projeto e clone local) ou caminho absoluto de um repositório dentro dos projetos ou das pastas permitidas.",
};

const str = (description: string): JsonSchema => ({ type: "string", description });
const bool = (description: string): JsonSchema => ({ type: "boolean", description });
const int = (description: string, minimum: number, maximum?: number): JsonSchema => {
  const s: JsonSchema = { type: "integer", description, minimum };
  if (maximum !== undefined) s.maximum = maximum;
  return s;
};

// ---------------------------------------------------------------------------
// Read tools
// ---------------------------------------------------------------------------

export const GIT_STATUS_SCHEMA = objectSchema(
  {
    repo: REPO_PROP,
    remoto: bool(
      "Inclui os remotos configurados (URLs sem credenciais), o provedor, o dono ou workspace, o slug, a branch padrão e se há secret do provedor (só sim ou não, nunca o valor).",
    ),
  },
  ["repo"],
);

export const GIT_DIFF_SCHEMA = objectSchema(
  {
    repo: REPO_PROP,
    alvo: {
      type: "string",
      enum: ["worktree", "staged", "refs"],
      description: "O que comparar: worktree (alterações ainda fora do stage), staged (o que está no stage) ou refs (entre duas referências; exige base).",
    },
    base: str("Referência de partida (branch, tag, hash, HEAD~1). Obrigatória com alvo=refs."),
    head: str("Referência de chegada. Padrão HEAD. Só vale com alvo=refs."),
    caminhos: { type: "array", items: { type: "string" }, description: "Limita o diff a estes caminhos relativos ao repositório." },
    stat: bool("Mostra só o resumo por arquivo (--stat), sem o conteúdo das linhas."),
    contexto: int("Linhas de contexto ao redor de cada trecho (-U). Padrão do git: 3.", 0, 1000),
    max_bytes: int("Tamanho máximo do diff devolvido, em bytes (padrão 40000). Acima disso o texto é cortado e truncado=true.", 1, 5_000_000),
  },
  ["repo", "alvo"],
);

export const GIT_LOG_SCHEMA = objectSchema(
  {
    repo: REPO_PROP,
    ref: str("Branch, tag ou hash de onde ler o histórico. Padrão HEAD. Não use junto com intervalo."),
    limite: int("Número máximo de commits (padrão 10, máximo 200).", 1, 200),
    desde: str("Só commits depois desta data (ex.: 2026-10-01 ou '2 weeks ago')."),
    ate: str("Só commits até esta data."),
    autor: str("Filtra pelo autor (nome ou e-mail, aceita parte do texto)."),
    caminho: str("Só commits que alteraram este caminho, relativo ao repositório."),
    intervalo: str("Intervalo de commits no formato a..b ou a...b. Não use junto com ref."),
    hash: str("Hash de um commit: devolve o commit completo (com corpo da mensagem) e as estatísticas de arquivos."),
    completo: bool("Inclui no structuredContent o hash inteiro, o e-mail, os pais e a data completa (ISO) de cada commit. Padrão false: só hash_curto, data (AAAA-MM-DD), autor e assunto. Com hash o commit sai sempre completo."),
  },
  ["repo"],
);

export const GIT_BLAME_SCHEMA = objectSchema(
  {
    repo: REPO_PROP,
    caminho: str("Arquivo a examinar, relativo ao repositório."),
    linha_inicio: int("Primeira linha do intervalo (começa em 1).", 1),
    linha_fim: int("Última linha do intervalo.", 1),
    ref: str("Referência (branch, tag ou hash) em que o arquivo é examinado. Padrão HEAD."),
  },
  ["repo", "caminho"],
);

export const GIT_BRANCHES_SCHEMA = objectSchema(
  {
    repo: REPO_PROP,
    remotas: bool("Inclui as branches de acompanhamento remoto e consulta o remoto com ls-remote (se falhar, avisa e continua)."),
    mescladas_em: str("Só branches já mescladas nesta referência (--merged)."),
  },
  ["repo"],
);

// ---------------------------------------------------------------------------
// Local write tools
// ---------------------------------------------------------------------------

export const GIT_FETCH_SCHEMA = objectSchema(
  {
    repo: REPO_PROP,
    remoto: { type: "string", default: "origin", description: "Nome do remoto (padrão origin). Só o nome, nunca uma URL." },
  },
  ["repo"],
);

export const GIT_CHECKOUT_SCHEMA = objectSchema(
  {
    repo: REPO_PROP,
    branch: str("Branch para a qual trocar (ou o nome da nova branch com criar=true)."),
    criar: { type: "boolean", default: false, description: "Cria a branch (git switch -c). Sem base, parte do HEAD atual e devolve um aviso." },
    base: str("Referência de partida da nova branch (branch, tag ou hash). Só vale com criar=true."),
  },
  ["repo", "branch"],
);

export const GIT_ADD_SCHEMA = objectSchema(
  {
    repo: REPO_PROP,
    caminhos: { type: "array", items: { type: "string" }, description: "Caminhos relativos ao repositório a colocar no stage. Informe caminhos OU todos." },
    todos: bool("Coloca no stage tudo o que mudou (git add -A), inclusive arquivos novos. Informe todos OU caminhos."),
    confirmar_sensivel: bool("Permite adicionar arquivos sensíveis (.env, chaves privadas, .deploy-target, data.json). Sem isso, a tool recusa e lista os arquivos."),
  },
  ["repo"],
);

export const GIT_COMMIT_SCHEMA = objectSchema(
  {
    repo: REPO_PROP,
    mensagem: str("Título do commit (pode ter mais linhas)."),
    descricao: str("Descrição longa, gravada depois de uma linha em branco."),
    permitir_vazio: { type: "boolean", default: false, description: "Permite um commit sem alterações (--allow-empty). Sem isso, recusa com nada_a_commitar." },
  },
  ["repo", "mensagem"],
);

export const GIT_PUSH_SCHEMA = objectSchema(
  {
    repo: REPO_PROP,
    remoto: { type: "string", default: "origin", description: "Nome do remoto (padrão origin)." },
    branch: str("Branch a enviar. Padrão: a branch atual. Não use junto com tag."),
    definir_upstream: bool("Liga a branch local à remota (git push -u). Não vale para tag."),
    tag: str("Envia esta tag (refs/tags/<tag>) em vez de uma branch."),
  },
  ["repo"],
);

export const GIT_PULL_SCHEMA = objectSchema(
  {
    repo: REPO_PROP,
    remoto: str("Nome do remoto. Padrão: o upstream da branch atual (origin quando só a branch é informada)."),
    branch: str("Branch remota a trazer. Padrão: o upstream da branch atual."),
    modo: {
      type: "string",
      enum: ["ff-only", "merge"],
      default: "ff-only",
      description: "ff-only (padrão) só avança quando não há divergência; merge junta as histórias e, em conflito, devolve a lista. Rebase não existe.",
    },
  },
  ["repo"],
);

// ---------------------------------------------------------------------------
// History-changing local tools and clone
// ---------------------------------------------------------------------------

export const GIT_MERGE_SCHEMA = objectSchema(
  {
    repo: REPO_PROP,
    origem: str("Branch, tag ou hash a mesclar na branch atual. Obrigatória, a menos que abortar=true."),
    mensagem: str("Mensagem do commit de merge (quando houver um)."),
    sem_ff: bool("Sempre cria um commit de merge (--no-ff), mesmo quando um avanço simples seria possível."),
    abortar: bool("Desfaz o merge em andamento (merge --abort). Só vale quando há um merge em andamento e não pode ser usado com origem."),
  },
  ["repo"],
);

export const GIT_REVERT_SCHEMA = objectSchema(
  {
    repo: REPO_PROP,
    commit: str("Commit a reverter (hash, branch, HEAD~1). Obrigatório, a menos que abortar=true."),
    merge_pai: int("Número do pai principal quando o commit é um merge (-m N): 1 é o lado da branch em que o merge foi feito.", 1),
    abortar: bool("Desfaz o revert em andamento (revert --abort). Só vale quando há um revert em andamento e não pode ser usado com commit."),
  },
  ["repo"],
);

export const GIT_STASH_SCHEMA = objectSchema(
  {
    repo: REPO_PROP,
    acao: {
      type: "string",
      enum: ["salvar", "listar", "mostrar", "aplicar", "pop"],
      description: "salvar guarda as alterações; listar mostra os stashes; mostrar traz o diff de um; aplicar reaplica sem remover; pop reaplica e remove. Não há apagar.",
    },
    mensagem: str("Descrição do stash. Só com acao=salvar."),
    incluir_nao_rastreados: bool("Guarda também os arquivos não rastreados (-u). Só com acao=salvar."),
    indice: int("Posição do stash (0 é o mais recente; padrão 0). Só com mostrar, aplicar e pop.", 0),
  },
  ["repo", "acao"],
);

export const GIT_TAG_SCHEMA = objectSchema(
  {
    repo: REPO_PROP,
    acao: { type: "string", enum: ["listar", "criar"], description: "listar mostra as tags; criar cria uma tag anotada. Não há apagar." },
    nome: str("Nome da nova tag. Só com acao=criar."),
    commit: str("Commit a marcar (padrão HEAD). Só com acao=criar."),
    mensagem: str("Mensagem da tag anotada. Obrigatória com acao=criar."),
  },
  ["repo", "acao"],
);

export const GIT_CLONE_SCHEMA = objectSchema(
  {
    url: str("URL do repositório em github.com ou bitbucket.org (https ou ssh git@), sem senha."),
    destino: str("Caminho absoluto da nova pasta do clone. Não pode existir e tem de ficar dentro da pasta dos clones dos projetos ou de uma pasta permitida."),
    branch: str("Branch a clonar (--branch). Padrão: a branch padrão do remoto."),
    profundidade: int("Clone raso com este número de commits (--depth). Padrão: histórico completo.", 1, 100000),
  },
  ["url", "destino"],
);

// ---------------------------------------------------------------------------
// Provider tools (pull requests and pipelines on GitHub or Bitbucket)
// ---------------------------------------------------------------------------

const PR_NUMERO = int("Número do PR no provedor (o id do PR no Bitbucket).", 1);

export const GIT_PR_CRIAR_SCHEMA = objectSchema(
  {
    repo: REPO_PROP,
    origem: str("Branch de origem do PR (a que tem as alterações). Tem de existir no remoto: use git_push com definir_upstream antes."),
    destino: str("Branch de destino do PR. Pela hierarquia do gitflow: feature, bugfix e chore para develop; develop para main; hotfix para main ou develop. Fora disso a tool avisa, mas não bloqueia."),
    titulo: str("Título do PR."),
    descricao: str("Descrição do PR (Markdown)."),
    rascunho: { type: "boolean", default: false, description: "Abre o PR como rascunho (draft)." },
  },
  ["repo", "origem", "destino", "titulo"],
);

export const GIT_PR_LISTAR_SCHEMA = objectSchema(
  {
    repo: REPO_PROP,
    estado: {
      type: "string",
      enum: ["aberto", "mesclado", "fechado", "todos"],
      default: "aberto",
      description: "Estado dos PRs a listar (padrão aberto). fechado são os recusados ou substituídos, sem merge.",
    },
    origem: str("Só PRs desta branch de origem."),
    destino: str("Só PRs para esta branch de destino."),
    limite: { type: "integer", minimum: 1, maximum: 100, default: 20, description: "Número máximo de PRs (padrão 20, máximo 100)." },
  },
  ["repo"],
);

export const GIT_PR_OBTER_SCHEMA = objectSchema(
  {
    repo: REPO_PROP,
    numero: PR_NUMERO,
    incluir: {
      type: "array",
      items: { type: "string", enum: ["commits", "diff", "comentarios"] },
      description: "O que trazer além dos dados do PR: commits, diff (cortado em max_bytes_diff) e comentarios.",
    },
    max_bytes_diff: int("Tamanho máximo do diff devolvido, em bytes (padrão 200000). Acima disso o texto é cortado e diff_truncado=true.", 1, 5_000_000),
  },
  ["repo", "numero"],
);

export const GIT_PR_COMENTAR_SCHEMA = objectSchema(
  {
    repo: REPO_PROP,
    numero: PR_NUMERO,
    texto: str("Texto do comentário (Markdown)."),
  },
  ["repo", "numero", "texto"],
);

export const GIT_PR_MERGE_SCHEMA = objectSchema(
  {
    repo: REPO_PROP,
    numero: PR_NUMERO,
    destino: str("Branch de destino do PR, exatamente como está no PR. A tool confere com o PR real e recusa (aprovacao_divergente) se for diferente."),
    titulo: str("Título do PR, exatamente como está no PR. A tool confere com o PR real e recusa (aprovacao_divergente) se for diferente."),
    estrategia: {
      type: "string",
      enum: ["merge", "squash", "fast_forward"],
      description: "merge cria um commit de merge; squash junta os commits em um; fast_forward só existe no Bitbucket.",
    },
    mensagem: str("Mensagem (corpo) do commit de merge."),
  },
  ["repo", "numero", "destino", "titulo", "estrategia"],
);

export const GIT_PIPELINE_STATUS_SCHEMA = objectSchema(
  {
    repo: REPO_PROP,
    branch: str("Branch dos pipelines. Sem branch, commit nem numero_pr, usa a branch atual do repositório."),
    commit: str("Hash (inteiro ou abreviado) do commit dos pipelines."),
    numero_pr: int("Pipelines da branch de origem deste PR.", 1),
    limite: { type: "integer", minimum: 1, maximum: 20, default: 5, description: "Número máximo de pipelines (padrão 5, máximo 20)." },
  },
  ["repo"],
);

export const GIT_REPO_CRIAR_SCHEMA = objectSchema(
  {
    nome: str("Nome do novo repositório no GitHub (letras, números, ponto, hífen e sublinhado)."),
    privado: bool("true cria um repositório privado; false cria um público (visível para qualquer pessoa). Sem padrão: decida com o usuário."),
    descricao: str("Descrição curta do repositório."),
    dono: str("Usuário ou organização dono do repositório. Padrão: o usuário da secret do GitHub."),
    repo: str("Opcional: nome do projeto ou caminho de um repositório local que ainda não tem esse remoto. Se informado, o remoto é adicionado a ele (git remote add)."),
    nome_remoto: str("Nome do remoto adicionado ao repositório local (padrão origin). Só vale com repo."),
  },
  ["nome", "privado"],
);

export const GIT_RELEASE_CRIAR_SCHEMA = objectSchema(
  {
    repo: REPO_PROP,
    tag: str("Tag da release (ex.: 1.1.0). Se a tag não existir no remoto, o GitHub a cria em alvo."),
    titulo: str("Título da release. Padrão: a própria tag."),
    notas: str("Texto (Markdown) da release. Se vazio e gerar_notas=true, o GitHub escreve as notas a partir dos PRs."),
    gerar_notas: { type: "boolean", default: true, description: "Deixa o GitHub gerar as notas quando notas está vazio (padrão true)." },
    alvo: str("Branch ou commit onde a tag é criada, se ainda não existir. Padrão: a branch padrão do repositório."),
    rascunho: { type: "boolean", default: false, description: "Cria a release como rascunho (não publicada)." },
    prerelease: { type: "boolean", default: false, description: "Marca a release como pré-lançamento." },
    arquivos: {
      type: "array",
      items: { type: "string" },
      description: "Arquivos de texto do repositório a anexar (ex.: main.js, manifest.json, styles.css), com caminho relativo à raiz. O token precisa permitir o host uploads.github.com.",
    },
    anexar_apenas: bool("Não cria a release: anexa os arquivos a uma release que já existe para a tag (exige arquivos). Não combine com titulo, notas, alvo, gerar_notas, rascunho nem prerelease."),
  },
  ["repo", "tag"],
);

// ---------------------------------------------------------------------------
// Documentation tools (history of the projects)
// ---------------------------------------------------------------------------

/** `projeto` argument of the documentation tools: the name of the project note, not a path. */
export const PROJETO_PROP: JsonSchema = {
  type: "string",
  description: "Nome do projeto (nota com a tag dev/projeto e clone local). Não aceita caminho.",
};

export const GIT_GRAPH_SCHEMA = objectSchema(
  {
    projeto: PROJETO_PROP,
    branch: str("Branch (ou tag) a destacar no grafo."),
    hash: str("Commit (hash inteiro ou abreviado, 4 caracteres ou mais) a destacar no grafo."),
    limite: int("Número de commits desenhados, de todas as branches (padrão 60, máximo 500).", 1, 500),
    formato: {
      type: "string",
      enum: ["texto", "arquivo", "svg"],
      default: "texto",
      description:
        "texto (padrão): só as linhas dos commits, sem SVG. arquivo: grava o SVG em <pasta do projeto>/Anexos e devolve o caminho. svg: devolve o SVG inteiro na resposta (caro: ~7 mil caracteres com 8 commits).",
    },
  },
  ["projeto"],
);

export const GIT_CHANGELOG_SCHEMA = objectSchema(
  {
    projeto: PROJETO_PROP,
    desde: str("Referência inicial (tag, branch ou hash), exclusiva. Padrão: a última tag antes de ate; sem tag, desde o primeiro commit."),
    ate: str("Referência final, inclusiva. Padrão HEAD."),
    versao: str("Nome da release na nota. Padrão: a tag de ate, ou a data de hoje. Mesma versão no mesmo projeto reescreve a nota em vez de criar outra."),
  },
  ["projeto"],
);

export const GIT_SYNC_SCHEMA = objectSchema({
  projeto: str("Nome do projeto. Sem projeto, sincroniza todos os projetos que têm clone."),
  remoto: bool("Também lê o remoto (PRs e deploys do GitHub ou do Bitbucket). Sem secret do provedor, só avisa."),
});

export const GIT_REGISTRAR_EVENTO_SCHEMA = objectSchema(
  {
    projeto: PROJETO_PROP,
    tipo: { type: "string", enum: ["commit", "push", "branch", "pr", "deploy"], description: "Tipo do evento." },
    titulo: str("Título do evento (nome do arquivo e cabeçalho da nota)."),
    branch: str("Branch do evento."),
    hash: str("Commit do evento (hash inteiro ou abreviado)."),
    url: str("Link do evento (PR, pipeline, deploy)."),
    numero: int("Número do PR no provedor. Só com tipo pr: usa o mesmo id da leitura do remoto (pr-<provedor>-<dono/repo>-<número>), então o PR não vira duas notas.", 1),
    estado: str("PR: open, merged ou declined. Deploy: sucesso, falha..."),
    ambiente: str("Ambiente do deploy (ex.: producao)."),
    detalhes: str("Texto em Markdown acrescentado abaixo da tabela da nota."),
  },
  ["projeto", "tipo", "titulo"],
);
