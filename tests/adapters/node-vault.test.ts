import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createNodeFileAdapter } from "../../src/adapters/node-file-adapter";
import { NodeVaultPort, inlineTags, parseNote } from "../../src/adapters/node-vault";

let root: string;
let vault: NodeVaultPort;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "node-vault-"));
  vault = new NodeVaultPort(root);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const write = (rel: string, text: string): void => {
  const file = path.join(root, ...rel.split("/"));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, "utf8");
};

describe("NodeVaultPort notes", () => {
  it("creates and reads a note, creating its folders; creating again fails", async () => {
    await vault.create("Eventos/2026/a.md", "ola\n");
    expect(await vault.read("Eventos/2026/a.md")).toBe("ola\n");
    expect(fs.readFileSync(path.join(root, "Eventos", "2026", "a.md"), "utf8")).toBe("ola\n");
    await expect(vault.create("Eventos/2026/a.md", "outra")).rejects.toThrow("Note already exists: Eventos/2026/a.md");
    expect(await vault.read("Eventos/2026/a.md")).toBe("ola\n");
  });

  it("exists is false for a folder and for a missing note", async () => {
    await vault.create("Pasta/n.md", "x");
    expect(vault.exists("Pasta/n.md")).toBe(true);
    expect(vault.exists("Pasta")).toBe(false);
    expect(vault.exists("Pasta/nao.md")).toBe(false);
    expect(vault.rootPath()).toBe(root);
  });

  it("ensureFolder creates nested folders and is repeatable", async () => {
    await vault.ensureFolder("A/B/C");
    await vault.ensureFolder("A/B/C");
    expect(fs.statSync(path.join(root, "A", "B", "C")).isDirectory()).toBe(true);
  });

  it("process replaces the text; a missing note fails; no .tmp is left behind", async () => {
    await vault.create("n.md", "um");
    await vault.process("n.md", (t) => `${t} dois`);
    expect(await vault.read("n.md")).toBe("um dois");
    await expect(vault.process("nao.md", (t) => t)).rejects.toThrow("Note not found: nao.md");
    expect(fs.readdirSync(root)).toEqual(["n.md"]);
  });

  it("process calls on the same note are applied one after the other", async () => {
    await vault.create("n.md", "");
    await Promise.all(Array.from({ length: 10 }, () => vault.process("n.md", (t) => `${t}x`)));
    expect(await vault.read("n.md")).toBe("x".repeat(10));
  });
});

describe("NodeVaultPort.updateFrontmatter", () => {
  it("keeps the body byte by byte", async () => {
    const body = "# Titulo\r\n\r\ntexto com acentuação e --- no meio\n\n```js\nconst a = 1;\n```\n  fim sem quebra";
    await vault.create("n.md", `---\nestado: aberto\ntags:\n  - a\n---\n${body}`);
    await vault.updateFrontmatter("n.md", (fm) => {
      fm.estado = "fechado";
      fm.novo = 3;
    });
    const text = await vault.read("n.md");
    expect(text.endsWith(`---\n${body}`)).toBe(true);
    const parsed = parseNote(text);
    expect(parsed.body).toBe(body);
    expect(parsed.frontmatter).toEqual({ estado: "fechado", tags: ["a"], novo: 3 });
  });

  it("creates the block when the note has no frontmatter, keeping the text", async () => {
    await vault.create("n.md", "so corpo\nlinha 2\n");
    await vault.updateFrontmatter("n.md", (fm) => {
      fm.evento_id = "abc";
    });
    expect(await vault.read("n.md")).toBe("---\nevento_id: abc\n---\nso corpo\nlinha 2\n");
  });

  it("refuses a frontmatter that is not valid YAML instead of erasing it", async () => {
    const original = "---\na: [1, 2\n---\ncorpo\n";
    await vault.create("n.md", original);
    await expect(vault.updateFrontmatter("n.md", (fm) => void (fm.x = 1))).rejects.toThrow("Invalid frontmatter");
    expect(await vault.read("n.md")).toBe(original);
  });

  it("fails for a missing note", async () => {
    await expect(vault.updateFrontmatter("nao.md", () => undefined)).rejects.toThrow("Note not found: nao.md");
  });
});

