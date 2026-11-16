// Canal JSON-RPC 2.0 por linhas (stdio) entre o app AI Ecosystem 2.0 e este processo filho.
// Cada mensagem é um objeto JSON numa linha UTF-8 terminada por "\n". Os dois lados fazem pedidos
// (ids numéricos próprios, desde 1) e notificações. Logs nunca passam por aqui (só pelo stderr).
import * as readline from "readline";

/** Tamanho máximo de uma linha (16 MiB). Acima disso o canal fecha. */
export const MAX_LINE_CHARS = 16 * 1024 * 1024;

/** Erro devolvido pelo outro lado (ou que vira `error` na resposta que damos). */
export class RpcRemoteError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "RpcRemoteError";
  }
}

export interface RpcHandlers {
  onRequest(method: string, params: unknown, id: number): Promise<unknown>;
  onNotification(method: string, params: unknown): void;
  onClose?(): void;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class RpcChannel {
  private readonly rl: readline.Interface;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private closed = false;
  private closeNotified = false;

  constructor(
    input: NodeJS.ReadableStream,
    private readonly output: NodeJS.WritableStream,
    private readonly handlers: RpcHandlers,
  ) {
    this.rl = readline.createInterface({ input, crlfDelay: Infinity });
    this.rl.on("line", (line) => this.onLine(line));
    this.rl.on("close", () => this.shutdown(true));
  }

  /** Faz um pedido ao outro lado. Rejeita com RpcRemoteError (erro remoto), "Tempo esgotado" ou "Canal fechado". */
  request(method: string, params: unknown, timeoutMs = 60_000): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error("Canal fechado"));
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("Tempo esgotado"));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  /** Notificação (sem id, sem resposta). */
  notify(method: string, params: unknown): void {
    if (this.closed) return;
    this.send({ jsonrpc: "2.0", method, params });
  }

  /** Fecha o canal e rejeita os pedidos pendentes. Não chama onClose (quem fecha já sabe). */
  close(): void {
    this.shutdown(false);
  }

  private send(message: JsonObject): void {
    if (this.closed) return;
    this.output.write(JSON.stringify(message) + "\n");
  }

  private shutdown(notify: boolean): void {
    // Fechamento pedido por nós: o evento "close" do readline não deve chamar onClose.
    if (!notify) this.closeNotified = true;
    if (!this.closed) {
      this.closed = true;
      this.rl.close();
      for (const [id, p] of this.pending) {
        clearTimeout(p.timer);
        this.pending.delete(id);
        p.reject(new Error("Canal fechado"));
      }
    }
    if (notify && !this.closeNotified) {
      this.closeNotified = true;
      this.handlers.onClose?.();
    }
  }

  private writeError(id: number | string | null, code: number, message: string): void {
    this.send({ jsonrpc: "2.0", id, error: { code, message } });
  }

  private onLine(line: string): void {
    if (this.closed) return;
    if (line.length > MAX_LINE_CHARS) {
      this.writeError(null, -32600, "Linha acima de 16 MiB");
      this.shutdown(true);
      return;
    }
    if (line.trim() === "") return;
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      this.writeError(null, -32700, "JSON inválido");
      return;
    }
    if (!isObject(message)) {
      this.writeError(null, -32600, "Requisição inválida");
      return;
    }
    const id = message.id;
    const hasId = typeof id === "number" || typeof id === "string";
    if (typeof message.method === "string") {
      if (hasId && typeof id === "number") void this.handleRequest(id, message.method, message.params);
      else if (hasId) this.writeError(id, -32600, "O id do pedido tem de ser numérico");
      else this.handlers.onNotification(message.method, message.params);
      return;
    }
    if (typeof id === "number" && ("result" in message || "error" in message)) {
      this.handleResponse(id, message);
      return;
    }
    this.writeError(hasId ? id : null, -32600, "Requisição inválida");
  }

  private async handleRequest(id: number, method: string, params: unknown): Promise<void> {
    try {
      const result = await this.handlers.onRequest(method, params, id);
      this.send({ jsonrpc: "2.0", id, result: result === undefined ? null : result });
    } catch (err) {
      if (err instanceof RpcRemoteError) {
        const error: JsonObject = { code: err.code, message: err.message };
        if (err.data !== undefined) error.data = err.data;
        this.send({ jsonrpc: "2.0", id, error });
      } else {
        this.writeError(id, -32603, err instanceof Error ? err.message : String(err));
      }
    }
  }

  private handleResponse(id: number, message: JsonObject): void {
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    clearTimeout(p.timer);
    if (isObject(message.error)) {
      const e = message.error;
      p.reject(new RpcRemoteError(typeof e.code === "number" ? e.code : -32603, typeof e.message === "string" ? e.message : "Erro remoto", e.data));
    } else {
      p.resolve(message.result);
    }
  }
}
