import { PassThrough } from "stream";
import { describe, expect, it, vi } from "vitest";
import { RpcChannel, RpcRemoteError } from "../../src/app/rpc";
import type { RpcHandlers } from "../../src/app/rpc";

/** Dois PassThrough: `toChild` é a entrada do canal; `fromChild` é o que o canal escreve. */
function setup(overrides: Partial<RpcHandlers> = {}) {
  const toChild = new PassThrough();
  const fromChild = new PassThrough();
  const lines: Array<Record<string, unknown>> = [];
  let buffer = "";
  const waiters: Array<() => void> = [];
  fromChild.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    let i: number;
    while ((i = buffer.indexOf("\n")) >= 0) {
      lines.push(JSON.parse(buffer.slice(0, i)) as Record<string, unknown>);
      buffer = buffer.slice(i + 1);
    }
    for (const w of waiters.splice(0)) w();
  });
  const handlers: RpcHandlers = {
    onRequest: vi.fn(async (method: string) => ({ eco: method })),
    onNotification: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  };
  const channel = new RpcChannel(toChild, fromChild, handlers);
  const nextLine = async (): Promise<Record<string, unknown>> => {
    while (lines.length === 0) await new Promise<void>((r) => waiters.push(r));
    return lines.shift() as Record<string, unknown>;
  };
  const feed = (obj: unknown): void => void toChild.write(JSON.stringify(obj) + "\n");
  return { channel, handlers, toChild, nextLine, feed };
}

describe("RpcChannel", () => {
  it("responde a um pedido do outro lado com o result", async () => {
    const { feed, nextLine } = setup();
    feed({ jsonrpc: "2.0", id: 7, method: "ping", params: {} });
    expect(await nextLine()).toEqual({ jsonrpc: "2.0", id: 7, result: { eco: "ping" } });
  });

  it("converte RpcRemoteError em error com code, message e data; outro erro vira -32603", async () => {
    const { feed, nextLine } = setup({
      onRequest: async (method) => {
        if (method === "a") throw new RpcRemoteError(-32601, "Método desconhecido: a", { x: 1 });
        throw new Error("quebrou");
      },
    });
    feed({ jsonrpc: "2.0", id: 1, method: "a" });
    expect(await nextLine()).toEqual({ jsonrpc: "2.0", id: 1, error: { code: -32601, message: "Método desconhecido: a", data: { x: 1 } } });
    feed({ jsonrpc: "2.0", id: 2, method: "b" });
    expect(await nextLine()).toEqual({ jsonrpc: "2.0", id: 2, error: { code: -32603, message: "quebrou" } });
  });

  it("entrega notificações (sem id) ao handler e não responde", async () => {
    const { feed, handlers, nextLine } = setup();
    feed({ jsonrpc: "2.0", method: "cancelar", params: { id_chamada: 3 } });
    feed({ jsonrpc: "2.0", id: 1, method: "ping" });
    const first = await nextLine();
    expect(first.id).toBe(1);
    expect(handlers.onNotification).toHaveBeenCalledWith("cancelar", { id_chamada: 3 });
  });

  it("faz pedidos com ids desde 1 e completa com o result", async () => {
    const { channel, feed, nextLine } = setup();
    const p1 = channel.request("segredos/redigir", { texto: "a" });
    const sent1 = await nextLine();
    expect(sent1).toEqual({ jsonrpc: "2.0", id: 1, method: "segredos/redigir", params: { texto: "a" } });
    const p2 = channel.request("outro", {});
    expect((await nextLine()).id).toBe(2);
    feed({ jsonrpc: "2.0", id: 1, result: { texto: "a" } });
    feed({ jsonrpc: "2.0", id: 2, result: { ok: true } });
    expect(await p1).toEqual({ texto: "a" });
    expect(await p2).toEqual({ ok: true });
  });

  it("rejeita com RpcRemoteError quando a resposta traz error", async () => {
    const { channel, feed, nextLine } = setup();
    const p = channel.request("x", {});
    await nextLine();
    feed({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: "falhou", data: { codigo: "politica" } } });
    const err = (await p.catch((e: unknown) => e)) as RpcRemoteError;
    expect(err).toBeInstanceOf(RpcRemoteError);
    expect(err.code).toBe(-32000);
    expect(err.message).toBe("falhou");
    expect(err.data).toEqual({ codigo: "politica" });
  });

  it("notify escreve uma notificação sem id", async () => {
    const { channel, nextLine } = setup();
    channel.notify("inspector/registrar", { evento: "e", detalhe: "d" });
    expect(await nextLine()).toEqual({ jsonrpc: "2.0", method: "inspector/registrar", params: { evento: "e", detalhe: "d" } });
  });

  it("JSON inválido responde -32700 com id null", async () => {
    const { toChild, nextLine } = setup();
    toChild.write("{isto não é json\n");
    const res = await nextLine();
    expect(res.id).toBeNull();
    expect((res.error as { code: number }).code).toBe(-32700);
  });

  it("fim da entrada rejeita os pendentes com Canal fechado e chama onClose", async () => {
    const { channel, handlers, toChild, nextLine } = setup();
    const p = channel.request("x", {});
    await nextLine();
    const rejected = p.catch((e: unknown) => e);
    toChild.end();
    expect(((await rejected) as Error).message).toBe("Canal fechado");
    expect(handlers.onClose).toHaveBeenCalledTimes(1);
    await expect(channel.request("y", {})).rejects.toThrow("Canal fechado");
  });

  it("close() rejeita os pendentes sem chamar onClose", async () => {
    const { channel, handlers, nextLine } = setup();
    const p = channel.request("x", {});
    await nextLine();
    channel.close();
    await expect(p).rejects.toThrow("Canal fechado");
    expect(handlers.onClose).not.toHaveBeenCalled();
  });

  it("rejeita com Tempo esgotado quando não há resposta", async () => {
    const { channel, nextLine } = setup();
    const p = channel.request("x", {}, 30);
    await nextLine();
    await expect(p).rejects.toThrow("Tempo esgotado");
  });

  it("linha acima de 16 MiB fecha o canal", async () => {
    const { handlers, toChild, nextLine } = setup();
    toChild.write("x".repeat(16 * 1024 * 1024 + 1) + "\n");
    const res = await nextLine();
    expect((res.error as { code: number }).code).toBe(-32600);
    await vi.waitFor(() => expect(handlers.onClose).toHaveBeenCalledTimes(1));
  });
});
