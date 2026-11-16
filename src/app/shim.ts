// Preparação do ambiente Node para o código do plugin. Tem de ser o primeiro import de main.ts.
// 1. O código do plugin usa window.setTimeout e afins (janelas popout do Obsidian): no Node, window = globalThis.
// 2. O stdout é só do JSON-RPC: console.log, info, debug e warn vão para o stderr.
if (typeof (globalThis as { window?: unknown }).window === "undefined") {
  (globalThis as unknown as { window: unknown }).window = globalThis;
}

function toStderr(...args: unknown[]): void {
  const text = args.map((a) => (typeof a === "string" ? a : a instanceof Error ? (a.stack ?? a.message) : safeStringify(a))).join(" ");
  process.stderr.write(text + "\n");
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

console.log = toStderr;
console.info = toStderr;
console.debug = toStderr;
console.warn = toStderr;

export {};