describe("NodeVaultPort.findNoteByProperty", () => {
  it("finds a note in a subfolder with a relative path using '/'", async () => {
    write("Eventos/2026/10/e1.md", "---\nevento_id: outro\n---\n");
    write("Eventos/2026/10/e2.md", "---\nevento_id:  abc \n---\ncorpo");
    write("Fora/e3.md", "---\nevento_id: abc\n---\n");
    expect(vault.findNoteByProperty("Eventos", "evento_id", "abc")).toBe("Eventos/2026/10/e2.md");
    expect(vault.findNoteByProperty("Eventos/", "evento_id", "abc")).toBe("Eventos/2026/10/e2.md");
    expect(vault.findNoteByProperty("Eventos", "evento_id", "zzz")).toBeUndefined();
    expect(vault.findNoteByProperty("Inexistente", "evento_id", "abc")).toBeUndefined();
  });
});

describe("NodeVaultPort.projects", () => {
  it("lists only the project root notes, with the clone of each", async () => {
    write("Projetos/Meu App/Meu App.md", "---\ntags:\n  - dev/projeto\n---\n# Meu App\n\n**Clone local:** `C:\\x\\meu-app`\n");
    write("Projetos/Outro.md", "# Outro\n\nAlgo #dev/projeto aqui.\n");
    write("Projetos/Meu App/Branches/b.md", "---\ntags:\n  - dev/projeto\n---\nsem propriedades de repositório\n");
    write("Projetos/Sem Tag/Sem Tag.md", "# sem tag\n");
    write(".obsidian/escondida.md", "#dev/projeto\n");
    const projects = await vault.projects();
    expect(projects.map((p) => p.name).sort()).toEqual(["Meu App", "Outro"]);
    const app = projects.find((p) => p.name === "Meu App")!;
    expect(app).toEqual({ name: "Meu App", folder: "Projetos/Meu App", clonePath: "C:\\x\\meu-app" });
    expect(projects.find((p) => p.name === "Outro")).toEqual({ name: "Outro", folder: "Projetos", clonePath: undefined });
  });

  it("sees a change made after the first listing", async () => {
    write("Projetos/P/P.md", "---\ntags: dev/projeto\n---\n**Clone local:** `C:\\a`\n");
    expect((await vault.projects())[0]?.clonePath).toBe("C:\\a");
    await vault.process("Projetos/P/P.md", () => "---\ntags: dev/projeto\n---\n**Clone local:** `C:\\b`\n");
    fs.utimesSync(path.join(root, "Projetos", "P", "P.md"), new Date(), new Date(Date.now() + 5000));
    expect((await vault.projects())[0]?.clonePath).toBe("C:\\b");
  });
});

describe("inlineTags", () => {
  it("reads inline tags and ignores the ones inside code blocks", () => {
    const body = "texto #um e #dev/projeto\n```\n#dentro do codigo\n```\n# Titulo\n#fim-2\nurl a#b";
    expect(inlineTags(body)).toEqual(["um", "dev/projeto", "fim-2"]);
  });
});

describe("parseNote", () => {
  it("handles a missing, an invalid and a non-object frontmatter", () => {
    expect(parseNote("corpo")).toEqual({ frontmatter: undefined, body: "corpo" });
    expect(parseNote("---\na: 1\n---\ncorpo").frontmatter).toEqual({ a: 1 });
    expect(parseNote("---\r\na: 1\r\n---\r\ncorpo")).toEqual({ frontmatter: { a: 1 }, body: "corpo" });
    expect(parseNote("---\na: [1\n---\ncorpo")).toEqual({ frontmatter: undefined, body: "---\na: [1\n---\ncorpo" });
    expect(parseNote("---\n- a\n- b\n---\ncorpo").frontmatter).toBeUndefined();
  });
});

describe("createNodeFileAdapter", () => {
  it("writes (creating the folder, atomically), checks and reads", async () => {
    const adapter = createNodeFileAdapter();
    const file = path.join(root, "dados", "checkpoints.json");
    expect(await adapter.exists(file)).toBe(false);
    await adapter.write(file, '{"a":1}');
    expect(await adapter.exists(file)).toBe(true);
    expect(await adapter.read(file)).toBe('{"a":1}');
    await adapter.write(file, '{"a":2}');
    expect(await adapter.read(file)).toBe('{"a":2}');
    expect(fs.readdirSync(path.join(root, "dados"))).toEqual(["checkpoints.json"]);
  });
});
