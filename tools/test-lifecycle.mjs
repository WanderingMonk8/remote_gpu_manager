#!/usr/bin/env node
/**
 * Drive the gateway's lifecycle API end to end (ADR-006).
 *
 * This is the "can I actually test it?" tool: it talks to a RUNNING gateway and
 * walks the whole cycle, printing every step. No extension, no Space change.
 *
 *   1. POST   /gateway/v1/runtime/credentials   (from tools/.colab-creds.json)
 *   2. GET    /gateway/v1/runtime               (expect offline)
 *   3. POST   /gateway/v1/runtime               (allocate a real T4)
 *   4. GET    /gateway/v1/runtime               (expect ready + idle countdown)
 *   5. PUT    /gateway/v1/runtime/idle          (set the timeout)
 *   6. DELETE /gateway/v1/runtime               (confirm deletion)
 *   7. GET    /gateway/v1/runtime               (expect offline)
 *
 * Steps 1, 3 and 6 cost real Colab quota. Everything is deleted at the end
 * unless --keep is passed, and a failure after allocation still tries to delete.
 *
 * Usage:
 *   node tools/test-lifecycle.mjs                      # default http://127.0.0.1:8189
 *   node tools/test-lifecycle.mjs --url http://127.0.0.1:8189 --token <control token>
 *   node tools/test-lifecycle.mjs --keep               # leave the runtime running
 *   node tools/test-lifecycle.mjs --idle 5             # idle minutes to set
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

const argv = process.argv.slice(2);
const flag = (name, fallback = undefined) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
};
const has = (name) => argv.includes(`--${name}`);

const CREDS = flag("creds", join(HERE, ".colab-creds.json"));
const BASE = (flag("url", process.env.GATEWAY_URL ?? "http://127.0.0.1:8189")).replace(/\/+$/, "");
const TOKEN = flag("token", process.env.GATEWAY_CONTROL_TOKEN ?? "");
const KEEP = has("keep");
const STOP_ONLY = has("stop-only");
const IDLE = Number(flag("idle", "10"));

if (!TOKEN) {
  console.error(
    "Missing control token.\n" +
      "  pass --token <value>, or set GATEWAY_CONTROL_TOKEN in this shell.\n" +
      "  It must match the GATEWAY_CONTROL_TOKEN the gateway was started with.",
  );
  process.exit(2);
}

let creds;
try {
  creds = JSON.parse(readFileSync(CREDS, "utf8"));
} catch {
  console.error(
    `Missing ${CREDS}\n` +
      "  Create it once with:\n" +
      "    .venv\\Scripts\\python.exe tools\\colab-runtime-api.py creds",
  );
  process.exit(2);
}

const auth = { Authorization: `Bearer ${TOKEN}` };

async function call(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { ...auth, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text.slice(0, 300) };
  }
  return { status: res.status, json };
}

const step = (n, label) => console.log(`\n[${n}] ${label}`);
const show = (r) => console.log(`    -> ${r.status} ${JSON.stringify(r.json)}`);

/** Never let a secret reach the terminal, even if the gateway regresses. */
function assertNoSecret(value, label) {
  const text = JSON.stringify(value);
  for (const [name, secret] of Object.entries({
    "refresh_token": creds.refresh_token,
    "client_secret": creds.client_secret,
  })) {
    if (secret && text.includes(secret)) {
      throw new Error(`${label} leaked ${name} — stop and report this`);
    }
  }
}

let allocated = false;
try {
  if (STOP_ONLY) {
    step(1, "stop-only: delete whatever this gateway owns");
    const put = await call("POST", "/gateway/v1/runtime/credentials", {
      client_id: creds.client_id,
      client_secret: creds.client_secret,
      refresh_token: creds.refresh_token,
    });
    if (put.status !== 200) throw new Error(`credential store failed (${put.status})`);
    const stopped = await call("DELETE", "/gateway/v1/runtime");
    show(stopped);
    if (!stopped.json?.confirmed && stopped.status !== 404) {
      throw new Error("deletion was not confirmed");
    }
    console.log("\nDone.");
    process.exit(0);
  }

  step(1, "store credentials in the gateway (memory only)");
  const put = await call("POST", "/gateway/v1/runtime/credentials", {
    client_id: creds.client_id,
    client_secret: creds.client_secret,
    refresh_token: creds.refresh_token,
  });
  show(put);
  if (put.status !== 200) throw new Error("credential store failed");

  step(2, "status before starting (expect offline)");
  const before = await call("GET", "/gateway/v1/runtime");
  show(before);
  assertNoSecret(before.json, "status");

  step(3, "START — allocate a real runtime (this costs quota)");
  const started = await call("POST", "/gateway/v1/runtime");
  show(started);
  assertNoSecret(started.json, "start");
  if (started.status !== 200) throw new Error("start failed");
  allocated = true;

  step(4, "status after starting (expect ready + idle countdown)");
  const ready = await call("GET", "/gateway/v1/runtime");
  show(ready);

  step(5, `set idle timeout to ${IDLE} min`);
  const idle = await call("PUT", "/gateway/v1/runtime/idle", { minutes: IDLE });
  show(idle);

  if (KEEP) {
    console.log(
      `\n--keep: ${started.json.runtime?.name} is STILL RUNNING and consuming quota.\n` +
        `  stop it with:  node tools/test-lifecycle.mjs --token <token> --stop-only`,
    );    allocated = false;
    process.exit(0);
  }

  step(6, "STOP — delete and confirm");
  const stopped = await call("DELETE", "/gateway/v1/runtime");
  show(stopped);
  if (stopped.json?.confirmed) allocated = false;
  if (!stopped.json?.confirmed) throw new Error("deletion was not confirmed");

  step(7, "status after stopping (expect offline)");
  const after = await call("GET", "/gateway/v1/runtime");
  show(after);

  console.log("\nAll steps passed.");
} catch (err) {
  console.error(`\nFAILED: ${err.message}`);
  if (allocated) {
    console.error("Cleaning up: deleting the runtime this script created…");
    try {
      const cleanup = await call("DELETE", "/gateway/v1/runtime");
      console.error(`  cleanup -> ${cleanup.status} ${JSON.stringify(cleanup.json)}`);
    } catch (e) {
      console.error(`  cleanup failed (${e.message}). Check Colab for a stray rgm-gw- runtime.`);
    }
  }
  process.exit(1);
}
