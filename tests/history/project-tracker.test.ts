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

class CountingVault extends MemoryVault {
  reads = 0;
  shouldFail = false;
  override async projects() {
    this.reads++;
    if (this.shouldFail) throw new Error("vault failure");
    return super.projects();
  }
}

describe("ProjectTracker cache", () => {
  it("keeps the raw project list for cacheMs milliseconds across multiple list() calls", async () => {
    const vault = new CountingVault();
    vault.projectList = [
      { name: "Alpha", folder: "Projetos/Alpha", clonePath: "C:\\clones\\alpha" },
      { name: "Beta", folder: "Projetos/Beta", clonePath: undefined },
    ];
    const t = new ProjectTracker(vault, () => ({ projectsRoot: "Projetos" }), { cacheMs: 1000 });
    await t.list();
    await t.list();
    await t.list();
    expect(vault.reads).toBe(1);
  });

  it("reads again after invalidate()", async () => {
    const vault = new CountingVault();
    vault.projectList = [{ name: "Alpha", folder: "Projetos/Alpha", clonePath: "C:\\clones\\alpha" }];
    const t = new ProjectTracker(vault, () => ({ projectsRoot: "Projetos" }), { cacheMs: 1000 });
    await t.list();
    expect(vault.reads).toBe(1);
    t.invalidate();
    await t.list();
    expect(vault.reads).toBe(2);
  });

  it("reads again when the injected clock advances past cacheMs", async () => {
    const vault = new CountingVault();
    vault.projectList = [{ name: "Alpha", folder: "Projetos/Alpha", clonePath: "C:\\clones\\alpha" }];
    let now = 1000;
    const t = new ProjectTracker(vault, () => ({ projectsRoot: "Projetos" }), {
      cacheMs: 1000,
      now: () => now,
    });
    await t.list();
    expect(vault.reads).toBe(1);
    now += 1001;
    await t.list();
    expect(vault.reads).toBe(2);
  });

  it("applies changes to projectsRoot within the TTL without re-reading the vault", async () => {
    const vault = new CountingVault();
    vault.projectList = [
      { name: "Alpha", folder: "Projetos/Alpha", clonePath: "C:\\clones\\alpha" },
      { name: "Delta", folder: "Outro/Delta", clonePath: "C:\\clones\\delta" },
    ];
    let root = "Projetos";
    const t = new ProjectTracker(vault, () => ({ projectsRoot: root }), { cacheMs: 1000 });
    const first = await t.list();
    expect(first.map((p) => p.name)).toEqual(["Alpha"]);
    expect(vault.reads).toBe(1);

    root = "Outro";
    const second = await t.list();
    expect(second.map((p) => p.name)).toEqual(["Delta"]);
    expect(vault.reads).toBe(1);
  });

  it("reads again on the next call if the previous read rejected", async () => {
    const vault = new CountingVault();
    vault.projectList = [{ name: "Alpha", folder: "Projetos/Alpha", clonePath: "C:\\clones\\alpha" }];
    vault.shouldFail = true;
    const t = new ProjectTracker(vault, () => ({ projectsRoot: "Projetos" }), { cacheMs: 1000 });
    await expect(t.list()).rejects.toThrow("vault failure");
    expect(vault.reads).toBe(1);

    vault.shouldFail = false;
    const list = await t.list();
    expect(list.map((p) => p.name)).toEqual(["Alpha"]);
    expect(vault.reads).toBe(2);
  });

  it("without options every list() reads from the vault", async () => {
    const vault = new CountingVault();
    vault.projectList = [{ name: "Alpha", folder: "Projetos/Alpha", clonePath: "C:\\clones\\alpha" }];
    const t = new ProjectTracker(vault, () => ({ projectsRoot: "Projetos" }));
    await t.list();
    await t.list();
    await t.list();
    expect(vault.reads).toBe(3);
  });
});
