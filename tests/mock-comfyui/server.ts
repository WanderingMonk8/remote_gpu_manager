/**
 * Mock ComfyUI worker for M1 integration tests.
 *
 * Reproduces ONLY the surfaces the Lumiverse native provider and the
 * Remote GPU Manager gateway use:
 *   GET  /system_stats
 *   GET  /object_info            (+ /object_info/{node})
 *   POST /prompt
 *   GET  /history/{prompt_id}
 *   GET  /view?filename&subfolder&type
 *   GET  /queue
 *   POST /queue                  (delete list)
 *   POST /interrupt
 *   POST /upload/image           (stub; returns fixed name)
 *   WS   /ws?clientId=<id>       (execution events)
 *
 * All routes require HTTP Basic Auth (like ngrok's basic_auth) — the whole
 * point is to prove the gateway injects credentials upstream. Binds loopback
 * only. Requires MODELS env to contain the MOSS filenames so /system_stats
 * and /object_info fingerprints look plausible.
 */

const PORT = Number(process.env.MOCK_PORT || 8188);
const BASIC_USER = process.env.MOCK_USER || "lumiverse";
const BASIC_PASS = process.env.MOCK_PASS || "test-secret";
const EXECUTION_MS = Number(process.env.MOCK_EXECUTION_MS || 150);
// Delay before the first /view byte. Used to reproduce slow tunnel transfers
// (an 11-13 s image) without needing a multi-megabyte fixture.
const VIEW_DELAY_MS = Number(process.env.MOCK_VIEW_DELAY_MS || 0);
// Non-zero makes GET /queue report that many running jobs, so the gateway's
// idle timer must hold the runtime (PRD R-05). Default 0 keeps the queue empty.
const QUEUE_DEPTH = Number(process.env.MOCK_QUEUE_DEPTH || 0);

// 1x1 transparent PNG
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64",
);

const MOSS_FILENAMES = [
  "moss_image_sft_int8_convrot.safetensors",
  "moss_image_base_int8_convrot.safetensors",
];
const ENCODER = "qwen3.5_9b_w4a8_gptq.safetensors";
const VAE = "flux2-vae_small.safetensors";

function unauthorized(): Response {
  return new Response("Unauthorized", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="ComfyUI", charset="UTF-8"' },
  });
}

function checkAuth(req: Request): boolean {
  const header = req.headers.get("authorization");
  if (!header?.startsWith("Basic ")) return false;
  const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
  const idx = decoded.indexOf(":");
  if (idx < 0) return false;
  const u = decoded.slice(0, idx);
  const p = decoded.slice(idx + 1);
  return u === BASIC_USER && p === BASIC_PASS;
}

const OBJECT_INFO: Record<string, unknown> = {
  UNETLoader: {
    input: {
      required: {
        unet_name: [[MOSS_FILENAMES[0], MOSS_FILENAMES[1]]],
        weight_dtype: [["default", "fp8_e4m3fn", "fp8_e5m2"]],
      },
    },
    display_name: "UNETLoader",
  },
  CLIPLoader: {
    input: {
      required: {
        clip_name: [[ENCODER]],
        type: [["moss_image", "flux", "sdxl"]],
        device: [["default", "cpu"]],
      },
    },
    display_name: "CLIPLoader",
  },
  VAELoader: {
    input: { required: { vae_name: [[VAE]] } },
    display_name: "VAELoader",
  },
  CLIPTextEncode: {
    input: { required: { text: ["STRING", { multiline: true }] } },
    display_name: "CLIPTextEncode",
  },
  EmptyFlux2LatentImage: {
    input: {
      required: {
        width: ["INT", { min: 256, max: 4096 }],
        height: ["INT", { min: 256, max: 4096 }],
        batch_size: ["INT", { min: 1, max: 16 }],
      },
    },
    display_name: "EmptyFlux2LatentImage",
  },
  KSampler: {
    input: {
      required: {
        seed: ["INT", { min: 0, max: 9223372036854775807 }],
        steps: ["INT", { min: 1, max: 150 }],
        cfg: ["FLOAT", { min: 0, max: 100 }],
        sampler_name: [["er_sde", "euler", "dpmpp_2m"]],
        scheduler: [["simple", "normal", "beta"]],
        denoise: ["FLOAT", { min: 0, max: 1 }],
      },
    },
    display_name: "KSampler",
  },
  VAEDecode: { input: { required: {} }, display_name: "VAEDecode" },
  SaveImage: {
    input: { required: { filename_prefix: ["STRING"] } },
    display_name: "SaveImage",
  },
  LoraLoaderModelOnly: {
    input: {
      required: {
        model: ["MODEL"],
        lora_name: [["test_lora_v1.safetensors"]],
        strength_model: ["FLOAT", { min: -10, max: 10 }],
      },
    },
    display_name: "LoraLoaderModelOnly",
  },
  CheckpointLoaderSimple: {
    input: { required: { ckpt_name: [["unused-for-moss.safetensors"]] } },
    display_name: "CheckpointLoaderSimple",
  },
};

