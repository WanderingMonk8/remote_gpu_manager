import { describe, expect, test } from "bun:test";
import { JupyterConnection } from "../host-gateway/jupyter-connection";

describe("Jupyter connection", () => {
  test("connects with fresh proxy credentials and closes on stop", async () => {
    let url = "";
    let header = "";
    let closed = false;
    const socket = { onopen: null, onclose: null, onerror: null, close() { closed = true; } } as unknown as WebSocket;
    const connection = new JupyterConnection(async () => ({ url: "https://8080-test.colab.dev", token: "private-token" }),
      (u, token) => { url = u; header = token; return socket; });
    connection.start("kernel-1");
    await Promise.resolve();
    expect(connection.status()).toBe("connecting");
    expect(new URL(url).pathname).toBe("/api/kernels/kernel-1/channels");
    expect(header).toBe("private-token");
    socket.onopen?.(new Event("open"));
    expect(connection.status()).toBe("connected");
    connection.stop();
    expect(closed).toBe(true);
    expect(connection.status()).toBe("stopped");
  });

  test("cancels a pending credential request and rejects untrusted hosts", async () => {
    let resolve!: (value: { url: string; token: string }) => void;
    let opened = false;
    const connection = new JupyterConnection(() => new Promise(r => { resolve = r; }), () => { opened = true; throw new Error(); });
    connection.start("kernel-1");
    connection.stop();
    resolve({ url: "https://8080-test.colab.dev", token: "secret" });
    await Promise.resolve();
    expect(opened).toBe(false);
    const bad = new JupyterConnection(async () => ({ url: "https://example.com", token: "secret" }), () => { opened = true; throw new Error(); });
    bad.start("kernel-1");
    await Promise.resolve();
    expect(opened).toBe(false);
    expect(bad.status()).toBe("reconnecting");
    bad.stop();
  });
});
