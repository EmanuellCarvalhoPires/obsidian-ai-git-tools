// VaultPort em Node puro: lê e grava o cofre direto no disco, sem a API do Obsidian. É usado pela
// entrada "app" (processo filho do AI Ecosystem 2.0). Só importa tipos do "obsidian", nunca código.
import * as fs from "fs";
import * as path from "path";
import { parse, stringify } from "yaml";
import type { CachedMetadata, TFile } from "obsidian";
import { createVaultProjectLister } from "../core/project-lookup";
import type { LookupApp } from "../core/project-lookup";
import type { ProjectInfo, VaultPort } from "../core/ports";

/**
 * Pastas que nunca entram na varredura do cofre. As pastas de configuração, de versionamento e da
 * lixeira (as que começam com ".") já são puladas por esse prefixo; aqui entra o resto.
 */
const IGNORED_FOLDERS = new Set(["node_modules"]);

const FENCED_CODE = /```[\s\S]*?```/g;
const INLINE_TAG = /(?:^|\s)#([\p{L}\p{N}_/-]+)/gu;
/** Bloco de frontmatter: "---", o YAML (pode ser vazio), "---" e a quebra de linha que o fecha. */
const FRONTMATTER = /^---[ \t]*\r?\n(?:([\s\S]*?)\r?\n)?---[ \t]*(?:\r?\n|$)/;

interface SplitNote {
  /** Texto YAML do bloco, sem os "---". */
  raw: string;
  /** Tudo que vem depois do bloco, byte a byte. */
  body: string;
}

