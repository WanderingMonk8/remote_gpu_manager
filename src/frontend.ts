import type { SpindleFrontendContext } from "lumiverse-spindle-types";

const ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="1.5"/><rect x="2.5" y="9" width="2" height="6"/><rect x="19.5" y="9" width="2" height="6"/><path d="M9.5 2.5v2M12 2.5v2M14.5 2.5v2M9.5 19.5v2M12 19.5v2M14.5 19.5v2"/></svg>`;

export function setup(ctx: SpindleFrontendContext) {
  const STYLES = `
    .rgm-panel { display: grid; gap: 12px; padding: 16px; color: var(--lumiverse-text); }
    .rgm-panel h3 { margin: 0; font-size: 14px; }
    .rgm-panel h4 { margin: 0; font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: .06em; color: var(--lumiverse-text-muted); }
    .rgm-panel p { margin: 0; color: var(--lumiverse-text-muted); font-size: 12px; line-height: 1.5; }
    .rgm-panel input { width: 100%; box-sizing: border-box; padding: 7px 9px; border: 1px solid var(--lumiverse-border); border-radius: 8px; background: var(--lumiverse-fill); color: var(--lumiverse-text); font: inherit; }
    .rgm-panel input:focus { outline: 2px solid var(--lumiverse-primary); outline-offset: 1px; }
    .rgm-actions { display: flex; gap: 8px; flex-wrap: wrap; }
    .rgm-panel button { padding: 6px 11px; border: 1px solid var(--lumiverse-border); border-radius: 8px; background: var(--lumiverse-fill-subtle); color: var(--lumiverse-text); font: inherit; font-size: 12px; font-weight: 600; cursor: pointer; }
    .rgm-panel button:hover { background: var(--lumiverse-fill); }
    .rgm-panel button.rgm-primary { border-color: var(--lumiverse-primary); color: var(--lumiverse-primary); }
    .rgm-panel button.rgm-danger { border-color: var(--lumiverse-error); color: var(--lumiverse-error); }
    .rgm-status { padding: 8px 10px; border-radius: 8px; border: 1px solid var(--lumiverse-border); font-size: 12px; font-weight: 600; white-space: pre-wrap; }
    .rgm-status[data-tone="ok"] { color: var(--lumiverse-success, #4caf50); }
    .rgm-status[data-tone="bad"] { color: var(--lumiverse-error, #e57373); }
    .rgm-status[data-tone="unknown"] { color: var(--lumiverse-text-muted); }
    .rgm-out { margin: 0; max-height: 180px; overflow: auto; white-space: pre-wrap; font-size: 11px; color: var(--lumiverse-text-muted); }
    .rgm-section-divider { border: 0; border-top: 1px solid var(--lumiverse-border); margin: 4px 0; }
    .rgm-offer { border: 1px solid var(--lumiverse-border); border-radius: 10px; padding: 9px 11px; display: grid; gap: 4px; }
    .rgm-offer b { font-size: 12px; }
    .rgm-offer span { font-size: 11px; color: var(--lumiverse-text-muted); }
    .rgm-offer .rgm-price { font-weight: 700; color: var(--lumiverse-text); }
  `;
  const removeStyle = ctx.dom.addStyle(STYLES);

  const drawer = ctx.ui.registerDrawerTab({
    id: "remote_gpu_manager",
    title: "Remote GPU Manager",
    shortName: "GPU",
    headerTitle: "Remote GPU Manager",
    description: "Connect Lumiverse to a Vast.ai GPU worker for remote image generation.",
    keywords: ["gpu", "vast", "comfyui", "remote", "image generation"],
    iconSvg: ICON_SVG,
  });

  drawer.root.innerHTML = `
    <div class="rgm-panel">
      <h3>Remote GPU Manager</h3>

      <section>
        <h4>Worker probe</h4>
        <input class="rgm-gw-url" type="text" spellcheck="false" placeholder="Gateway URL, e.g. http://127.0.0.1:8189" />
        <div class="rgm-actions">
          <button class="rgm-save-url" type="button">Save URL</button>
          <button class="rgm-check rgm-primary" type="button">Check worker</button>
        </div>
        <div class="rgm-status" data-tone="unknown">Not checked yet.</div>
        <pre class="rgm-out"></pre>
      </section>

      <hr class="rgm-section-divider" />

      <section>
        <h4>Vast.ai account</h4>
        <p>API key stored in the Spindle Secure Enclave (AES-256-GCM, per-user). Never displayed or logged.</p>
        <input class="rgm-vast-key" type="password" spellcheck="false" autocomplete="off" placeholder="Paste your Vast.ai API key" />
        <div class="rgm-actions">
          <button class="rgm-test-key" type="button">Test credentials</button>
          <button class="rgm-save-key rgm-primary" type="button">Save securely</button>
          <button class="rgm-clear-key rgm-danger" type="button">Clear</button>
          <button class="rgm-find-offers" type="button">Find offers</button>
        </div>
        <div class="rgm-status" data-tone="unknown" id="rgm-vast-status">Checking configuration…</div>
        <div class="rgm-offers"></div>
      </section>
    </div>`;

  const out = drawer.root.querySelector(".rgm-out") as HTMLPreElement | null;
  const drawerStatus = drawer.root.querySelector(".rgm-status") as HTMLDivElement | null;
  const urlInput = drawer.root.querySelector(".rgm-gw-url") as HTMLInputElement | null;
  const sStatus = drawer.root.querySelector("#rgm-vast-status") as HTMLDivElement | null;
  const sKey = drawer.root.querySelector(".rgm-vast-key") as HTMLInputElement | null;
  const askVastStatus = () => ctx.sendToBackend({ type: "vast_get_status" });

  drawer.root.querySelector(".rgm-save-url")?.addEventListener("click", () => {
    if (urlInput?.value.trim()) ctx.sendToBackend({ type: "set_gateway_url", url: urlInput.value.trim() });
  });
  drawer.root.querySelector(".rgm-check")?.addEventListener("click", () => {
    if (drawerStatus) { drawerStatus.dataset.tone = "unknown"; drawerStatus.textContent = "Probing…"; }
    ctx.sendToBackend({ type: "status" });
  });
  drawer.root.querySelector(".rgm-test-key")?.addEventListener("click", () => {
    const key = sKey?.value.trim() ?? "";
    if (!key) { if (sStatus) { sStatus.dataset.tone = "bad"; sStatus.textContent = "Paste a key first."; } return; }
    if (sStatus) { sStatus.dataset.tone = "unknown"; sStatus.textContent = "Testing credentials against Vast.ai…"; }
    ctx.sendToBackend({ type: "vast_test_key", key });
  });
  drawer.root.querySelector(".rgm-save-key")?.addEventListener("click", () => {
    const key = sKey?.value.trim() ?? "";
    if (!key) { if (sStatus) { sStatus.dataset.tone = "bad"; sStatus.textContent = "Paste a key first."; } return; }
    if (sStatus) { sStatus.dataset.tone = "unknown"; sStatus.textContent = "Validating and saving…"; }
    ctx.sendToBackend({ type: "vast_save_key", key });
  });
  drawer.root.querySelector(".rgm-clear-key")?.addEventListener("click", () => {
    if (sStatus) { sStatus.dataset.tone = "unknown"; sStatus.textContent = "Clearing…"; }
    ctx.sendToBackend({ type: "vast_clear_key" });
  });
  drawer.root.querySelector(".rgm-find-offers")?.addEventListener("click", () => {
    const box = drawer.root.querySelector(".rgm-offers");
    if (box) box.innerHTML = '<div class="rgm-status" data-tone="unknown">Searching offers on Vast.ai…</div>';
    ctx.sendToBackend({ type: "vast_search_offers" });
  });

  const unsub = ctx.onBackendMessage((payload: any) => {
    if (!payload || typeof payload !== "object") return;
    switch (payload.type) {
      case "status":
        if (drawerStatus) {
          const gwOk = payload.gateway?.ok;
          const upOk = payload.upstream?.ok;
          const hint = payload.gateway?.hint ?? payload.upstream?.hint;
          drawerStatus.dataset.tone = gwOk && upOk ? "ok" : "bad";
          drawerStatus.textContent =
            `${gwOk ? "Gateway OK" : "Gateway unreachable"} · ${upOk ? "Worker OK" : `Worker unreachable/degraded (${payload.upstream?.status ?? 0})`}` +
            (hint ? `\n${hint}` : "");
        }
        if (out) out.textContent = JSON.stringify({ gateway: payload.gateway, upstream: payload.upstream }, null, 2);
        return;
      case "gateway_url_saved":
        if (drawerStatus) { drawerStatus.dataset.tone = "unknown"; drawerStatus.textContent = `Saved: ${payload.url}`; }
        return;
      case "gateway_url_error":
        if (drawerStatus) { drawerStatus.dataset.tone = "bad"; drawerStatus.textContent = `URL rejected: ${payload.error}`; }
        return;
      case "vast_get_status_result":
        if (sStatus) {
          sStatus.dataset.tone = payload.configured ? "ok" : "bad";
          sStatus.textContent = payload.configured ? "Vast.ai key configured (enclave)." : "No Vast.ai key saved yet.";
        }
        return;
      case "vast_test_key_result":
        if (sStatus) {
          sStatus.dataset.tone = payload.ok ? "ok" : "bad";
          sStatus.textContent = payload.ok
            ? `Credentials accepted (HTTP ${payload.status}).`
            : `Rejected (HTTP ${payload.status}) — check the key.`;
        }
        return;
      case "vast_save_key_result":
        if (sStatus) {
          if (payload.ok) {
            if (sKey) sKey.value = "";
            sStatus.dataset.tone = "ok";
            sStatus.textContent = "Key saved to the Secure Enclave.";
          } else {
            sStatus.dataset.tone = "bad";
            sStatus.textContent = `Save failed: ${payload.error ?? "unknown error"}`;
          }
        }
        return;
      case "vast_clear_key_result":
        if (sKey) sKey.value = "";
        if (sStatus) { sStatus.dataset.tone = "bad"; sStatus.textContent = "Key cleared."; }
        return;
      case "vast_search_offers_result": {
        const box = drawer.root.querySelector(".rgm-offers");
        if (!box) return;
        if (payload.ok) {
          if (payload.offers?.length) {
            box.innerHTML = payload.offers.map((o: any) => `
              <div class="rgm-offer">
                <div><b>Offer #${o.id}</b> · ${String(o.gpuName ?? "")} × ${o.gpuCount ?? 1} · ${((o.vramMB ?? 0) / 1024).toFixed(1)} GiB</div>
                <span>${((o.ramMB ?? 0) / 1024).toFixed(0)} GB RAM · ${o.diskGB} GB disk · ${String(o.geolocation ?? "-")} · reliability ${(o.reliability ?? 0).toFixed(3)}</span>
                <div class="rgm-price">$${Number(o.dphTotal ?? 0).toFixed(3)}/hr</div>
              </div>`).join("");
          } else {
            box.innerHTML = '<div class="rgm-status" data-tone="bad">No matching offers right now.</div>';
          }
        } else {
          box.innerHTML = `<div class="rgm-status" data-tone="bad">${payload.error ?? "search failed"}</div>`;
        }
        return;
      }
    }
  });

  askVastStatus();

  return () => {
    unsub();
    removeStyle();
    drawer.destroy();
  };
}
