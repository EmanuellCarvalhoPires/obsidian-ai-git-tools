// The provider layer: identification of the remote (parseRemoteUrl), the GitProvider interface that
// GitHub and Bitbucket implement and the normalized types the tools speak. Names are in Portuguese
// like the contract of the tools; the input parameters have the same names as the tool arguments.
import type { SecretInfo } from "../../ecosystem/types";
import type { SecureHttp } from "../ports";

export type ProviderId = "github" | "bitbucket";

/** A remote repository on a supported provider. */
export interface RemoteRef {
  provider: ProviderId;
  /** GitHub owner or Bitbucket workspace. */
  owner: string;
  /** Repository slug. */
  slug: string;
  /** `owner/slug`. */
  repo: string;
}

const HOSTS: Record<string, ProviderId> = {
  "github.com": "github",
  "www.github.com": "github",
  "bitbucket.org": "bitbucket",
  "www.bitbucket.org": "bitbucket",
};

function refFrom(host: string, path: string): RemoteRef | undefined {
  const provider = HOSTS[host.toLowerCase()];
  if (!provider) return undefined;
  const segments = path.split("/").filter((s) => s !== "");
  if (segments.length !== 2) return undefined;
  const owner = segments[0] ?? "";
  const slug = (segments[1] ?? "").replace(/\.git$/i, "");
  if (owner === "" || slug === "") return undefined;
  return { provider, owner, slug, repo: `${owner}/${slug}` };
}

/**
 * `git@github.com:o/r.git`, `https://github.com/o/r.git`, `https://u@bitbucket.org/w/r.git`,
 * `ssh://git@bitbucket.org/w/r.git`. Other hosts (and local paths) give undefined.
 */
