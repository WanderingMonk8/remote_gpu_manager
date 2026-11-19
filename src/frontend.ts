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
    .rgm-note { margin: 0; font-size: 11px; color: var(--lumiverse-text-muted); }
    .rgm-offer-row { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
    .rgm-offer button, .rgm-inst button { font-size: 11px; padding: 4px 10px; border-radius: 6px; border: 1px solid var(--lumiverse-border); background: transparent; color: var(--lumiverse-text); cursor: pointer; }
    .rgm-offer button.rgm-deploy-offer { border-color: var(--lumiverse-primary); color: var(--lumiverse-primary); font-weight: 700; }
    .rgm-deploy { border: 1px solid var(--lumiverse-error); border-radius: 10px; padding: 10px 12px; display: grid; gap: 8px; background: color-mix(in srgb, var(--lumiverse-error) 6%, transparent); }
    .rgm-deploy h5 { margin: 0; font-size: 12px; }
    .rgm-deploy-terms { font-size: 12px; color: var(--lumiverse-text); padding: 6px 8px; border: 1px dashed var(--lumiverse-border); border-radius: 6px; }
    .rgm-deploy-go[disabled] { opacity: 0.4; cursor: not-allowed; }
    .rgm-inst-list { display: grid; gap: 8px; }
    .rgm-inst { border: 1px solid var(--lumiverse-border); border-radius: 10px; padding: 9px 11px; display: grid; gap: 6px; }
    .rgm-inst b { font-size: 12px; }
    .rgm-inst span { font-size: 11px; color: var(--lumiverse-text-muted); }
    .rgm-inst button.rgm-destroy-armed { border-color: var(--lumiverse-error); background: var(--lumiverse-error); color: #fff; font-weight: 700; }
    .rgm-fallback-pct-wrap { display: inline-flex; align-items: center; gap: 6px; }
    .rgm-fallback-pct-wrap input { width: 56px; padding: 4px 6px; border: 1px solid var(--lumiverse-border); border-radius: 6px; background: var(--lumiverse-fill); color: var(--lumiverse-text); font: inherit; font-size: 12px; }
    .rgm-deploy-existing { border: 1px solid var(--lumiverse-error); border-radius: 8px; padding: 8px 10px; display: grid; gap: 4px; }
    .rgm-deploy-existing .rgm-note { color: var(--lumiverse-error); }
    .rgm-deploy-existing .rgm-check { padding-top: 0; }
    .rgm-limit-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 12px; color: var(--lumiverse-text); }
    .rgm-limit-row input { width: 64px; padding: 4px 6px; border: 1px solid var(--lumiverse-border); border-radius: 6px; background: var(--lumiverse-fill); color: var(--lumiverse-text); font: inherit; }
    .rgm-limit-note { font-size: 11px; color: var(--lumiverse-text-muted); flex-basis: 100%; }
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
            <label class="rgm-field"><span>GPU names (CSV — e.g. RTX 3090, RTX 4090)</span><input class="f-gpu" type="text" value="RTX 3090, RTX 4090" placeholder="RTX 3090, RTX 4090" /></label>
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
            <label class="rgm-check"><input class="f-dc" type="checkbox" /><span>Datacenter only (internal hosts)</span></label>
            <label class="rgm-check"><input class="f-static" type="checkbox" /><span>Static IP only</span></label>
            <label class="rgm-check"><input class="f-rented" type="checkbox" checked /><span>Exclude rented</span></label>
            <label class="rgm-check"><input class="f-vff" type="checkbox" /><span>Rentable machines only</span></label>
            <label class="rgm-check"><input class="f-ext" type="checkbox" /><span>Verified hosts only</span></label>
          </div>
        </div>
        <div class="rgm-offers"></div>
        <div class="rgm-note rgm-search-age" hidden></div>
        <div class="rgm-deploy" hidden>
          <h5>Deploy offer <span class="rgm-deploy-id"></span></h5>
          <p class="rgm-note">Rents a real machine, billed by the hour until you stop or destroy it. No model is downloaded — this first deploy only proves the create → inspect → stop → destroy lifecycle and billing.</p>
          <label class="rgm-field"><span>Image</span><input class="rgm-deploy-image" type="text" spellcheck="false" value="yanwk/comfyui-boot:cu126-slim" /></label>
          <label class="rgm-field"><span>Boot profile</span>
            <select class="rgm-deploy-profile">
              <option value="lifecycle" selected>Lifecycle proof only (no downloads)</option>
              <option value="full">Full worker — Anima + MOSS (≈28 GB)</option>
            </select>
          </label>
          <label class="rgm-check"><input class="rgm-deploy-fallback" type="checkbox" /><span>If this offer is taken, auto-deploy a similar one within</span>
            <span class="rgm-fallback-pct-wrap"><input class="rgm-deploy-fallback-pct" type="number" value="15" min="5" max="50" step="1" />% of its price</span>
          </label>
          <div class="rgm-deploy-existing" hidden>
            <p class="rgm-note"><b>⚠ You own <span class="rgm-existing-count">0</span> of your max <span class="rgm-existing-limit">1</span> instance(s):</b> <span class="rgm-existing-list"></span></p>
            <p class="rgm-note">Deploying more is refused at your limit. Destroy one — raise Max concurrent instances — or tick the override to deploy above it just this once.</p>
            <label class="rgm-check"><input class="rgm-deploy-override" type="checkbox" /><span>I understand — deploy another instance anyway</span></label>
          </div>
          <div class="rgm-filter-grid">
            <label class="rgm-field"><span>Disk (GB)</span><input class="rgm-deploy-disk" type="number" value="100" min="8" max="200" step="1" /></label>
            <label class="rgm-field"><span>Max price ($/hr)</span><input class="rgm-deploy-cap" type="number" value="0.25" min="0.01" max="2" step="0.01" /></label>
          </div>
          <div class="rgm-deploy-terms">Offer <b class="rgm-deploy-summary"></b> · your cap: <b class="rgm-deploy-cap-echo"></b></div>
          <label class="rgm-check"><input class="rgm-deploy-approve" type="checkbox" /><span class="rgm-approve-label">I approve renting this machine at the displayed price. Billing starts immediately and continues until I stop or destroy it.</span></label>
          <div class="rgm-actions">
            <button class="rgm-deploy-go rgm-danger" type="button" disabled>Deploy — start billing</button>
            <button class="rgm-deploy-cancel" type="button">Cancel</button>
          </div>
          <div class="rgm-status" data-tone="unknown" id="rgm-deploy-status">Review the terms, tick the approval, then Deploy.</div>
        </div>
      </section>

      <hr class="rgm-section-divider" />

      <section>
        <h4>My instances</h4>
        <p class="rgm-note">Machines you have rented from this Vast.ai account. State shows raw Vast tokens (<code>actual → intended</code>); Vast's console renders <code>created</code>/<code>loading</code> as <b>Inactive</b>. <b>Stop</b> pauses GPU billing (disk storage continues to accrue). <b>Destroy</b> permanently deletes the instance and its disk — this cannot be undone. If the vast console shows <i>“Error response from daemon”</i>, the host cannot inject the GPU into containers — destroy the instance and deploy a different offer.</p>
        <div class="rgm-limit-row">
          <span>Max concurrent instances</span>
          <input class="rgm-limit-input" type="number" min="1" max="8" value="1" />
          <button class="rgm-limit-save rgm-primary" type="button">Save limit</button>
          <button class="rgm-clear-blacklist" type="button">Clear blocked hosts (<span class="rgm-blacklist-count">0</span>)</button>
          <span class="rgm-limit-note">Deploys are refused above the limit. Default 1 — raise only if you intentionally run more; each bills per hour. Blocked hosts never appear as fallback-race candidates.</span>
        </div>
        <div class="rgm-actions">
          <button class="rgm-refresh-inst rgm-primary" type="button">Refresh</button>
        </div>
        <div class="rgm-status" data-tone="unknown" id="rgm-inst-status">Loading…</div>
        <div class="rgm-inst-list"></div>
        <pre class="rgm-out rgm-logs" hidden></pre>
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
  // ---------- Deploy flow (paid action — explicit user approval required) ----------
  let lastSearchAt: number | null = null;
  const searchAge = drawer.root.querySelector(".rgm-search-age") as HTMLDivElement | null;
  const offerAgeMinutes = () => (lastSearchAt == null ? null : Math.floor((Date.now() - lastSearchAt) / 60000));
  const DEPLOY_ONSTART_FULL = `python3 -c "import urllib.request;exec(urllib.request.urlopen('https://raw.githubusercontent.com/WanderingMonk8/remote_gpu_manager/feat/vast-first/worker/bootstrap.py').read())"`;
  let deployTarget: { id: number; dph: number; gpu: string; vramGB: string; gpus: number; machineId: number } | null = null;
  const deployProfile = drawer.root.querySelector(".rgm-deploy-profile") as HTMLSelectElement | null;
  const deployNote = drawer.root.querySelector(".rgm-deploy > .rgm-note") as HTMLParagraphElement | null;
  const NOTE_LIFECYCLE = "Rents a real machine, billed by the hour until you stop or destroy it. No model is downloaded — this first deploy only proves the create → inspect → stop → destroy lifecycle and billing.";
  const NOTE_FULL = "Rents a real machine, billed by the hour. On first boot the bootstrap downloads ≈28 GB (Anima Turbo/Aesthetic v1.1, MOSS INT8 ×2, encoders, Anima ref-adapter). ComfyUI stays up; generate only after the Logs show BOOTSTRAP_COMPLETE. The disk keeps all weights across stop/start (storage cost continues while stopped).";
  const deployFallback = drawer.root.querySelector(".rgm-deploy-fallback") as HTMLInputElement | null;
  const deployFallbackPct = drawer.root.querySelector(".rgm-deploy-fallback-pct") as HTMLInputElement | null;
  const deployExisting = drawer.root.querySelector(".rgm-deploy-existing") as HTMLDivElement | null;
  const deployExistingCount = drawer.root.querySelector(".rgm-existing-count") as HTMLSpanElement | null;
  const deployExistingLimit = drawer.root.querySelector(".rgm-existing-limit") as HTMLSpanElement | null;
  const deployExistingList = drawer.root.querySelector(".rgm-existing-list") as HTMLSpanElement | null;
  const deployOverride = drawer.root.querySelector(".rgm-deploy-override") as HTMLInputElement | null;
  let lastInstances: any[] = [];
  let maxInstances = 1;
  let blockedMachineIds = new Set<number>();
  const askLimits = () => ctx.sendToBackend({ type: "vast_get_limits" });
  const askFailedHosts = () => ctx.sendToBackend({ type: "vast_list_failed_hosts" });
  const limitInput = drawer.root.querySelector(".rgm-limit-input") as HTMLInputElement | null;
  const blacklistCount = drawer.root.querySelector(".rgm-blacklist-count") as HTMLSpanElement | null;
  drawer.root.querySelector(".rgm-clear-blacklist")?.addEventListener("click", () => {
    ctx.sendToBackend({ type: "vast_clear_failed_hosts" });
  });
  drawer.root.querySelector(".rgm-limit-save")?.addEventListener("click", () => {
    const n = Math.floor(Number(limitInput?.value ?? 1));
    if (!Number.isFinite(n) || n < 1 || n > 8) return;
    ctx.sendToBackend({ type: "vast_set_limits", maxInstances: n });
  });
  const approveLabel = drawer.root.querySelector(".rgm-approve-label") as HTMLSpanElement | null;
  const fallbackCeiling = () => {
    const pct = Math.min(50, Math.max(1, Number(deployFallbackPct?.value) || 15));
    return deployTarget ? deployTarget.dph * (1 + pct / 100) : 0;
  };
  const deployPanel = drawer.root.querySelector(".rgm-deploy") as HTMLDivElement | null;
  const deployImage = drawer.root.querySelector(".rgm-deploy-image") as HTMLInputElement | null;
  const deployDisk = drawer.root.querySelector(".rgm-deploy-disk") as HTMLInputElement | null;
  const deployCap = drawer.root.querySelector(".rgm-deploy-cap") as HTMLInputElement | null;
  const deployApprove = drawer.root.querySelector(".rgm-deploy-approve") as HTMLInputElement | null;
  const deployGo = drawer.root.querySelector(".rgm-deploy-go") as HTMLButtonElement | null;
  const deployId = drawer.root.querySelector(".rgm-deploy-id") as HTMLSpanElement | null;
  const deploySummary = drawer.root.querySelector(".rgm-deploy-summary") as HTMLElement | null;
  const deployCapEcho = drawer.root.querySelector(".rgm-deploy-cap-echo") as HTMLElement | null;
  const deployStatus = drawer.root.querySelector("#rgm-deploy-status") as HTMLDivElement | null;

  const imagePattern = /^[a-z0-9]+([._-][a-z0-9]+)*(\/[a-z0-9]+([._-][a-z0-9]+)*)*(:[A-Za-z0-9][A-Za-z0-9._-]{0,127})?$/;
  const paintDeploy = () => {
    if (!deployPanel) return;
    if (deployNote) deployNote.textContent = deployProfile?.value === "full" ? NOTE_FULL : NOTE_LIFECYCLE;
    const cap = Number(deployCap?.value ?? 0);
    if (deploySummary && deployTarget) {
      const fbOn = deployFallback?.checked === true;
      const ceil = fallbackCeiling();
      deploySummary.textContent = `#${deployTarget.id} · ${deployTarget.gpu} × ${deployTarget.gpus} · $${deployTarget.dph.toFixed(3)}/hr · ${deployTarget.vramGB} GiB${fbOn ? ` · fallback ≤ ${Math.min(50, Math.max(1, Number(deployFallbackPct?.value) || 15))}% (≤$${ceil.toFixed(3)}/hr)` : ""}`;
      if (approveLabel) {
        approveLabel.textContent = fbOn
          ? `I approve renting this machine — or a similar offer within +${Math.min(50, Math.max(1, Number(deployFallbackPct?.value) || 15))}% of its price (up to $${ceil.toFixed(3)}/hr) if it's taken. Billing starts immediately and continues until I stop or destroy it.`
          : "I approve renting this machine at the displayed price. Billing starts immediately and continues until I stop or destroy it.";
      }
    }
    if (deployCapEcho) deployCapEcho.textContent = Number.isFinite(cap) ? `$${cap.toFixed(2)}/hr` : "-";
    const diskGB = Number(deployDisk?.value ?? 0);
    const overCap = !!deployTarget && Number.isFinite(cap) && deployTarget.dph > cap;
    const imageOk = imagePattern.test((deployImage?.value ?? "").trim());
    const ownedCount = lastInstances.length;
    const ownershipOk = ownedCount < maxInstances || deployOverride?.checked === true;
    // Reflect the ownership interstitial
    if (deployExisting) {
      if (ownedCount >= maxInstances) {
        deployExisting.removeAttribute("hidden");
        if (deployExistingCount) deployExistingCount.textContent = String(ownedCount);
        if (deployExistingLimit) deployExistingLimit.textContent = String(maxInstances);
        if (deployExistingList) deployExistingList.textContent = lastInstances.map((i) => `#${i.id} (${i.status})`).join(", ");
      } else {
        deployExisting.setAttribute("hidden", "");
        if (deployOverride) deployOverride.checked = false;
      }
    }
    const ready = !!deployTarget && deployApprove?.checked === true && imageOk
      && Number.isFinite(diskGB) && diskGB >= 8 && diskGB <= 200 && !overCap && ownershipOk;
    if (deployGo) deployGo.disabled = !ready;
    if (deployStatus) {
      // Never overwrite a terminal message (Deploying… / result / error) with the benign hint.
      const cur = deployStatus.textContent ?? "";
      const benign = cur === "" || cur.startsWith("Review the terms") || cur.startsWith("Approved") || overCap;
      if (overCap) { deployStatus.dataset.tone = "bad"; deployStatus.textContent = `Offer price $${deployTarget?.dph.toFixed(3)}/hr exceeds your $${cap.toFixed(2)}/hr cap.`; }
      else if (!ownershipOk) { deployStatus.dataset.tone = "bad"; deployStatus.textContent = `You own ${ownedCount} instance(s) at your limit of ${maxInstances} — destroy one, raise Max concurrent instances, or tick the override to deploy above it.`; }
      else if (ready && benign) { deployStatus.dataset.tone = "unknown"; deployStatus.textContent = "Approved to deploy. Clicking starts billing immediately."; }
    }
  };
  const openDeploy = (target: { id: number; dph: number; gpu: string; vramGB: string; gpus: number; machineId: number }) => {
    deployTarget = target;
    const age = offerAgeMinutes();
    const stale = age != null && age >= 3;
    const blacklisted = target.machineId > 0 && blockedMachineIds.has(target.machineId);
    if (deployApprove) deployApprove.checked = false;
    if (deployOverride) deployOverride.checked = false;
    if (deployId) deployId.textContent = `#${target.id}`;
    if (deployStatus) {
      deployStatus.dataset.tone = (stale || blacklisted) ? "bad" : "unknown";
      deployStatus.textContent = blacklisted
        ? `⚠ Host m${target.machineId} is on your blocklist — this exact machine just burned you. Pick a different offer.`
        : stale ? `These offers are ~${age} min old — this one may already be gone. Re-search and deploy instantly.` : "Review the terms, tick the approval, then Deploy.";
    }
    paintDeploy();
    if (deployPanel) { deployPanel.removeAttribute("hidden"); deployPanel.scrollIntoView({ behavior: "smooth", block: "nearest" }); }
  };
  const closeDeploy = () => { deployTarget = null; deployPanel?.setAttribute("hidden", ""); };

  drawer.root.querySelector(".rgm-offers")?.addEventListener("click", (ev) => {
    const btn = (ev.target as HTMLElement)?.closest?.(".rgm-deploy-offer") as HTMLButtonElement | null;
    if (!btn) return;
    openDeploy({
      id: Number(btn.dataset.id ?? 0),
      dph: Number(btn.dataset.dph ?? 0),
      gpu: btn.dataset.gpu ?? "?",
      vramGB: btn.dataset.vram ?? "?",
      gpus: Number(btn.dataset.gpus ?? 1) || 1,
      machineId: Number(btn.dataset.machine ?? 0) || 0,
    });
  });
  for (const el of [deployImage, deployDisk, deployCap, deployFallback, deployFallbackPct]) el?.addEventListener("input", paintDeploy);
  deployApprove?.addEventListener("change", paintDeploy);
  deployFallback?.addEventListener("change", paintDeploy);
  deployOverride?.addEventListener("change", paintDeploy);
  deployProfile?.addEventListener("change", () => {
    if (deployProfile.value === "full" && deployDisk && deployDisk.value === "100") deployDisk.value = "60"; // slim manifest now
    paintDeploy();
  });
  drawer.root.querySelector(".rgm-deploy-cancel")?.addEventListener("click", closeDeploy);
  deployGo?.addEventListener("click", () => {
    if (!deployTarget || deployApprove?.checked !== true) return;
    if (deployStatus) { deployStatus.dataset.tone = "unknown"; deployStatus.textContent = "Deploying — waiting for Vast.ai…"; }
    if (deployGo) deployGo.disabled = true;
    ctx.sendToBackend({
      type: "vast_deploy_offer",
      offerId: deployTarget.id,
      image: (deployImage?.value ?? "").trim(),
      diskGB: Number(deployDisk?.value ?? 60),
      maxPricePerHour: Number(deployCap?.value ?? 0.25),
      label: "lumiverse-remote-gpu",
      approved: true,
      allowMultiple: deployOverride?.checked === true,
      onstart: deployProfile?.value === "full" ? DEPLOY_ONSTART_FULL : undefined,
      target: {
        gpuName: deployTarget.gpu,
        numGpus: deployTarget.gpus,
        vramGB: Number(deployTarget.vramGB) || 24,
        dphTotal: deployTarget.dph,
      },
      fallback: {
        enabled: deployFallback?.checked === true,
        fluctuationPct: Math.min(50, Math.max(5, Number(deployFallbackPct?.value) || 15)),
        policy: readPolicy(),
      },
    });
  });

  // ---------- My instances (list / start / stop / destroy) ----------
  let armedDestroyId: number | null = null;
  const instStatus = drawer.root.querySelector("#rgm-inst-status") as HTMLDivElement | null;
  const instList = drawer.root.querySelector(".rgm-inst-list") as HTMLDivElement | null;
  const logsOut = drawer.root.querySelector(".rgm-logs") as HTMLPreElement | null;
  const askInstances = () => ctx.sendToBackend({ type: "vast_list_instances" });
  const fmtUptime = (mins: number | null) => {
    if (mins == null) return "—";
    const d = Math.floor(mins / 1440), h = Math.floor((mins % 1440) / 60), m = Math.floor(mins % 60);
    return d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m`;
  };
  const renderInstances = (instances: any[]) => {
    lastInstances = instances;
    if (!instList) return;
    if (!instances.length) { instList.innerHTML = '<div class="rgm-status" data-tone="unknown">No instances in this Vast.ai account.</div>'; return; }
    instList.innerHTML = instances.map((i: any) => {
      const st = String(i.status ?? "unknown");
      const intended = String(i.intendedStatus ?? "");
      // Vast's console shows this phase as "Inactive" — show the raw tokens, don't pretend a mapping exists.
      const stateText = intended && intended !== st ? `${st} → ${intended}` : st;
      const title = `actual_status=${st}${intended ? `, intended_status=${intended}` : ""}`;
      const canStop = /^(running|loading|starting|created|queued|provisioning)$/i.test(st);
      const canStart = /^(created|stopped|exited|unknown|offline)$/i.test(st); // both buttons during transitional states
      const armed = armedDestroyId === i.id;
      return `<div class="rgm-inst" data-id="${i.id}">
        <div class="rgm-offer-row">
          <div><b>#${i.id}</b> · ${escapeHtml(String(i.gpuName ?? "GPU ?"))} × ${i.gpuCount ?? 1} · <span class="rgm-inst-state" title="${escapeHtml(title)}">${escapeHtml(stateText)}</span></div>
          <div class="rgm-actions">
            ${canStart ? '<button class="rgm-inst-start" type="button">Start</button>' : ""}
            ${canStop ? '<button class="rgm-inst-stop" type="button">Stop</button>' : ""}
            <button class="rgm-inst-logs" type="button">Logs</button>
            <button class="rgm-inst-block" type="button" data-machine="${i.machineId ?? ""}">Block host</button>
            <button class="rgm-inst-destroy${armed ? " rgm-destroy-armed" : ""}" type="button">${armed ? "Confirm destroy" : "Destroy"}</button>
          </div>
        </div>
        <span>${i.dphTotal != null ? `$${Number(i.dphTotal).toFixed(3)}/hr · ` : ""}up ${fmtUptime(i.uptimeMins ?? null)} · machine ${escapeHtml(String(i.machineId ?? "?"))}${i.label ? ` · ${escapeHtml(String(i.label))}` : ""}${i.geolocation ? ` · ${escapeHtml(String(i.geolocation))}` : ""}</span>
      </div>`;
    }).join("");
  };

  drawer.root.querySelector(".rgm-refresh-inst")?.addEventListener("click", () => {
    if (instStatus) { instStatus.dataset.tone = "unknown"; instStatus.textContent = "Refreshing…"; }
    askInstances();
  });
  instList?.addEventListener("click", (ev) => {
    const el = ev.target as HTMLElement;
    const row = el.closest?.(".rgm-inst") as HTMLElement | null;
    const id = Number(row?.dataset.id ?? 0);
    if (!id) return;
    if (el.closest?.(".rgm-inst-start")) { armedDestroyId = null; ctx.sendToBackend({ type: "vast_instance_action", id, action: "start" }); return; }
    if (el.closest?.(".rgm-inst-stop")) { armedDestroyId = null; ctx.sendToBackend({ type: "vast_instance_action", id, action: "stop" }); return; }
    if (el.closest?.(".rgm-inst-logs")) {
      armedDestroyId = null;
      if (instStatus) { instStatus.dataset.tone = "unknown"; instStatus.textContent = `Requesting logs for #${id}… (can take ~20–30s)`; }
      ctx.sendToBackend({ type: "vast_logs_instance", id });
      return;
    }
    const blockBtn = el.closest?.(".rgm-inst-block") as HTMLButtonElement | null;
    if (blockBtn) {
      armedDestroyId = null;
      const machine = Number(blockBtn.dataset.machine ?? 0);
      if (instStatus) { instStatus.dataset.tone = "unknown"; instStatus.textContent = `Blocking host m${machine}…`; }
      ctx.sendToBackend({ type: "vast_blacklist_host", machineId: machine });
      return;
    }
    if (el.closest?.(".rgm-inst-destroy")) {
      if (armedDestroyId === id) {
        armedDestroyId = null;
        if (instStatus) { instStatus.dataset.tone = "unknown"; instStatus.textContent = `Destroying #${id}…`; }
        ctx.sendToBackend({ type: "vast_destroy_instance", id, approved: true });
      } else {
        armedDestroyId = id;
        askInstances(); // re-render with the armed state
      }
    }
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
    if (chk(".f-dc")) pol.exclusiveExternalOnly = true;
    if (chk(".f-static")) pol.staticIpOnly = true;
    pol.excludeRented = !!chk(".f-rented");
    if (chk(".f-vff")) pol.rentableOnly = true;
    if (chk(".f-ext")) pol.verifiedOnly = true;
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
      case "vast_get_limits_result":
        if (payload.ok) {
          maxInstances = Math.min(8, Math.max(1, Number(payload.maxInstances) || 1));
          if (limitInput) limitInput.value = String(maxInstances);
          paintDeploy();
        }
        return;
      case "vast_set_limits_result":
        if (instStatus) {
          instStatus.dataset.tone = payload.ok ? "ok" : "bad";
          instStatus.textContent = payload.ok ? `Limit saved: max ${payload.maxInstances} concurrent instance(s).` : `Limit not saved: ${payload.error ?? "unknown error"}`;
        }
        if (payload.ok) { maxInstances = Math.min(8, Math.max(1, Number(payload.maxInstances) || 1)); if (limitInput) limitInput.value = String(maxInstances); }
        paintDeploy();
        return;
      case "vast_blacklist_host_result":
        if (payload.ok) {
          const mid = Number(payload.machineId) || 0;
          if (mid > 0) blockedMachineIds.add(mid);
          if (blacklistCount) blacklistCount.textContent = String(payload.count ?? blockedMachineIds.size);
          if (instStatus) { instStatus.dataset.tone = "ok"; instStatus.textContent = `Host m${mid} blocked — the deploy race will never land there again.`; }
        } else if (instStatus) {
          instStatus.dataset.tone = "bad";
          instStatus.textContent = `Could not block host: ${payload.error ?? "unknown error"}`;
        }
        return;
      case "vast_list_failed_hosts_result":
        blockedMachineIds = new Set((payload.hosts ?? []).map(Number).filter((n: number) => n > 0));
        if (blacklistCount) blacklistCount.textContent = String(blockedMachineIds.size);
        return;
      case "vast_clear_failed_hosts_result":
        blockedMachineIds = new Set();
        if (blacklistCount) blacklistCount.textContent = "0";
        if (instStatus) { instStatus.dataset.tone = "ok"; instStatus.textContent = "Host blocklist cleared."; }
        return;
      case "vast_list_instances_result": {
        if (payload.ok) {
          renderInstances(payload.instances ?? []);
          if (instStatus) { instStatus.dataset.tone = "ok"; instStatus.textContent = `${(payload.instances ?? []).length} instance(s) — last refresh just now.`; }
        } else {
          if (instStatus) { instStatus.dataset.tone = "bad"; instStatus.textContent = `Could not list instances: ${payload.error ?? "unknown error"}`; }
        }
        return;
      }
      case "vast_instance_action_result":
        if (instStatus) {
          instStatus.dataset.tone = payload.ok ? "ok" : "bad";
          instStatus.textContent = payload.ok
            ? `#${payload.id} — ${payload.action === "start" ? "start" : "stop"} request accepted by Vast.ai (state change is not instant; hit Refresh in a moment).`
            : `#${payload.id} ${payload.action} failed: ${payload.error ?? "unknown error"}`;
        }
        askInstances();
        return;
      case "vast_destroy_instance_result":
        if (payload.ok) { if (logsOut) { logsOut.setAttribute("hidden", ""); logsOut.textContent = ""; } armedDestroyId = null; }
        if (instStatus) {
          instStatus.dataset.tone = payload.ok ? "ok" : "bad";
          instStatus.textContent = payload.ok
            ? `#${payload.id} destroyed. Billing for compute stops; the disk is deleted too.`
            : `#${payload.id} destroy failed: ${payload.error ?? "unknown error"}`;
        }
        askInstances();
        return;
      case "vast_logs_instance_result": {
        if (payload.ok) {
          if (logsOut) { logsOut.removeAttribute("hidden"); logsOut.textContent = String(payload.text ?? ""); logsOut.scrollIntoView({ behavior: "smooth", block: "nearest" }); }
          if (instStatus) { instStatus.dataset.tone = "ok"; instStatus.textContent = `Logs for #${payload.id} — look for BOOTSTRAP_COMPLETE / BOOTSTRAP_FAILED near the end.`; }
        } else {
          if (instStatus) { instStatus.dataset.tone = "bad"; instStatus.textContent = `Logs for #${payload.id}: ${payload.error ?? "failed"}`; }
        }
        return;
      }
      case "vast_deploy_offer_result": {
        if (payload.ok) {
          const via = payload.reconciled
            ? `Create response was ambiguous — but found instance #${payload.instanceId ?? "?"} on your account (no second deploy fired). Verify it in My instances; destroy it if you didn't intend this.`
            : payload.fallbackUsed
              ? `Offer #${payload.offerId} was taken — deployed #${payload.deployedOfferId}${payload.dphTotal != null ? ` at $${Number(payload.dphTotal).toFixed(3)}/hr` : ""} in ${payload.attempts ?? "?"} attempt(s)`
              : `Instance #${payload.instanceId ?? "?"} is booting`;
          if (instStatus) { instStatus.dataset.tone = "ok"; instStatus.textContent = `${via}. Refresh My instances — transitions take ~30–60s.`; }
          closeDeploy();
          askInstances();
        } else {
          const errText = String(payload.error ?? "unknown error");
          const gone = /no_such_ask|3603|instance type by id|not available|no longer available/i.test(errText);
          if (deployStatus) {
            deployStatus.dataset.tone = "bad";
            deployStatus.textContent = `Deploy failed: ${errText}${gone ? " — the offer was taken (they vanish in seconds). Hit Find offers and deploy immediately from the fresh list." : ""}`;
          }
          if (deployGo) deployGo.disabled = false;
          paintDeploy();
        }
        return;
      }
      case "vast_search_offers_result": {
        const box = drawer.root.querySelector(".rgm-offers");
        if (!box) return;
        if (payload.ok) {
          lastSearchAt = Date.now();
          if (searchAge) { searchAge.removeAttribute("hidden"); searchAge.textContent = "List rendered just now — cheap verified offers vanish fast; deploy within seconds or re-search."; }
          if (payload.offers?.__empty && payload.offers.debug) {
            const d = payload.offers.debug;
            box.innerHTML = `<div class="rgm-status" data-tone="bad">Vast.ai returned no offers (HTTP ${escapeHtml(String(d.status))}, body ${escapeHtml(String(d.bodyLength))} bytes)</div><pre class="rgm-out">${escapeHtml(JSON.stringify(d.requestBody, null, 2))}</pre>`;
          } else if (payload.offers?.length) {
            box.innerHTML = payload.offers.map((o: any) => `
              <div class="rgm-offer">
                <div class="rgm-offer-row">
                  <div><b>Offer #${o.id}</b> · ${String(o.gpuName ?? "")} × ${o.gpuCount ?? 1} · ${((o.vramMB ?? 0) / 1024).toFixed(1)} GiB</div>
                  <button class="rgm-deploy-offer" type="button" data-id="${o.id}" data-dph="${Number(o.dphTotal ?? 0)}" data-gpu="${escapeHtml(String(o.gpuName ?? ""))}" data-vram="${((o.vramMB ?? 0) / 1024).toFixed(1)}" data-gpus="${o.gpuCount ?? 1}" data-machine="${o.machineId ?? ""}">Deploy</button>
                </div>
                <span>${((o.ramMB ?? 0) / 1024).toFixed(0)} GB RAM · ${o.diskGB} GB disk · ${String(o.geolocation ?? "-")} · reliability ${(o.reliability ?? 0).toFixed(3)} · host ${escapeHtml(String(o.hostId ?? "?"))}/m${escapeHtml(String(o.machineId ?? "?"))}${o.isVmDeverified ? ` · <span style="color: var(--lumiverse-error); font-weight: 700">⚠ VM deverified</span>` : o.verification ? ` · ${escapeHtml(String(o.verification))}` : ""}</span>
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
  askInstances();
  askLimits();
  askFailedHosts();

  return () => {
    unsub();
    removeStyle();
    drawer.destroy();
  };
}
