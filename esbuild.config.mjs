import esbuild from "esbuild";
import fs from "fs";
import path from "path";
import process from "process";
import { builtinModules } from "node:module";

const prod = process.argv[2] === "production";

// Entrada "app": processo filho do app AI Ecosystem 2.0 (Node puro, sem "obsidian").
if (process.argv[2] === "app") {
  const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
  await esbuild.build({
    entryPoints: ["src/app/main.ts"],
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22",
    outfile: "dist-app/ai-git-tools.cjs",
    external: [...builtinModules, ...builtinModules.map((m) => `node:${m}`)],
    define: { __PLUGIN_VERSION__: JSON.stringify(pkg.version) },
    logLevel: "info",
  });
  process.exit(0);
}

// styles.css is built from src/styles/*.css (one file per area), in name order. It stays in git.
function buildStyles() {
  const dir = "src/styles";
  const parts = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".css"))
    .sort()
    .map((f) => `/* ${f} */\n` + fs.readFileSync(path.join(dir, f), "utf8").trim() + "\n");
  fs.writeFileSync("styles.css", parts.join("\n"));
}

const stylesPlugin = {
  name: "styles",
  setup(build) {
    build.onStart(() => buildStyles());
  },
};

const context = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: [
    "obsidian",
    "electron",
    "@codemirror/autocomplete",
    "@codemirror/collab",
    "@codemirror/commands",
    "@codemirror/language",
    "@codemirror/lint",
    "@codemirror/search",
    "@codemirror/state",
    "@codemirror/view",
    "@lezer/common",
    "@lezer/highlight",
    "@lezer/lr",
    ...builtinModules,
    ...builtinModules.map((m) => `node:${m}`),
  ],
  format: "cjs",
  target: "es2022",
  logLevel: "info",
  sourcemap: prod ? false : "inline",
  treeShaking: true,
  outfile: "main.js",
  minify: prod,
  plugins: [stylesPlugin],
});

if (prod) {
  await context.rebuild();
  process.exit(0);
} else {
  await context.watch();
}
