import type { SpindleFrontendContext } from "lumiverse-spindle-types";

const escapeHtml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

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
    .rgm-field { display: grid; gap: 4px; font-size: 11px; color: var(--lumiverse-text-muted); }
    .rgm-field span { font-size: 10px; text-transform: uppercase; letter-spacing: .04em; }
    .rgm-field input, .rgm-field select { width: 100%; box-sizing: border-box; padding: 5px 7px; border: 1px solid var(--lumiverse-border); border-radius: 6px; background: var(--lumiverse-fill); color: var(--lumiverse-text); font: inherit; font-size: 12px; }
    .rgm-filter-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px 10px; padding: 8px 0 2px; }
    .rgm-check { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--lumiverse-text); padding-top: 12px; }
    .rgm-check input { width: auto; }
    .rgm-key-banner { padding: 8px 10px; border-radius: 8px; border: 1px solid var(--lumiverse-border); font-size: 12px; font-weight: 700; text-align: center; }
    .rgm-key-banner[data-tone="ok"] { color: var(--lumiverse-success, #4caf50); background: color-mix(in srgb, var(--lumiverse-success, #4caf50) 10%, transparent); }
    .rgm-key-banner[data-tone="bad"] { color: var(--lumiverse-text-muted); }
    .rgm-key-banner[data-tone="unknown"] { color: var(--lumiverse-text-muted); }
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
        <div class="rgm-key-banner" id="rgm-key-banner" data-tone="unknown">Checking configuration…</div>
        <p>API key stored in the Spindle Secure Enclave (AES-256-GCM, per-user). Never displayed or logged.</p>
        <input class="rgm-vast-key" type="password" spellcheck="false" autocomplete="off" placeholder="Paste your Vast.ai API key" />
        <div class="rgm-actions">
          <button class="rgm-test-key" type="button">Test credentials</button>
          <button class="rgm-save-key rgm-primary" type="button">Save securely</button>
          <button class="rgm-clear-key rgm-danger" type="button">Clear</button>
        </div>
        <div class="rgm-status" data-tone="unknown" id="rgm-vast-status">Paste a key, or Find offers.</div>
        <hr class="rgm-section-divider" />
        <h4>Find offers</h4>
        <div class="rgm-filter-grid">
          <label class="rgm-field"><span>Price min ($/hr)</span><input class="rgm-price-min" type="number" placeholder="0.00" min="0" max="10" step="0.01" /></label>
          <label class="rgm-field"><span>Price max ($/hr)</span><input class="rgm-price-max" type="number" value="0.50" min="0" max="10" step="0.01" /></label>
        </div>
        <div class="rgm-actions">
          <button class="rgm-find-offers rgm-primary" type="button">Find offers</button>
          <button class="rgm-toggle-filters" type="button">Advanced filters ▾</button>
        </div>
        <div class="rgm-filters" hidden>
          <div class="rgm-filter-grid">
            <label class="rgm-field"><span>GPU names (CSV)</span><input class="f-gpu" type="text" value="RTX_3090,RTX_4090,RTX_5090,RTX_A5000" /></label>
            <label class="rgm-field"><span>VRAM min (GB)</span><input class="f-vram-min" type="number" value="24" min="0" step="1" /></label>
            <label class="rgm-field"><span>VRAM max (GB)</span><input class="f-vram-max" type="number" placeholder="any" min="0" step="1" /></label>
            <label class="rgm-field"><span>RAM min (GB)</span><input class="f-ram-min" type="number" value="32" min="0" step="1" /></label>
            <label class="rgm-field"><span>RAM max (GB)</span><input class="f-ram-max" type="number" placeholder="any" min="0" step="1" /></label>
            <label class="rgm-field"><span>Disk min (GB)</span><input class="f-disk" type="number" placeholder="any" min="0" step="1" /></label>
            <label class="rgm-field"><span>Reliability min</span><input class="f-rel" type="number" placeholder="any" min="0" max="1" step="0.001" /></label>
            <label class="rgm-field"><span>Geolocation (CSV)</span><input class="f-geo" type="text" placeholder="US,DE,JP …" /></label>
            <label class="rgm-field"><span>Max storage $/GB/mo</span><input class="f-storage" type="number" placeholder="any" min="0" step="0.01" /></label>
            <label class="rgm-field"><span>Duration min (s)</span><input class="f-duration" type="number" placeholder="any" min="0" step="1" /></label>
            <label class="rgm-field"><span>Net down min (MB/s)</span><input class="f-inetdown" type="number" placeholder="any" min="0" step="1" /></label>
            <label class="rgm-field"><span>Net up min (MB/s)</span><input class="f-inetup" type="number" placeholder="any" min="0" step="1" /></label>
            <label class="rgm-field"><span>CPU cores min</span><input class="f-cpucores" type="number" placeholder="any" min="0" step="1" /></label>
            <label class="rgm-field"><span>CPU GHz min</span><input class="f-cpumhz" type="number" placeholder="any" min="0" step="0.1" /></label>
            <label class="rgm-field"><span>Direct ports min</span><input class="f-ports" type="number" placeholder="any" min="0" step="1" /></label>
            <label class="rgm-field"><span>Verification</span>
              <select class="f-ver"><option value="any" selected>any</option><option value="verified">verified</option><option value="unverified">unverified</option></select>
            </label>
            <label class="rgm-check"><input class="f-dc" type="checkbox" /><span>Datacenter only</span></label>
            <label class="rgm-check"><input class="f-static" type="checkbox" /><span>Static IP only</span></label>
            <label class="rgm-check"><input class="f-rented" type="checkbox" checked /><span>Exclude rented</span></label>
          </div>
        </div>
        <div class="rgm-offers"></div>
      </section>
    </div>`;

  const out = drawer.root.querySelector(".rgm-out") as HTMLPreElement | null;
  const drawerStatus = drawer.root.querySelector(".rgm-status") as HTMLDivElement | null;
  const urlInput = drawer.root.querySelector(".rgm-gw-url") as HTMLInputElement | null;
  const sStatus = drawer.root.querySelector("#rgm-vast-status") as HTMLDivElement | null;
  const sKey = drawer.root.querySelector(".rgm-vast-key") as HTMLInputElement | null;
  const askVastStatus = () => ctx.sendToBackend({ type: "vast_get_status" });
  const banner = drawer.root.querySelector("#rgm-key-banner") as HTMLDivElement | null;
  const paintBanner = (tone: "ok" | "bad" | "unknown", text: string) => {
    if (!banner) return;
    banner.dataset.tone = tone;
    banner.textContent = text;
  };

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
    ctx.sendToBackend({ type: "vast_search_offers", policy: readPolicy() });
  });
  drawer.root.querySelector(".rgm-toggle-filters")?.addEventListener("click", () => {
    const box = drawer.root.querySelector(".rgm-filters");
    const btn = drawer.root.querySelector(".rgm-toggle-filters") as HTMLButtonElement | null;
    if (!box || !btn) return;
    const hidden = !box.hasAttribute("hidden");
    if (hidden) box.setAttribute("hidden", ""); else box.removeAttribute("hidden");
    btn.textContent = hidden ? "Advanced filters ▾" : "Advanced filters ▴";
  });
  function num(sel: string): number | undefined {
    const v = (drawer.root.querySelector(sel) as HTMLInputElement | null)?.value?.trim();
    if (!v) return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }
  function str(sel: string): string | undefined {
    const v = (drawer.root.querySelector(sel) as HTMLInputElement | null)?.value?.trim();
    return v || undefined;
  }
  function csv(sel: string): string[] | undefined {
    const v = str(sel);
    if (!v) return undefined;
    return v.split(",").map((s) => s.trim()).filter(Boolean);
  }
  function chk(sel: string): boolean | undefined {
    const el = drawer.root.querySelector(sel) as HTMLInputElement | null;
    return el?.checked ? true : undefined;
  }
  function readPolicy() {
    const pol: any = {};
    const minP = num(".rgm-price-min");
    if (minP !== undefined) pol.minDphTotal = minP;
    const maxP = num(".rgm-price-max");
    if (maxP !== undefined) pol.maxDphTotal = maxP;
    if (csv(".f-gpu")?.length) pol.gpuNames = csv(".f-gpu");
    if (num(".f-vram-min") !== undefined) pol.minVramGB = num(".f-vram-min");
    if (num(".f-vram-max") !== undefined) pol.maxVramGB = num(".f-vram-max");
    if (num(".f-ram-min") !== undefined) pol.minRamGB = num(".f-ram-min");
    if (num(".f-ram-max") !== undefined) pol.maxRamGB = num(".f-ram-max");
    if (num(".f-disk") !== undefined) pol.minDiskGB = num(".f-disk");
    if (num(".f-rel") !== undefined) pol.minReliability = num(".f-rel");
    if (csv(".f-geo")?.length) pol.geolocations = csv(".f-geo");
    if (num(".f-storage") !== undefined) pol.maxStorageCostPerGBMonth = num(".f-storage");
    if (num(".f-duration") !== undefined) pol.minDurationSeconds = num(".f-duration");
    if (num(".f-inetdown") !== undefined) pol.minInetDownMBs = num(".f-inetdown");
    if (num(".f-inetup") !== undefined) pol.minInetUpMBs = num(".f-inetup");
    if (num(".f-cpucores") !== undefined) pol.minCpuCores = num(".f-cpucores");
    if (num(".f-cpumhz") !== undefined) pol.minCpuMhz = num(".f-cpumhz");
    if (num(".f-ports") !== undefined) pol.minDirectPorts = num(".f-ports");
    const ver = (drawer.root.querySelector(".f-ver") as HTMLSelectElement | null)?.value;
    if (ver === "verified" || ver === "unverified" || ver === "any") pol.verification = ver === "any" ? null : ver;
    if (chk(".f-dc")) pol.datacenterOnly = true;
    if (chk(".f-static")) pol.staticIpOnly = true;
    if (!chk(".f-rented")) pol.excludeRented = false;
    return pol;
  }

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
          sStatus.dataset.tone = payload.configured ? "ok" : "unknown";
          sStatus.textContent = payload.configured ? "Vast.ai key configured (enclave)." : "No Vast.ai key saved yet.";
        }
        paintBanner(payload.configured ? "ok" : "bad", payload.configured ? "✓ Vast.ai key saved (enclave)" : "○ No Vast.ai key saved");
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
            paintBanner("ok", "✓ Vast.ai key saved (enclave)");
          } else {
            sStatus.dataset.tone = "bad";
            sStatus.textContent = `Save failed: ${payload.error ?? "unknown error"}`;
            paintBanner("bad", "○ No Vast.ai key saved");
          }
        }
        return;
      case "vast_clear_key_result":
        if (sKey) sKey.value = "";
        if (sStatus) { sStatus.dataset.tone = "bad"; sStatus.textContent = "Key cleared."; }
        paintBanner("bad", "○ No Vast.ai key saved");
        return;
      case "vast_search_offers_result": {
        const box = drawer.root.querySelector(".rgm-offers");
        if (!box) return;
        if (payload.ok) {
          if (payload.offers?.__empty && payload.offers.debug) {
            const d = payload.offers.debug;
            box.innerHTML = `<div class="rgm-status" data-tone="bad">Vast.ai returned no offers (HTTP ${escapeHtml(String(d.status))}, body ${escapeHtml(String(d.bodyLength))} bytes)</div><pre class="rgm-out">${escapeHtml(String(d.bodyPreview))}</pre>`;
          } else if (payload.offers?.length) {
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