interface PendingPrompt {
  prompt: Record<string, { class_type: string; inputs: Record<string, unknown> }>;
  clientId: string;
  submittedAt: number;
  doneAt: number;
  outputs: Record<string, { images: Array<{ filename: string; subfolder: string; type: string }> }>;
  status: { status_str: string; completed: boolean; messages: unknown[] };
}

const prompts = new Map<string, PendingPrompt>();
const wsClients = new Map<string, Set<import("bun").ServerWebSocket<unknown>>>();

function sendToClient(clientId: string, message: unknown): void {
  const set = wsClients.get(clientId);
  if (!set) return;
  const text = JSON.stringify(message);
  for (const ws of set) {
    try {
      ws.send(text);
    } catch {
      /* dropped */
    }
  }
}

function finishPrompt(promptId: string): void {
  const entry = prompts.get(promptId);
  if (!entry) return;
  entry.doneAt = Date.now();
  entry.outputs = {
    "9": {
      images: [{ filename: "moss_00001_.png", subfolder: "", type: "output" }],
    },
  };
  entry.status = { status_str: "success", completed: true, messages: [["execution_success"]] };
  sendToClient(entry.clientId, { type: "progress", data: { value: 1, max: 1, prompt_id: promptId } });
  sendToClient(entry.clientId, { type: "executing", data: { node: "7", prompt_id: promptId } });
  sendToClient(entry.clientId, { type: "executing", data: { node: null, prompt_id: promptId } });
}

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: PORT,
  // The real ComfyUI worker is Python/aiohttp, which has no 10 s idle cap.
  // Without this the fixture's own default would close slow /view requests and
  // mask the gateway behaviour the tests are meant to exercise.
  idleTimeout: 255,
  async fetch(req, server) {
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (path === "/ws") {
      const clientId = url.searchParams.get("clientId");
      if (!clientId) return new Response("clientId required", { status: 400 });
      // Basic Auth on the WS handshake, mirroring ngrok's upstream behavior.
      if (!checkAuth(req)) return unauthorized();
      const ok = server.upgrade(req, { data: { clientId } });
      return ok ? undefined : new Response("upgrade failed", { status: 400 });
    }

    if (!checkAuth(req)) return unauthorized();

    if (req.method === "GET" && path === "/system_stats") {
      return json({
        system: {
          os: "posix",
          python_version: "3.12.3",
          embedded: false,
          comfyui_version: "0.3.42-mock",
        },
        devices: [
          {
            id: 0,
            name: "NVIDIA T4 (mock)",
            type: "cuda",
            vram_total: 15_000_000_000,
            vram_free: 10_500_000_000,
            torch_vram_total: 15_000_000_000,
            torch_vram_free: 10_500_000_000,
          },
        ],
      });
    }

    if (req.method === "GET" && path === "/object_info") {
      return json(OBJECT_INFO);
    }

    const nodeInfoMatch = path.match(/^\/object_info\/([A-Za-z0-9_]+)$/);
    if (req.method === "GET" && nodeInfoMatch) {
      const node = OBJECT_INFO[nodeInfoMatch[1]];
      return node ? json({ [nodeInfoMatch[1]]: node }) : json({}, 404);
    }

    if (req.method === "POST" && path === "/prompt") {
      let body: { prompt?: Record<string, { class_type: string; inputs: Record<string, unknown> }>; client_id?: string };
      try {
        body = await req.json();
      } catch {
        return json({ error: { type: "invalid_prompt", message: "bad JSON" } }, 400);
      }
      const prompt = body?.prompt;
      if (!prompt || typeof prompt !== "object") {
        return json({ error: { type: "invalid_prompt", message: "missing prompt" } }, 400);
      }
      const unet = prompt["1"];
      if (unet?.class_type !== "UNETLoader" || typeof unet?.inputs?.unet_name !== "string") {
        return json({ error: { type: "invalid_prompt", message: "expected UNETLoader at node 1" } }, 400);
      }
      if (!prompt["7"] || prompt["7"].class_type !== "KSampler") {
        return json({ error: { type: "invalid_prompt", message: "expected KSampler at node 7" } }, 400);
      }
      const promptId = crypto.randomUUID();
      prompts.set(promptId, {
        prompt,
        clientId: typeof body.client_id === "string" ? body.client_id : "anonymous",
        submittedAt: Date.now(),
        doneAt: 0,
        outputs: {},
        status: { status_str: "running", completed: false, messages: [] },
      });
      setTimeout(() => finishPrompt(promptId), EXECUTION_MS);
      return json({ prompt_id: promptId, number: prompts.size, node_errors: {} });
    }

    const historyMatch = path.match(/^\/history\/([0-9a-fA-F-]{36})$/);
    if (req.method === "GET" && historyMatch) {
      const entry = prompts.get(historyMatch[1]);
      return entry && entry.doneAt ? json({ [historyMatch[1]]: entry }) : json({});
    }

    if (req.method === "GET" && path === "/view") {
      const filename = url.searchParams.get("filename") ?? "";
      if (filename.includes("..") || filename.includes("/") || filename.includes("\\")) {
        return new Response("bad filename", { status: 400 });
      }
      if (!filename) return new Response("filename required", { status: 400 });
      // Simulate a big image over a slow tunnel: silence before the first byte.
      if (VIEW_DELAY_MS > 0) {
        await new Promise((resolve) => setTimeout(resolve, VIEW_DELAY_MS));
      }
      return new Response(TINY_PNG, {
        headers: { "Content-Type": "image/png", "Content-Length": String(TINY_PNG.length) },
      });
    }

    if (req.method === "GET" && path === "/queue") {
      return json({
        queue_running: QUEUE_DEPTH > 0 ? Array.from({ length: QUEUE_DEPTH }, () => ({})) : [],
        queue_pending: [],
      });
    }

    if (req.method === "POST" && path === "/queue") {
      return json({});
    }

    if (req.method === "POST" && path === "/interrupt") {
      return json({});
    }

    if (req.method === "POST" && path === "/upload/image") {
      const contentType = req.headers.get("content-type") ?? "";
      if (!contentType.startsWith("multipart/form-data")) {
        return json({ error: "expected multipart/form-data" }, 400);
      }
      return json({ name: "lumiverse-init-mock.png", subfolder: "", type: "input" });
    }

    // Deliberately-unallowlisted route the gateway must block:
    if (req.method === "GET" && path === "/debug/internal") {
      return json({ secret: "mock-internal-debug-data" });
    }

    return json({ error: "not found" }, 404);
  },
  websocket: {
    open(ws) {
      const clientId = (ws.data as { clientId: string }).clientId;
      let set = wsClients.get(clientId);
      if (!set) {
        set = new Set();
        wsClients.set(clientId, set);
      }
      set.add(ws);
      ws.send(JSON.stringify({ type: "status", data: { status: "connected" } }));
    },
    close(ws) {
      const clientId = (ws.data as { clientId: string }).clientId;
      wsClients.get(clientId)?.delete(ws);
    },
    message() {
      /* mock ignores inbound WS messages */
    },
  },
});

console.log(`mock-comfyui listening on 127.0.0.1:${PORT} (basic-auth, user=${BASIC_USER})`);
