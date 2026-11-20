/**
 * Mock Colab API v1beta + OAuth token endpoint for lifecycle tests.
 *
 * Serves ONLY what the gateway calls:
 *   POST /token                 OAuth refresh (returns a fixed token)
 *   GET  /v1beta/runtimespecs   eligibility list
 *   POST /v1beta/runtimes       create (MOCK_CREATE_FAIL=1 -> FAILED_PRECONDITION)
 *   GET  /v1beta/runtimes       list (MOCK_FOREIGN=1 adds a foreign runtime)
 *   GET  /v1beta/runtimes/{id}  status + connectionInfo
 *   DELETE /v1beta/runtimes/{id} unassign
 *   GET  /__log                 call log for assertions (test fixture only)
 *
 * The proxy token is obviously fake; tests assert it never appears in any
 * gateway response. Binds loopback only.
 */
const PORT = Number(process.env.MOCK_COLAB_PORT || 9400);
const CREATE_FAIL = (process.env.MOCK_CREATE_FAIL ?? "") === "1";
const FOREIGN = (process.env.MOCK_FOREIGN ?? "") === "1";
// Slows POST /v1beta/runtimes so tests can hold the gateway mid-provisioning.
const CREATE_DELAY_MS = Number(process.env.MOCK_CREATE_DELAY_MS || 800);
const TOKEN = "mock-proxy-token-SECRET";

const runtimes = new Map<string, any>();
const calls: Array<{ method: string; path: string; auth: string }> = [];

const json = (data: unknown, status = 200) => Response.json(data, { status });

Bun.serve({
  hostname: "127.0.0.1",
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    calls.push({ method: req.method, path, auth: req.headers.get("authorization") ?? "" });

    if (req.method === "POST" && path === "/token") {
      return json({ access_token: "mock-access-token", expires_in: 3600, token_type: "Bearer" });
    }

    if (req.method === "GET" && path.startsWith("/drive/v3/files/")) {
      const id = path.split("/").pop()!;
      const names: Record<string, string> = { a: "moss_image_sft_int8_convrot.safetensors", b: "qwen3.5_9b_w4a8_gptq.safetensors", c: "flux2-vae_small.safetensors" };
      return names[id] ? json({ id, name: names[id], size: "123456", md5Checksum: "a".repeat(32) }) : json({ error: "forbidden" }, 403);
    }

    if (req.method === "GET" && path === "/v1beta/runtimespecs") {
      return json({
        runtimeSpecs: [
          { key: { variant: "VARIANT_GPU", accelerator: "T4", shape: "SHAPE_STANDARD" }, eligible: true },
          { key: { variant: "VARIANT_GPU", accelerator: "A100", shape: "SHAPE_STANDARD" }, eligible: false },
        ],
      });
    }

    if (req.method === "POST" && path === "/v1beta/runtimes") {
      if (CREATE_FAIL) {
        return json({ error: { code: 9, status: "FAILED_PRECONDITION", message: "Free tier has no T4 right now" } }, 400);
      }
      if (CREATE_DELAY_MS > 0) {
        await new Promise((r) => setTimeout(r, CREATE_DELAY_MS));
      }
      const id = url.searchParams.get("runtimeId") ?? "rgm-gw-unknown";
      runtimes.set(id, {
        name: `runtimes/${id}`,
        runtimeSpec: { variant: "VARIANT_GPU", accelerator: "T4", shape: "SHAPE_STANDARD" },
        connectionInfo: {
          url: "https://8080-gpu-t4-s-mock.colab.dev",
          token: TOKEN,
          expireTime: new Date(Date.now() + 3_600_000).toISOString(),
        },
      });
      return json({ name: `operations/op-${id}`, done: true }, 200);
    }

    if (req.method === "GET" && path === "/v1beta/runtimes") {
      const list = [...runtimes.keys()].map((id) => runtimes.get(id));
      if (FOREIGN) {
        list.push({
          name: "runtimes/someone-else",
          runtimeSpec: { variant: "VARIANT_GPU", accelerator: "T4", shape: "SHAPE_STANDARD" },
          connectionInfo: { url: "https://8080-foreign.colab.dev", token: "foreign", expireTime: "" },
        });
      }
      return json({ runtimes: list });
    }

    const single = path.match(/^\/v1beta\/runtimes\/(.+)$/);
    if (single) {
      const id = single[1];
      if (req.method === "GET") {
        const r = runtimes.get(id);
        return r ? json(r) : json({ error: { code: 5, status: "NOT_FOUND", message: "no such runtime" } }, 404);
      }
      if (req.method === "DELETE") {
        if (runtimes.has(id)) {
          runtimes.delete(id);
          return json({});
        }
        return json({ error: { code: 5, status: "NOT_FOUND", message: "no such runtime" } }, 404);
      }
    }

    if (req.method === "GET" && path === "/__log") {
      return json({ calls, runtimes: [...runtimes.keys()] });
    }
    return json({ error: "not found" }, 404);
  },
});

console.log(`mock-colab listening on 127.0.0.1:${PORT} (create_fail=${CREATE_FAIL} foreign=${FOREIGN})`);
