/** Private stdio interface to the Colab bootstrap worker. Never log its payload. */
export interface BootstrapRequest {
  runtime: { name: string; connectionInfo: { url: string; token: string } };
  credentials: { TS_AUTHKEY: string; BASIC_AUTH_USER: string; BASIC_AUTH_PASS: string };
  state: Record<string, string>;
  drive?: { token: string; files: Array<{ id: string; name: string }> };
  workbook: { content: string; sha256: string };
  civitai?: unknown;
}

export interface BootstrapResult {
  funnel: string;
  state: Record<string, string>;
  kernelId: string;
  loraInstalled?: Array<{ url: string; name: string }>;
}

export async function runBootstrap(
  command: string[], request: BootstrapRequest, timeoutMs = 30 * 60_000,
): Promise<BootstrapResult> {
  const proc = Bun.spawn(command, { stdin: "pipe", stdout: "pipe", stderr: "ignore" });
  const timeout = setTimeout(() => proc.kill(), timeoutMs);
  try {
    proc.stdin.write(JSON.stringify(request));
    proc.stdin.end();
    // The worker emits a single bounded JSON document. Read incrementally so a
    // faulty process cannot cause unbounded memory use in the gateway.
    const reader = proc.stdout.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 8 * 1024 * 1024) {
        proc.kill();
        throw new Error("bootstrap_output_too_large");
      }
      chunks.push(value);
    }
    const exit = await proc.exited;
    if (exit !== 0) throw new Error("bootstrap_failed");
    const result = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (result?.ok !== true || typeof result.funnel !== "string" ||
        !result.state || typeof result.state !== "object" || Array.isArray(result.state) ||
        typeof result.kernelId !== "string" || !/^[a-zA-Z0-9-]{1,100}$/.test(result.kernelId)) {
      throw new Error("bootstrap_invalid_response");
    }
    const loraInstalled = result.loraInstalled;
    if (loraInstalled !== undefined && (!Array.isArray(loraInstalled) || loraInstalled.length > 100 || loraInstalled.some((item: any) =>
      typeof item?.url !== "string" || item.url.length > 8192 || typeof item.name !== "string" || item.name.length > 512))) throw new Error("bootstrap_invalid_response");
    return { funnel: result.funnel, state: result.state, kernelId: result.kernelId, ...(loraInstalled ? { loraInstalled } : {}) };
  } catch {
    throw new Error("bootstrap_failed");
  } finally {
    clearTimeout(timeout);
    proc.kill();
  }
}
