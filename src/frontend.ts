import type { SpindleFrontendContext } from "lumiverse-spindle-types";

const ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="1.5"/><rect x="2.5" y="9" width="2" height="6"/><rect x="19.5" y="9" width="2" height="6"/><path d="M9.5 2.5v2M12 2.5v2M14.5 2.5v2M9.5 19.5v2M12 19.5v2M14.5 19.5v2"/></svg>`;

export function setup(ctx: SpindleFrontendContext) {
  const STYLES = `
    .rgm-panel { display: grid; gap: 10px; padding: 16px; color: var(--lumiverse-text); }
    .rgm-panel h3 { margin: 0; font-size: 15px; }
    .rgm-panel p { margin: 0; color: var(--lumiverse-text-muted); font-size: 12px; line-height: 1.5; }
    .rgm-panel input { width: 100%; box-sizing: border-box; padding: 7px 9px; border: 1px solid var(--lumiverse-border); border-radius: 8px; background: var(--lumiverse-fill); color: var(--lumiverse-text); font: inherit; }
    .rgm-panel input:focus { outline: 2px solid var(--lumiverse-primary); outline-offset: 1px; }
    .rgm-actions { display: flex; gap: 8px; }
    .rgm-panel button { padding: 7px 12px; border: 1px solid var(--lumiverse-border); border-radius: 8px; background: var(--lumiverse-fill-subtle); color: var(--lumiverse-text); font: inherit; font-weight: 600; cursor: pointer; }
    .rgm-panel button:hover { background: var(--lumiverse-fill); }
    .rgm-panel button.rgm-primary { border-color: var(--lumiverse-primary); color: var(--lumiverse-primary); }
    .rgm-status { padding: 8px 10px; border-radius: 8px; border: 1px solid var(--lumiverse-border); font-size: 12px; font-weight: 600; }
    .rgm-status[data-tone="ok"] { color: var(--lumiverse-success, #4caf50); }
    .rgm-status[data-tone="bad"] { color: var(--lumiverse-error, #e57373); }
    .rgm-status[data-tone="unknown"] { color: var(--lumiverse-text-muted); }
    .rgm-out { margin: 0; max-height: 220px; overflow: auto; white-space: pre-wrap; font-size: 11px; color: var(--lumiverse-text-muted); }
  `;
  const removeStyle = ctx.dom.addStyle(STYLES);

  const drawer = ctx.ui.registerDrawerTab({
    id: "remote_gpu_manager",
    title: "Remote GPU Manager",
    shortName: "GPU",
    headerTitle: "Remote GPU Manager",
    description: "Warm-worker connectivity, lifecycle status and remote assets for the Colab GPU worker (MOSS / Anima).",
    keywords: ["gpu", "colab", "comfyui", "remote", "moss", "anima", "image generation"],
    iconSvg: ICON_SVG,
  });

  drawer.root.innerHTML = `
    <div class="rgm-panel">
      <h3>Remote GPU Manager</h3>
      <p>Warm-worker probe (M1). The Colab worker is started manually from your notebook; Lumiverse never starts it.</p>
      <input class="rgm-gw-url" type="text" spellcheck="false" placeholder="Gateway URL, e.g. http://127.0.0.1:8189" />
      <div class="rgm-actions">
        <button class="rgm-save-url" type="button">Save URL</button>
        <button class="rgm-check rgm-primary" type="button">Check worker</button>
      </div>
      <div class="rgm-status" data-tone="unknown">Not checked yet.</div>
      <pre class="rgm-out"></pre>
    </div>`;

  const out = drawer.root.querySelector(".rgm-out") as HTMLPreElement | null;
  const statusBox = drawer.root.querySelector(".rgm-status") as HTMLDivElement | null;
  const urlInput = drawer.root.querySelector(".rgm-gw-url") as HTMLInputElement | null;

  drawer.root.querySelector(".rgm-save-url")?.addEventListener("click", () => {
    if (urlInput?.value.trim()) ctx.sendToBackend({ type: "set_gateway_url", url: urlInput.value.trim() });
  });
  drawer.root.querySelector(".rgm-check")?.addEventListener("click", () => {
    if (statusBox) { statusBox.dataset.tone = "unknown"; statusBox.textContent = "Probing…"; }
    ctx.sendToBackend({ type: "status" });
  });

  const unsub = ctx.onBackendMessage((payload: any) => {
    if (!statusBox || !out) return;
    if (payload?.type === "status") {
      const gwOk = payload.gateway?.ok;
      const upOk = payload.upstream?.ok;
      statusBox.dataset.tone = gwOk && upOk ? "ok" : "bad";
      const hint = payload.gateway?.hint ?? payload.upstream?.hint;
      statusBox.textContent =
        `${gwOk ? (payload.gateway?.status ? `Gateway OK (${payload.gateway.status})` : "Gateway OK") : "Gateway unreachable"} · ` +
        `${upOk ? "Worker OK" : `Worker unreachable/degraded (${payload.upstream?.status ?? 0})`}` +
        (hint ? `\n${hint}` : "");
      out.textContent = JSON.stringify({ gateway: payload.gateway, upstream: payload.upstream }, null, 2);
    } else if (payload?.type === "gateway_url_saved") {
      statusBox.dataset.tone = "unknown";
      statusBox.textContent = `Saved: ${payload.url}`;
    } else if (payload?.type === "gateway_url_error") {
      statusBox.dataset.tone = "bad";
      statusBox.textContent = `URL rejected: ${payload.error}`;
    }
  });

  return () => {
    unsub();
    removeStyle();
    drawer.destroy();
  };
}
