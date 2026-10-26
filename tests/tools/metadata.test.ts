import { describe, expect, it } from "vitest";
import { GIT_TOOL_METADATA } from "../../src/tools/metadata";
import { buildGitTools } from "../../src/tools/git-tools";
import type { GitToolDeps } from "../../src/tools/git-tools";
import { DEFAULT_SETTINGS } from "../../src/types";

describe("tool index metadata", () => {
  const expectedTools = [
    // git/leitura
    "git_status",
    "git_diff",
    "git_log",
    "git_blame",
    "git_branches",
    "git_remote_info",
    "git_graph",
    // git/escrita
    "git_fetch",
    "git_checkout",
    "git_add",
    "git_commit",
    "git_push",
    "git_pull",
    "git_merge",
    "git_revert",
    "git_stash",
    "git_tag",
    "git_clone",
    "git_sync",
    // git/pr
    "git_pr_criar",
    "git_pr_listar",
    "git_pr_obter",
    "git_pr_comentar",
    "git_pr_merge",
    "git_pipeline_status",
    // git/repo
    "git_repo_criar",
    "git_release_criar",
    "git_release_anexar",
    // git/registro
    "git_changelog",
    "git_registrar_evento",
  ];

  it("covers all 30 tools with metadata", () => {
    expect(Object.keys(GIT_TOOL_METADATA).sort()).toEqual([...expectedTools].sort());
    expect(expectedTools).toHaveLength(30);
  });

  it("classifies categories and effects correctly", () => {
    const leituras = ["git_status", "git_diff", "git_log", "git_blame", "git_branches", "git_remote_info", "git_graph"];
    for (const name of leituras) {
      const meta = GIT_TOOL_METADATA[name];
      expect(meta.categoria).toBe("git/leitura");
      expect(meta.efeito).toBe("leitura");
      expect(meta.exposicao).toBe("indice");
    }

    const escritas = ["git_fetch", "git_checkout", "git_add", "git_commit", "git_push", "git_pull", "git_merge", "git_revert", "git_stash", "git_tag", "git_clone", "git_sync"];
    for (const name of escritas) {
      const meta = GIT_TOOL_METADATA[name];
      expect(meta.categoria).toBe("git/escrita");
      expect(meta.efeito).toBe("externo");
      expect(meta.exposicao).toBe("indice");
    }

    const prs = ["git_pr_criar", "git_pr_listar", "git_pr_obter", "git_pr_comentar", "git_pr_merge", "git_pipeline_status"];
    for (const name of prs) {
      const meta = GIT_TOOL_METADATA[name];
      expect(meta.categoria).toBe("git/pr");
      expect(meta.efeito).toBe("externo");
      expect(meta.exposicao).toBe("indice");
    }

    const repos = ["git_repo_criar", "git_release_criar", "git_release_anexar"];
    for (const name of repos) {
      const meta = GIT_TOOL_METADATA[name];
      expect(meta.categoria).toBe("git/repo");
      expect(meta.efeito).toBe("externo");
      expect(meta.exposicao).toBe("indice");
    }

    const registros = ["git_changelog", "git_registrar_evento"];
    for (const name of registros) {
      const meta = GIT_TOOL_METADATA[name];
      expect(meta.categoria).toBe("git/registro");
      expect(meta.efeito).toBe("cofre");
      expect(meta.exposicao).toBe("indice");
    }
  });

  it("configures approval template on git_pr_merge and dangerous/remote tools", () => {
    expect(GIT_TOOL_METADATA.git_pr_merge.aprovacao).toBe("Posso fazer o merge do PR #{numero} para a branch {destino}?");
    expect(GIT_TOOL_METADATA.git_push.aprovacao).toBe("Posso fazer o push da branch {branch} para {remoto}?");
    expect(GIT_TOOL_METADATA.git_merge.aprovacao).toBe("Posso mesclar {origem} na branch atual?");
    expect(GIT_TOOL_METADATA.git_revert.aprovacao).toBe("Posso reverter o commit {commit}?");
    expect(GIT_TOOL_METADATA.git_clone.aprovacao).toBe("Posso clonar {url} em {destino}?");
    expect(GIT_TOOL_METADATA.git_repo_criar.aprovacao).toBe("Posso criar o repositório {nome} no GitHub?");
  });

  it("decorates all tools returned by buildGitTools", () => {
    const fakeDeps: GitToolDeps = {
      git: async () => "",
      projects: { byName: async () => undefined, byClone: async () => undefined, list: async () => [] },
      allowedFolders: () => [],
      settings: () => ({ ...DEFAULT_SETTINGS }),
      history: {
        repoOf: async () => "",
        sync: async () => ({ created: [], errors: [], baseline: false }),
        record: async () => ({ created: false, path: "" }),
        changelog: async () => ({ path: "", commits: 0, created: false }),
        graph: async () => ({ svg: "", rows: [], lanes: 0 }),
      } as never,
    };

    const tools = buildGitTools(fakeDeps);
    expect(tools).toHaveLength(30);
    for (const tool of tools) {
      expect(tool.categoria).toBeDefined();
      expect(tool.efeito).toBeDefined();
      expect(tool.exposicao).toBe("indice");
      expect(tool.resumo).toBeDefined();
      expect(tool.tags).toBeDefined();
    }
  });
});