function splitFrontmatter(text: string): SplitNote | undefined {
  const match = FRONTMATTER.exec(text);
  if (!match) return undefined;
  return { raw: match[1] ?? "", body: text.slice(match[0].length) };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function parseYaml(raw: string): Record<string, unknown> | undefined {
  try {
    return asRecord(parse(raw));
  } catch {
    return undefined;
  }
}

/**
 * Separa o frontmatter do corpo. Frontmatter inválido, vazio ou que não é objeto vira `undefined`;
 * nesse caso o corpo é o texto inteiro, para nada se perder. Sem frontmatter, o corpo é o texto.
 */
export function parseNote(text: string): { frontmatter: Record<string, unknown> | undefined; body: string } {
  const split = splitFrontmatter(text);
  if (!split) return { frontmatter: undefined, body: text };
  const frontmatter = parseYaml(split.raw);
  if (!frontmatter) return { frontmatter: undefined, body: text };
  return { frontmatter, body: split.body };
}

/** Tags inline (#tag) do corpo, sem o "#", ignorando blocos de código ``` ... ```. */
export function inlineTags(body: string): string[] {
  const out: string[] = [];
  for (const m of body.replace(FENCED_CODE, "").matchAll(INLINE_TAG)) {
    if (m[1]) out.push(m[1]);
  }
  return out;
}

function frontmatterTags(frontmatter: Record<string, unknown> | undefined): string[] {
  const value = frontmatter?.tags;
  const list: unknown[] = typeof value === "string" ? value.split(/[\s,]+/) : Array.isArray(value) ? value : [];
  const out: string[] = [];
  for (const t of list) if (typeof t === "string" && t.trim() !== "") out.push(t.trim().replace(/^#/, ""));
  return out;
}

/** Fora do Obsidian não há TFile nem CachedMetadata reais: o lister só lê estes campos de um objeto simples. */
function plainAs<T>(value: unknown): T {
  return value as T;
}

const absPath = (root: string, rel: string): string => path.join(root, ...rel.split("/"));

/** Notas .md de uma pasta (qualquer profundidade) como caminhos relativos ao cofre, com "/". */
function walkMarkdown(root: string, folder: string): string[] {
  const out: string[] = [];
  const visit = (rel: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(rel === "" ? root : absPath(root, rel), { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const childRel = rel === "" ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        if (entry.name.startsWith(".") || IGNORED_FOLDERS.has(entry.name)) continue;
        visit(childRel);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
        out.push(childRel);
      }
    }
  };
  visit(folder);
  return out;
}

/** Grava por arquivo temporário no mesmo diretório e rename, para nunca deixar um arquivo pela metade. */
export async function writeFileAtomic(file: string, data: string): Promise<void> {
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  try {
    await fs.promises.writeFile(tmp, data, "utf8");
    await fs.promises.rename(tmp, file);
  } catch (err) {
    await fs.promises.rm(tmp, { force: true });
    throw err;
  }
}

/** Monta o LookupApp que o lister de projetos usa, lendo o cofre do disco (notas, frontmatter e tags). */
export function createNodeLookupApp(root: string): LookupApp {
  const caches = new Map<string, { mtime: number; cache: CachedMetadata }>();

  return {
    vault: {
      getMarkdownFiles: () => {
        const files: TFile[] = [];
        for (const rel of walkMarkdown(root, "")) {
          let mtime: number;
          try {
            mtime = fs.statSync(absPath(root, rel)).mtimeMs;
          } catch {
            continue;
          }
          const slash = rel.lastIndexOf("/");
          const folder = slash >= 0 ? rel.slice(0, slash) : "";
          const fileName = slash >= 0 ? rel.slice(slash + 1) : rel;
          files.push(
            plainAs<TFile>({
              path: rel,
              basename: fileName.replace(/\.md$/i, ""),
              parent: { name: folder.slice(folder.lastIndexOf("/") + 1), path: folder },
              stat: { mtime },
            }),
          );
        }
        return files;
      },
      cachedRead: (file) => fs.promises.readFile(absPath(root, file.path), "utf8"),
    },
    metadataCache: {
      getFileCache: (file) => {
        const mtime = file.stat.mtime;
        const hit = caches.get(file.path);
        if (hit && hit.mtime === mtime) return hit.cache;
        let text: string;
        try {
          text = fs.readFileSync(absPath(root, file.path), "utf8");
        } catch {
          return null;
        }
        const { frontmatter, body } = parseNote(text);
        const tags = [...frontmatterTags(frontmatter), ...inlineTags(body)];
        const cache = plainAs<CachedMetadata>({ frontmatter, tags: tags.map((t) => ({ tag: `#${t}` })) });
        caches.set(file.path, { mtime, cache });
        return cache;
      },
    },
  };
}

export class NodeVaultPort implements VaultPort {
  private readonly listProjects: () => Promise<ProjectInfo[]>;
  /** Fila por nota: leituras-e-gravações no mesmo processo não se atropelam. */
  private readonly locks = new Map<string, Promise<void>>();

  constructor(private readonly root: string) {
    this.listProjects = createVaultProjectLister(createNodeLookupApp(root));
  }

  rootPath(): string {
    return this.root;
  }

  exists(p: string): boolean {
    try {
      return fs.statSync(absPath(this.root, p)).isFile();
    } catch {
      return false;
    }
  }

  async read(p: string): Promise<string> {
    return fs.promises.readFile(absPath(this.root, p), "utf8");
  }

  async create(p: string, content: string): Promise<void> {
    const file = absPath(this.root, p);
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    try {
      await fs.promises.writeFile(file, content, { encoding: "utf8", flag: "wx" });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`Note already exists: ${p}`);
      throw err;
    }
  }

  async process(p: string, fn: (content: string) => string): Promise<void> {
    await this.locked(p, async () => {
      const file = absPath(this.root, p);
      let text: string;
      try {
        text = await fs.promises.readFile(file, "utf8");
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`Note not found: ${p}`);
        throw err;
      }
      await writeFileAtomic(file, fn(text));
    });
  }

  async updateFrontmatter(p: string, fn: (frontmatter: Record<string, unknown>) => void): Promise<void> {
    await this.process(p, (text) => {
      const split = splitFrontmatter(text);
      let frontmatter: Record<string, unknown> = {};
      if (split && split.raw.trim() !== "") {
        const parsed = parseYaml(split.raw);
        // Com YAML que não dá para ler, recusar é melhor do que apagar o que o usuário escreveu.
        if (!parsed) throw new Error(`Invalid frontmatter in ${p}`);
        frontmatter = parsed;
      }
      fn(frontmatter);
      const yaml = Object.keys(frontmatter).length > 0 ? stringify(frontmatter, { lineWidth: 0 }) : "";
      return `---\n${yaml}---\n${split ? split.body : text}`;
    });
  }

  async ensureFolder(p: string): Promise<void> {
    await fs.promises.mkdir(absPath(this.root, p), { recursive: true });
  }

  findNoteByProperty(folder: string, key: string, value: string): string | undefined {
    const start = folder.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
    for (const rel of walkMarkdown(this.root, start)) {
      let text: string;
      try {
        text = fs.readFileSync(absPath(this.root, rel), "utf8");
      } catch {
        continue;
      }
      const found = parseNote(text).frontmatter?.[key];
      if (typeof found === "string" && found.trim() === value) return rel;
    }
    return undefined;
  }

  projects(): Promise<ProjectInfo[]> {
    return this.listProjects();
  }

  private async locked(p: string, task: () => Promise<void>): Promise<void> {
    const previous = this.locks.get(p) ?? Promise.resolve();
    const run = previous.then(task, task);
    const tail = run.catch(() => undefined);
    this.locks.set(p, tail);
    try {
      await run;
    } finally {
      if (this.locks.get(p) === tail) this.locks.delete(p);
    }
  }
}
