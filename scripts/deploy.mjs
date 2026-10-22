// Copies the built plugin into a vault's plugin folder for local testing.
// Target: AIGT_DEPLOY_DIR env var, or the first line of a (git-ignored) .deploy-target file.
import fs from "fs";
import path from "path";

let target = process.env.AIGT_DEPLOY_DIR;
if (!target && fs.existsSync(".deploy-target")) {
  target = fs.readFileSync(".deploy-target", "utf8").split(/\r?\n/)[0].trim();
}
if (!target) {
  console.error("No deploy target. Set AIGT_DEPLOY_DIR or create a .deploy-target file.");
  process.exit(1);
}

fs.mkdirSync(target, { recursive: true });
for (const file of ["main.js", "manifest.json", "styles.css"]) {
  fs.copyFileSync(file, path.join(target, file));
  console.log(`copied ${file} -> ${target}`);
}