export function parseRemoteUrl(url: string): RemoteRef | undefined {
  const text = url.trim();
  if (text === "") return undefined;
  // scp-like: [user@]host:owner/repo
  const scp = /^(?:[^@\s/]+@)?([^:/\s]+):(?!\/\/)(\S+)$/.exec(text);
  if (scp && !/^[a-zA-Z]:[\\/]/.test(text)) return refFrom(scp[1] ?? "", scp[2] ?? "");
  try {
    const u = new URL(text);
    return refFrom(u.hostname, u.pathname);
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Normalized types
// ---------------------------------------------------------------------------

export type PrEstado = "aberto" | "mesclado" | "fechado";

/** A pull request, the same shape on GitHub and Bitbucket. Dates are ISO 8601 strings. */
export interface PrInfo {
  numero: number;
  titulo: string;
  estado: PrEstado;
  /** Source branch. */
  origem: string;
  /** Destination branch. */
  destino: string;
  /** Page of the PR on the provider (not the API URL). */
  url: string;
  /** Login (GitHub) or display name (Bitbucket); empty when the provider hides it. */
  autor: string;
  criadoEm: string;
  descricao?: string;
  /** Hash of the head of the source branch. */
  headSha?: string;
}

export interface CommitInfo {
  hash: string;
  mensagem: string;
  autor: string;
  data: string;
}

export interface ComentarioInfo {
  id: string;
  autor: string;
  texto: string;
  criadoEm: string;
  url?: string;
}

/** `obterPr`: the PR plus what was asked in `incluir`. */
export interface PrDetalhe extends PrInfo {
  commits?: CommitInfo[];
  /** Unified diff, cut at `max_bytes_diff` (default 200000). */
  diff?: string;
  diffTruncado?: boolean;
  comentarios?: ComentarioInfo[];
}

export type PipelineEstado = "pendente" | "executando" | "sucesso" | "falha" | "parado";

export interface PipelineStep {
  nome: string;
  estado: PipelineEstado;
}

/** A pipeline run (Bitbucket Pipelines or GitHub Actions). Step logs are not read. */
export interface PipelineInfo {
  /** Run id (GitHub) or uuid (Bitbucket), as text. */
  id: string;
  estado: PipelineEstado;
  branch: string;
  /** Commit hash. */
  commit: string;
  url: string;
  criadoEm: string;
  steps: PipelineStep[];
}

/** Result of `mesclarPr`. */
export interface MergeResult {
  numero: number;
  /** True when the provider confirmed the merge (for an asynchronous merge, after waiting). */
  mesclado: boolean;
  estado: PrEstado;
  /** Merge commit, when the provider tells it. */
  commit?: string;
  url?: string;
}

/** A list cut by the page limit: `truncado` tells that the provider had more. */
export interface Lista<T> {
  itens: T[];
  truncado: boolean;
}

// ---------------------------------------------------------------------------
// Input parameters (same names as the arguments of the tools)
// ---------------------------------------------------------------------------

export interface CriarPrParams {
  origem: string;
  destino: string;
  titulo: string;
  descricao?: string;
  /** Opens the PR as a draft (GitHub and Bitbucket Cloud both support it). */
  rascunho?: boolean;
}

export interface ListarPrsParams {
  estado: PrEstado | "todos";
  origem?: string;
  destino?: string;
  /** Maximum of items (default 30). */
  limite?: number;
}

export type PrIncluir = "commits" | "diff" | "comentarios";

export interface ObterPrParams {
  numero: number;
  incluir?: PrIncluir[];
  /** Cut of the diff in bytes (default 200000). */
  max_bytes_diff?: number;
}

export interface ComentarPrParams {
  numero: number;
  texto: string;
}

export interface ListarComentariosParams {
  numero: number;
  limite?: number;
}

/** `merge` is a merge commit; `fast_forward` exists only on Bitbucket (GitHub answers `argumento_invalido`). */
export type EstrategiaMerge = "merge" | "squash" | "fast_forward";

export interface MesclarPrParams {
  numero: number;
  estrategia: EstrategiaMerge;
  /** Title of the merge commit. */
  titulo?: string;
  /** Body of the merge commit. */
  mensagem?: string;
  /** Head the caller expects (GitHub `sha`); the provider reads it when missing. */
  sha?: string;
}

export interface StatusPipelinesParams {
  branch?: string;
  commit?: string;
  /** Pipelines of the source branch of this PR. */
  numero_pr?: number;
  /** Maximum of runs (default 5). */
  limite?: number;
  /** When false, omits fetching individual step/job details to save HTTP requests (defaults to true). */
  incluirSteps?: boolean;
}

/** A file attached to a release. Text only: it travels as the request body through the secrets service. */
export interface ReleaseAtivo {
  nome: string;
  conteudo: string;
  contentType: string;
}

export interface CriarReleaseParams {
  tag: string;
  titulo?: string;
  notas?: string;
  /** Lets the provider write the notes from the merged PRs when `notas` is empty. */
  gerarNotas: boolean;
  /** Branch or commit the tag is created on when it does not exist yet (default: the default branch). */
  alvo?: string;
  rascunho: boolean;
  prerelease: boolean;
  ativos: ReleaseAtivo[];
}

export interface AnexarReleaseParams {
  tag: string;
  ativos: ReleaseAtivo[];
}

/** A release as the provider tells it. */
export interface ReleaseInfo {
  id: string;
  tag: string;
  titulo: string;
  url: string;
  rascunho: boolean;
  prerelease: boolean;
  /** Names of the files that were attached. */
  ativos: string[];
}

/** `criarRepo`: a new repository of the authenticated user or of an organization. */
export interface CriarRepoParams {
  nome: string;
  descricao?: string;
  privado: boolean;
  /** Owner (user or organization). Default: the user of the secret. */
  dono?: string;
}

/** What the provider reports about the repository it just created. */
export interface RepoCriado {
  provedor: ProviderId;
  dono: string;
  slug: string;
  privado: boolean;
  /** Page of the repository (not the API URL). */
  url: string;
  /** HTTPS URL for `git remote add`. */
  cloneUrl: string;
  branchPadrao: string;
}

// ---------------------------------------------------------------------------
// Interface and context
// ---------------------------------------------------------------------------

/**
 * One repository on one provider. Every method throws `RemoteError` (see errors.ts) on failure and
 * never returns secrets. `mesclarPr` does NOT ask for approval: the tool checks the PR and
 * the agent confirms with the user in the chat.
 */
export interface GitProvider {
  readonly id: ProviderId;
  criarPr(p: CriarPrParams): Promise<PrInfo>;
  listarPrs(p: ListarPrsParams): Promise<Lista<PrInfo>>;
  obterPr(p: ObterPrParams): Promise<PrDetalhe>;
  comentarPr(p: ComentarPrParams): Promise<ComentarioInfo>;
  listarComentarios(p: ListarComentariosParams): Promise<Lista<ComentarioInfo>>;
  mesclarPr(p: MesclarPrParams): Promise<MergeResult>;
  statusPipelines(p: StatusPipelinesParams): Promise<Lista<PipelineInfo>>;
  /** Only GitHub has releases; Bitbucket leaves it out and the tool explains that. */
  criarRelease?(p: CriarReleaseParams): Promise<ReleaseInfo>;
  /** Attaches files to a release that already exists. */
  anexarRelease?(p: AnexarReleaseParams): Promise<ReleaseInfo>;
}

/** What a provider implementation needs. `secretName` is empty when no secret was chosen (D6). */
export interface ProviderContext {
  http: SecureHttp;
  ref: RemoteRef;
  /** Name of the Environment Keys secret; "" means none (the provider answers `secret_nao_configurada`). */
  secretName: string;
  /** Metadata of the secret (type), to pick `{{basic:...}}` or `{{bearer:...}}`. */
  secretInfo?: SecretInfo;
  /** The Environment Keys `redact`, applied to provider texts that reach an error. */
  redact?: (text: string) => string;
}

export type ProviderFactory = (ctx: ProviderContext) => GitProvider;
