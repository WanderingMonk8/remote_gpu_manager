import type { SpindleFrontendContext } from "lumiverse-spindle-types";

export function setup(ctx: SpindleFrontendContext) {
  const removeStyle = ctx.dom.addStyle(`
    .rgm-panel { padding: 10px; margin: 8px 0; border-radius: 8px; background: var(--lumiverse-fill-subtle); color: var(--lumiverse-text); font-size: 12px; }
    .rgm-panel h3 { margin: 0 0 6px 0; font-size: 13px; }
    .rgm-panel input { width: 100%; box-sizing: border-box; padding: 4px 6px; margin: 4px 0; }
    .rgm-panel button { padding: 4px 10px; cursor: pointer; }
    .rgm-panel pre { max-height: 220px; overflow: auto; white-space: pre-wrap; margin: 6px 0 0 0; }
    .rgm-ok { color: var(--lumiverse-success, #4caf50); }
    .rgm-bad { color: var(--lumiverse-error, #e57373); }
  `);

  ctx.dom.inject(
    "body",
    `<div class="rgm-panel">
       <h3>Remote GPU Manager</h3>
       <div>Gateway upstream worker status probe (M1).</div>
       <input class="rgm-gw-url" type="text" placeholder="Gateway URL, e.g. http://127.0.0.1:8189" />
       <button class="rgm-save-url" type="button">Save URL</button>
       <button class="rgm-check" type="button">Check worker</button>
       <pre class="rgm-out">Not checked yet.</pre>
     </div>`,
  );

  const out = ctx.dom.query(".rgm-out");
  const urlInput = ctx.dom.query(".rgm-gw-url") as HTMLInputElement | null;
  const saveBtn = ctx.dom.query(".rgm-save-url");
  const checkBtn = ctx.dom.query(".rgm-check");

  saveBtn?.addEventListener("click", () => {
    if (urlInput?.value.trim()) {
      ctx.sendToBackend({ type: "set_gateway_url", url: urlInput.value.trim() });
    }
  });

  checkBtn?.addEventListener("click", () => {
    if (out) out.textContent = "Probing…";
    ctx.sendToBackend({ type: "status" });
  });

  const unsub = ctx.onBackendMessage((payload: any) => {
    if (!out) return;
    if (payload?.type === "status") {
      const gw = payload.gateway?.ok ? "gateway OK" : `gateway UNREACHABLE (${payload.gateway?.status})`;
      const up = payload.upstream?.ok ? "worker OK" : `worker UNREACHABLE/DEGRADED (${payload.upstream?.status})`;
      out.innerHTML = "";
      const lines = [
        `${gw}`,
        `${up}`,
        "",
        JSON.stringify({ gateway: payload.gateway, upstream: payload.upstream }, null, 2),
      ];
      out.textContent = lines.join("\n");
    } else if (payload?.type === "gateway_url_saved") {
      out.textContent = `Saved gateway URL: ${payload.url}`;
    } else if (payload?.type === "gateway_url_error") {
      out.textContent = `URL rejected: ${payload.error}`;
    }
  });

  return () => {
    unsub();
    removeStyle();
    ctx.dom.cleanup();
  };
}
