import esbuild from "esbuild";
import fs from "fs";
import path from "path";
import process from "process";
import { builtinModules } from "node:module";

const prod = process.argv[2] === "production";

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
