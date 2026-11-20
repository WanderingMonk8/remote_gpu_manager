/** Private stdio interface to the Colab bootstrap worker. Never log its payload. */
export interface BootstrapRequest {
  runtime: { name: string; connectionInfo: { url: string; token: string } };
  credentials: { TS_AUTHKEY: string; BASIC_AUTH_USER: string; BASIC_AUTH_PASS: string };
  state: Record<string, string>;
}

export interface BootstrapResult {
  funnel: string;
  state: Record<string, string>;
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
        !result.state || typeof result.state !== "object" || Array.isArray(result.state)) {
      throw new Error("bootstrap_invalid_response");
    }
    return { funnel: result.funnel, state: result.state };
  } catch {
    throw new Error("bootstrap_failed");
  } finally {
    clearTimeout(timeout);
    proc.kill();
  }
}
