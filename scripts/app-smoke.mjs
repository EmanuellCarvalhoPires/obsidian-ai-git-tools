// Teste de fumaça do bundle dist-app/ai-git-tools.cjs: fala JSON-RPC por stdio como o app AI Ecosystem 2.0.
// Uso: npm run build:app && node scripts/app-smoke.mjs
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bundle = path.join(root, "dist-app", "ai-git-tools.cjs");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ai-git-tools-smoke-"));
let child;
let failure;

function cleanup() {
  try {
    child?.kill();
  } catch {
    // já saiu
  }
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    // arquivo preso no Windows: a pasta é temporária
  }
}

function fail(message) {
  console.error(`app-smoke falhou: ${message}`);
  cleanup();
  process.exit(1);
}

const timeout = setTimeout(() => fail("tempo esgotado (30 s)"), 30_000);

try {
  if (!fs.existsSync(bundle)) fail(`bundle ausente: ${bundle} (rode npm run build:app)`);

  // 1. Repositório temporário com um commit; outra pasta serve de cofre e de estado.
  const repo = path.join(tmp, "repo");
  const vault = path.join(tmp, "cofre");
  const state = path.join(tmp, "estado");
  for (const dir of [repo, vault, state]) fs.mkdirSync(dir, { recursive: true });
  const git = (...args) => execFileSync("git", ["-C", repo, "-c", "user.name=teste", "-c", "user.email=teste@exemplo.test", ...args], { stdio: "pipe" });
  git("init");
  fs.writeFileSync(path.join(repo, "a.txt"), "olá\n");
  git("add", "a.txt");
  git("commit", "-m", "primeiro commit");

  // 2. Inicia o filho.
  child = spawn(process.execPath, [bundle], { stdio: ["pipe", "pipe", "pipe"] });
  child.stderr.on("data", (d) => process.stderr.write(`[filho] ${d}`));
  const exited = new Promise((resolve) => child.on("exit", (code) => resolve(code)));
  const pending = new Map();
  let nextId = 1;
  const send = (obj) => child.stdin.write(JSON.stringify(obj) + "\n");
  const request = (method, params) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      send({ jsonrpc: "2.0", id, method, params });
    });
  readline.createInterface({ input: child.stdout, crlfDelay: Infinity }).on("line", (line) => {
    const msg = JSON.parse(line);
    if (typeof msg.method === "string" && msg.id !== undefined) {
      // O filho não deve pedir segredos nem Telegram nesta fumaça: responde erro e marca falha.
      failure ??= `pedido inesperado do filho: ${msg.method}`;
      send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `Método inesperado: ${msg.method}` } });
      return;
    }
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.error) p.reject(new Error(`${msg.error.code}: ${msg.error.message}`));
    else p.resolve(msg.result);
  });

  // 3. inicializar com a rota "plugin".
  const init = await request("inicializar", { protocolo: 1, versao_app: "smoke", modulo: "ai-git-tools", pasta_cofre: vault, pasta_estado: state, rota: "plugin", idioma: "pt" });

  // 4. Protocolo e tools.
  if (init.protocolo !== 1) fail(`protocolo ${init.protocolo}, esperado 1`);
  if (init.tools.length !== 29) fail(`${init.tools.length} tools, esperado 29`);
  const shadow = (id) => init.tools.find((t) => t.id === id)?.comparar_na_sombra;
  if (shadow("git_status") !== true) fail("git_status deveria ter comparar_na_sombra true");
  for (const id of ["git_graph", "git_pipeline_aguardar", "git_commit"]) {
    if (shadow(id) !== false) fail(`${id} deveria ter comparar_na_sombra false`);
  }

  // 5. tools/chamar git_status.
  const res = await request("tools/chamar", { tool: "git_status", args: { repo }, contexto: { agente: "smoke", sessao: "s1", projeto: null } });
  if (res.isError) fail(`git_status devolveu isError: ${JSON.stringify(res.content)}`);

  // 6. encerrar: saída 0 em até 5 s.
  await request("encerrar", {});
  const code = await Promise.race([exited, new Promise((resolve) => setTimeout(() => resolve("timeout"), 5000))]);
  if (code !== 0) fail(`o filho saiu com ${code}, esperado 0 em até 5 s`);
  if (failure) fail(failure);

  // 7. Resultado.
  clearTimeout(timeout);
  cleanup();
  console.log("app-smoke ok");
  process.exit(0);
} catch (err) {
  fail(err instanceof Error ? err.message : String(err));
}
