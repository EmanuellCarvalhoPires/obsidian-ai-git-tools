import { describe, expect, it } from "vitest";
import { logsDoProjeto, projectNameOf } from "../../src/ui/project-logs";
import { fakeApp } from "./fakes";
import type { FakeNote } from "./fakes";

const log = (path: string, extra: Partial<FakeNote> = {}): FakeNote => ({
  path,
  frontmatter: { tags: ["log", "claude", "sessao/ativo"], projeto: "[[AI Ecosystem]]" },
  ...extra,
});

describe("projectNameOf", () => {
  it.each([
    ["[[AI Ecosystem]]", "AI Ecosystem"],
    ["AI Ecosystem", "AI Ecosystem"],
    ["[[AI Ecosystem|o núcleo]]", "AI Ecosystem"],
    ["[[Projetos/AI Ecosystem/AI Ecosystem]]", "AI Ecosystem"],
    ["[[AI Ecosystem#Fases]]", "AI Ecosystem"],
    ["[[AI Ecosystem.md]]", "AI Ecosystem"],
    ["  [[ AI Ecosystem ]]  ", "AI Ecosystem"],
  ])("%s -> %s", (input, expected) => {
    expect(projectNameOf(input)).toBe(expected);
  });
});

describe("logsDoProjeto", () => {
  it("returns only the logs of the project", () => {
    const app = fakeApp([
      log("Knowledge/Logs/21-10-2026 - 12h00 - Um.md"),
      log("Knowledge/Logs/21-10-2026 - 13h00 - Outro projeto.md", { frontmatter: { tags: ["log"], projeto: "[[Outro]]" } }),
      log("Knowledge/Logs/21-10-2026 - 14h00 - Sem projeto.md", { frontmatter: { tags: ["log"] } }),
      { path: "Notas/Nota qualquer.md", frontmatter: { projeto: "[[AI Ecosystem]]" } },
    ]);
    expect(logsDoProjeto(app, "AI Ecosystem").map((l) => l.titulo)).toEqual(["Um"]);
    expect(logsDoProjeto(app, "Outro").map((l) => l.titulo)).toEqual(["Outro projeto"]);
    expect(logsDoProjeto(app, "Inexistente")).toEqual([]);
    expect(logsDoProjeto(app, "  ")).toEqual([]);
  });

  it("accepts the link formats and a case difference", () => {
    const names = ["[[AI Ecosystem]]", "AI Ecosystem", "[[AI Ecosystem|alias]]", "[[Projetos/AI Ecosystem/AI Ecosystem]]", "[[ai ecosystem]]"];
    const app = fakeApp(names.map((projeto, i) => log(`L/${i}.md`, { frontmatter: { tags: ["log"], projeto } })));
    expect(logsDoProjeto(app, "AI Ecosystem")).toHaveLength(names.length);
    expect(logsDoProjeto(app, "[[AI Ecosystem]]")).toHaveLength(names.length);
  });

  it("accepts a list value and the nested list of an unquoted wikilink", () => {
    const app = fakeApp([
      log("L/a.md", { frontmatter: { tags: ["log"], projeto: ["[[Outro]]", "[[AI Ecosystem]]"] } }),
      log("L/b.md", { frontmatter: { tags: ["log"], projeto: [["AI Ecosystem"]] } }),
    ]);
    expect(logsDoProjeto(app, "AI Ecosystem").map((l) => l.path).sort()).toEqual(["L/a.md", "L/b.md"]);
  });

  it("reads the tag from the frontmatter (list or text) and from the inline tags", () => {
    const app = fakeApp([
      log("L/list.md", { frontmatter: { tags: ["log", "claude"], projeto: "[[P]]" } }),
      log("L/text.md", { frontmatter: { tags: "claude, log", projeto: "[[P]]" } }),
      log("L/hash.md", { frontmatter: { tags: ["#log"], projeto: "[[P]]" } }),
      log("L/inline.md", { frontmatter: { projeto: "[[P]]" }, tags: ["#log"] }),
      log("L/other.md", { frontmatter: { tags: ["log-antigo", "dev/log"], projeto: "[[P]]" } }),
    ]);
    expect(logsDoProjeto(app, "P").map((l) => l.path).sort()).toEqual(["L/hash.md", "L/inline.md", "L/list.md", "L/text.md"]);
  });

  it("orders by date, newest first: last entry, then the file name stamp, then the creation time", () => {
    const app = fakeApp([
      log("L/old.md", { headings: [{ level: 2, heading: "Pedido - 01/10/2026 - 09:00" }, { level: 2, heading: "01/10/2026 - 09:30 - Pedido" }] }),
      log("L/21-10-2026 - 12h00 - Pelo nome.md"),
      log("L/recent.md", { headings: [{ level: 1, heading: "Título" }, { level: 2, heading: "22/10/2026 - 08:15 - Pedido" }] }),
      log("L/sem-data.md", { ctime: new Date(2026, 0, 1).getTime() }),
    ]);
    const logs = logsDoProjeto(app, "AI Ecosystem");
    expect(logs.map((l) => l.path)).toEqual(["L/recent.md", "L/21-10-2026 - 12h00 - Pelo nome.md", "L/old.md", "L/sem-data.md"]);
    expect(logs[0]?.data).toBe(new Date(2026, 9, 22, 8, 15).getTime());
    expect(logs[1]?.data).toBe(new Date(2026, 9, 21, 12, 0).getTime());
    expect(logs[2]?.data).toBe(new Date(2026, 9, 1, 9, 30).getTime());
    expect(logs[3]?.data).toBe(new Date(2026, 0, 1).getTime());
  });

  it("strips the date prefix of the title and reads the status", () => {
    const app = fakeApp([
      log("L/21-10-2026 - 12h00 - Meu título.md"),
      log("L/arq.md", { frontmatter: { tags: ["log", "sessao/arquivado"], projeto: "[[AI Ecosystem]]" } }),
      log("L/prop.md", { frontmatter: { tags: ["log"], "Status da Sessão": "Arquivado", projeto: "[[AI Ecosystem]]" } }),
      log("L/none.md", { frontmatter: { tags: ["log"], projeto: "[[AI Ecosystem]]" } }),
    ]);
    const by = Object.fromEntries(logsDoProjeto(app, "AI Ecosystem").map((l) => [l.path, l]));
    expect(by["L/21-10-2026 - 12h00 - Meu título.md"]?.titulo).toBe("Meu título");
    expect(by["L/21-10-2026 - 12h00 - Meu título.md"]?.status).toBe("ativo");
    expect(by["L/arq.md"]?.status).toBe("arquivado");
    expect(by["L/prop.md"]?.status).toBe("arquivado");
    expect(by["L/none.md"]?.status).toBe("ativo");
  });

  it("skips notes without a metadata cache", () => {
    const app = fakeApp([log("L/a.md")]);
    app.metadataCache.getFileCache = () => null;
    expect(logsDoProjeto(app, "AI Ecosystem")).toEqual([]);
  });
});
