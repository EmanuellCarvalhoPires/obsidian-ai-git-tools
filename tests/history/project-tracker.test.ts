import { describe, expect, it } from "vitest";
import { ProjectTracker } from "../../src/core/history/project-tracker";
import { MemoryVault } from "../helpers/memory-ports";

function tracker(root = "Projetos") {
  const vault = new MemoryVault();
  vault.projectList = [
    { name: "Alpha", folder: "Projetos/Alpha", clonePath: "C:\\clones\\alpha" },
    { name: "Beta", folder: "Projetos/Beta", clonePath: undefined },
    { name: "Delta", folder: "Outro/Delta", clonePath: "C:\\clones\\delta" },
  ];
  return new ProjectTracker(vault, () => ({ projectsRoot: root }));
}

describe("ProjectTracker", () => {
  it("lists only the projects inside projectsRoot, with and without clone", async () => {
    const list = await tracker().list();
    expect(list.map((p) => p.name)).toEqual(["Alpha", "Beta"]);
    expect(list[1]?.clonePath).toBeUndefined();
    expect((await tracker("").list()).map((p) => p.name)).toEqual(["Alpha", "Beta", "Delta"]);
    expect((await tracker("/Projetos/").list()).map((p) => p.name)).toEqual(["Alpha", "Beta"]);
  });

  it("finds by name (case-insensitive) and by a path inside the clone", async () => {
    const t = tracker();
    expect((await t.byName("alpha"))?.folder).toBe("Projetos/Alpha");
    expect(await t.byName("Delta")).toBeUndefined();
    expect((await t.byClone("C:\\clones\\alpha\\src\\x.ts"))?.name).toBe("Alpha");
    expect(await t.byClone("c:/CLONES/alpha")).toMatchObject({ name: "Alpha" });
    expect(await t.byClone("C:\\clones\\alphabet")).toBeUndefined();
    expect(await t.byClone("C:\\clones\\delta")).toBeUndefined();
  });

  it("a project without clone is never found by path", async () => {
    expect(await tracker().byClone("C:\\qualquer")).toBeUndefined();
  });
});
