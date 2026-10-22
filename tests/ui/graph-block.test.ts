import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMockElement, setMockLanguage } from "../mocks/obsidian";
import { BLOCK_GRAPH_WIDTH, appendSvg, registerGraphBlock, renderGraphInto } from "../../src/ui/graph-block";
import type { GraphDeps } from "../../src/ui/graph-block";
import type { ProjectInfo } from "../../src/core/ports";

/** A mock element whose children also know their document (appendSvg needs `ownerDocument.importNode`). */
function makeEl(): any {
  const el: any = createMockElement("div");
  el.ownerDocument = { importNode: (n: unknown) => n };
  const create = el.createEl.bind(el);
  el.createEl = (tag: string, opts?: unknown) => {
    const child = create(tag, opts);
    child.ownerDocument = el.ownerDocument;
    const inner = child.createEl.bind(child);
    child.createEl = (t2: string, o2?: unknown) => {
      const c = inner(t2, o2);
      c.ownerDocument = el.ownerDocument;
      return c;
    };
    return child;
  };
  return el;
}

const texts = (el: any): string[] => el.children.map((c: any) => c.textContent as string);
const svgs = (el: any): unknown[] => el.children.flatMap((c: any) => c.children);

const SVG = '<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>';

class FakeDomParser {
  parseFromString(text: string) {
    return { documentElement: { nodeName: text.startsWith("<svg") ? "svg" : "html", text } };
  }
}

const app: ProjectInfo = { name: "App", folder: "Projetos/App", clonePath: "C:/clones/app" };
const noClone: ProjectInfo = { name: "Sem Clone", folder: "Projetos/Sem Clone", clonePath: undefined };

function deps(over: { rows?: number; fail?: Error } = {}) {
  const graph = vi.fn(async () => {
    if (over.fail) throw over.fail;
    return { svg: SVG, rows: new Array(over.rows ?? 2).fill({}) as never[], lanes: 1 };
  });
  const byName = vi.fn(async (name: string) => [app, noClone].find((p) => p.name.toLowerCase() === name.toLowerCase()));
  const d: GraphDeps = { history: { graph } as never, projects: { byName } };
  return { d, graph, byName };
}

beforeEach(() => {
  setMockLanguage("en");
  (globalThis as unknown as { DOMParser: unknown }).DOMParser = FakeDomParser;
});

describe("renderGraphInto", () => {
  it("asks for the project when none is given", async () => {
    const el = makeEl();
    const { d, graph } = deps();
    expect(await renderGraphInto(el, d, {})).toBe(false);
    expect(texts(el)).toEqual(["Name the project in the block (projeto: Name)."]);
    expect(graph).not.toHaveBeenCalled();
  });

  it("says so for an unknown project", async () => {
    const el = makeEl();
    expect(await renderGraphInto(el, deps().d, { projeto: "Nada" })).toBe(false);
    expect(texts(el)[0]).toContain("Project not found: Nada");
  });

  it("says so for a project without a clone and does not read git", async () => {
    const el = makeEl();
    const { d, graph } = deps();
    expect(await renderGraphInto(el, d, { projeto: "Sem Clone" })).toBe(false);
    expect(texts(el)[0]).toContain("has no local clone");
    expect(graph).not.toHaveBeenCalled();
  });

  it("writes the messages in Portuguese when Obsidian is in Portuguese", async () => {
    setMockLanguage("pt-BR");
    const el = makeEl();
    await renderGraphInto(el, deps().d, { projeto: "Sem Clone" });
    expect(texts(el)[0]).toContain("não tem clone local");
  });

  it("draws the svg and passes the options to the history service", async () => {
    const el = makeEl();
    const { d, graph } = deps();
    expect(await renderGraphInto(el, d, { projeto: "app", branch: "develop", hash: "abc1234", limite: 10, width: 500 })).toBe(true);
    expect(graph).toHaveBeenCalledWith(app, { limit: 10, width: 500, highlight: { branch: "develop", hash: "abc1234" } });
    const box = el.children[0];
    expect(box.hasClass("aigt-graph")).toBe(true);
    expect(box.children).toHaveLength(1);
    expect(box.children[0].text).toBe(SVG);
  });

  it("empties the element before drawing", async () => {
    const el = makeEl();
    el.createDiv({ text: "old" });
    await renderGraphInto(el, deps().d, { projeto: "App" });
    expect(texts(el)).not.toContain("old");
  });

  it("says so when the repository has no commits", async () => {
    const el = makeEl();
    expect(await renderGraphInto(el, deps({ rows: 0 }).d, { projeto: "App" })).toBe(false);
    expect(texts(el)).toEqual(["This repository has no commits yet."]);
  });

  it("turns a failure into a message and never throws", async () => {
    const el = makeEl();
    expect(await renderGraphInto(el, deps({ fail: new Error("boom") }).d, { projeto: "App" })).toBe(false);
    expect(texts(el)[0]).toBe("Could not draw the graph: boom");
  });
});

describe("appendSvg", () => {
  it("drops anything that is not an svg", () => {
    const el = makeEl();
    appendSvg(el, "<html></html>");
    expect(el.children).toHaveLength(0);
    appendSvg(el, SVG);
    expect(el.children).toHaveLength(1);
  });
});

describe("registerGraphBlock", () => {
  it("registers ai-git-graph (and only it) and renders the block parameters", async () => {
    const registered: Record<string, (source: string, el: HTMLElement) => void | Promise<void>> = {};
    const { d, graph } = deps();
    registerGraphBlock(
      (language, handler) => {
        registered[language] = handler;
      },
      () => d,
    );
    expect(Object.keys(registered)).toEqual(["ai-git-graph"]);
    const el = makeEl();
    await registered["ai-git-graph"]!("projeto: App\nbranch: main\nhash: abc1234\nlimite: 5", el);
    expect(graph).toHaveBeenCalledWith(app, { limit: 5, width: BLOCK_GRAPH_WIDTH, highlight: { branch: "main", hash: "abc1234" } });
    expect(el.children[0].hasClass("aigt-graph-block")).toBe(true);
    expect(svgs(el.children[0])).toHaveLength(1);
  });

  it("shows a message in the note when the block has no project", async () => {
    let handler: ((source: string, el: HTMLElement) => void | Promise<void>) | undefined;
    registerGraphBlock(
      (_l, h) => {
        handler = h;
      },
      () => deps().d,
    );
    const el = makeEl();
    await handler!("", el);
    expect(texts(el.children[0])[0]).toContain("Name the project");
  });
});
