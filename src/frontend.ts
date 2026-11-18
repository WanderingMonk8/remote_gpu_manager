import type { SpindleFrontendContext } from "lumiverse-spindle-types";

const ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="1.5"/><rect x="2.5" y="9" width="2" height="6"/><rect x="19.5" y="9" width="2" height="6"/><path d="M9.5 2.5v2M12 2.5v2M14.5 2.5v2M9.5 19.5v2M12 19.5v2M14.5 19.5v2"/></svg>`;

export function setup(ctx: SpindleFrontendContext) {
  const STYLES = `
    .rgm-panel { display: grid; gap: 10px; padding: 16px; color: var(--lumiverse-text); }
    .rgm-panel h3 { margin: 0; font-size: 15px; }
    .rgm-panel p { margin: 0; color: var(--lumiverse-text-muted); font-size: 12px; line-height: 1.5; }
    .rgm-panel input { width: 100%; box-sizing: border-box; padding: 7px 9px; border: 1px solid var(--lumiverse-border); border-radius: 8px; background: var(--lumiverse-fill); color: var(--lumiverse-text); font: inherit; }
    .rgm-panel input:focus { outline: 2px solid var(--lumiverse-primary); outline-offset: 1px; }
    .rgm-actions { display: flex; gap: 8px; flex-wrap: wrap; }
    .rgm-panel button { padding: 7px 12px; border: 1px solid var(--lumiverse-border); border-radius: 8px; background: var(--lumiverse-fill-subtle); color: var(--lumiverse-text); font: inherit; font-weight: 600; cursor: pointer; }
    .rgm-panel button:hover { background: var(--lumiverse-fill); }
    .rgm-panel button.rgm-primary { border-color: var(--lumiverse-primary); color: var(--lumiverse-primary); }
    .rgm-panel button.rgm-danger { border-color: var(--lumiverse-error); color: var(--lumiverse-error); }
    .rgm-status { padding: 8px 10px; border-radius: 8px; border: 1px solid var(--lumiverse-border); font-size: 12px; font-weight: 600; white-space: pre-wrap; }
    .rgm-status[data-tone="ok"] { color: var(--lumiverse-success, #4caf50); }
    .rgm-status[data-tone="bad"] { color: var(--lumiverse-error, #e57373); }
    .rgm-status[data-tone="unknown"] { color: var(--lumiverse-text-muted); }
    .rgm-out { margin: 0; max-height: 220px; overflow: auto; white-space: pre-wrap; font-size: 11px; color: var(--lumiverse-text-muted); }
    .rgm-section h3 { font-size: 13px; text-transform: uppercase; letter-spacing: .04em; color: var(--lumiverse-text-muted); }
    .rgm-hint { font-size: 11px; color: var(--lumiverse-text-muted); }
  `;
  const removeStyle = ctx.dom.addStyle(STYLES);

  // --- Drawer panel (short status tab) ---
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
      <p>Warm-worker probe. The GPU worker is started manually from your notebook; Lumiverse never starts it.</p>
      <input class="rgm-gw-url" type="text" spellcheck="false" placeholder="Gateway URL, e.g. http://127.0.0.1:8189" />
      <div class="rgm-actions">
        <button class="rgm-save-url" type="button">Save URL</button>
        <button class="rgm-check rgm-primary" type="button">Check worker</button>
      </div>
      <div class="rgm-status" data-tone="unknown">Not checked yet.</div>
      <pre class="rgm-out"></pre>
    </div>`;

  const drawerOut = drawer.root.querySelector(".rgm-out") as HTMLPreElement | null;
  const drawerStatus = drawer.root.querySelector(".rgm-status") as HTMLDivElement | null;
  const urlInput = drawer.root.querySelector(".rgm-gw-url") as HTMLInputElement | null;

  drawer.root.querySelector(".rgm-save-url")?.addEventListener("click", () => {
    if (urlInput?.value.trim()) ctx.sendToBackend({ type: "set_gateway_url", url: urlInput.value.trim() });
  });
  drawer.root.querySelector(".rgm-check")?.addEventListener("click", () => {
    if (drawerStatus) { drawerStatus.dataset.tone = "unknown"; drawerStatus.textContent = "Probing…"; }
    ctx.sendToBackend({ type: "status" });
  });

  // --- Settings tab (Vast.ai account) ---
  let settingsHandle: { root: HTMLElement; destroy(): void } | null = null;
  try {
    settingsHandle = ctx.ui.registerSettingsTab({
      id: "remote_gpu_manager",
      title: "Remote GPU Manager",
      shortName: "GPU",
      iconSvg: ICON_SVG,
      description: "Connect Lumiverse to a Vast.ai GPU worker for remote image generation.",
      keywords: ["gpu", "vast", "comfyui", "remote", "image generation"],
      sections: [
        {
          key: "vast-account",
          titleKey: "settings.remoteGpuManager.vastAccount",
          titleFallback: "Vast.ai account",
          keywords: ["vast", "api", "key"],
        },
      ],
    });
  } catch {
    settingsHandle = null; // host may not expose settings tabs; degrade gracefully
  }

  if (settingsHandle) {
    settingsHandle.root.innerHTML = `
      <div class="rgm-panel rgm-section">
        <h3>Vast.ai account</h3>
        <p>API key for managed GPU provisioning. Stored in the Spindle Secure Enclave (AES-256-GCM, per-user). Never displayed, never logged.</p>
        <input class="rgm-vast-key" type="password" spellcheck="false" autocomplete="off" placeholder="Paste your Vast.ai API key" />
        <div class="rgm-actions">
          <button class="rgm-test-key" type="button">Test credentials</button>
          <button class="rgm-save-key rgm-primary" type="button">Save securely</button>
          <button class="rgm-clear-key rgm-danger" type="button">Clear</button>
        </div>
        <div class="rgm-status" data-tone="unknown">Checking configuration…</div>
        <p class="rgm-hint">Test performs one read-only search against console.vast.ai (limit=1). No rental or billing action occurs. Saving re-validates before persisting.</p>
      </div>`;

    const sStatus = settingsHandle.root.querySelector(".rgm-status") as HTMLDivElement | null;
    const sKey = settingsHandle.root.querySelector(".rgm-vast-key") as HTMLInputElement | null;
    const askStatus = () => ctx.sendToBackend({ type: "vast_get_status" });
    const paintStatus = (configured: boolean) => {
      if (!sStatus) return;
      sStatus.dataset.tone = configured ? "ok" : "bad";
      sStatus.textContent = configured ? "Vast.ai key configured (enclave)." : "No Vast.ai key saved yet.";
    };

    settingsHandle.root.querySelector(".rgm-test-key")?.addEventListener("click", () => {
      const key = sKey?.value.trim() ?? "";
      if (!key) { if (sStatus) { sStatus.dataset.tone = "bad"; sStatus.textContent = "Paste a key first."; } return; }
      if (sStatus) { sStatus.dataset.tone = "unknown"; sStatus.textContent = "Testing credentials against Vast.ai…"; }
      ctx.sendToBackend({ type: "vast_test_key", key });
    });
    settingsHandle.root.querySelector(".rgm-save-key")?.addEventListener("click", () => {
      const key = sKey?.value.trim() ?? "";
      if (!key) { if (sStatus) { sStatus.dataset.tone = "bad"; sStatus.textContent = "Paste a key first."; } return; }
      if (sStatus) { sStatus.dataset.tone = "unknown"; sStatus.textContent = "Validating and saving…"; }
      ctx.sendToBackend({ type: "vast_save_key", key });
    });
    settingsHandle.root.querySelector(".rgm-clear-key")?.addEventListener("click", () => {
      if (sStatus) { sStatus.dataset.tone = "unknown"; sStatus.textContent = "Clearing…"; }
      ctx.sendToBackend({ type: "vast_clear_key" });
    });
    askStatus();
  }

  const unsub = ctx.onBackendMessage((payload: any) => {
    if (payload?.type === "status" && drawerStatus && drawerOut) {
      const gwOk = payload.gateway?.ok;
      const upOk = payload.upstream?.ok;
      const hint = payload.gateway?.hint ?? payload.upstream?.hint;
      drawerStatus.dataset.tone = gwOk && upOk ? "ok" : "bad";
      drawerStatus.textContent =
        `${gwOk ? "Gateway OK" : "Gateway unreachable"} · ${upOk ? "Worker OK" : `Worker unreachable/degraded (${payload.upstream?.status ?? 0})`}` +
        (hint ? `\n${hint}` : "");
      drawerOut.textContent = JSON.stringify({ gateway: payload.gateway, upstream: payload.upstream }, null, 2);
      return;
    }
    if (payload?.type === "gateway_url_saved") {
      if (drawerStatus) { drawerStatus.dataset.tone = "unknown"; drawerStatus.textContent = `Saved: ${payload.url}`; }
      return;
    }
    if (payload?.type === "gateway_url_error") {
      if (drawerStatus) { drawerStatus.dataset.tone = "bad"; drawerStatus.textContent = `URL rejected: ${payload.error}`; }
      return;
    }
    if (!settingsHandle) return;
    const sStatus = settingsHandle.root.querySelector(".rgm-status") as HTMLDivElement | null;
    const sKey = settingsHandle.root.querySelector(".rgm-vast-key") as HTMLInputElement | null;
    if (!sStatus) return;
    switch (payload?.type) {
      case "vast_get_status_result":
        sStatus.dataset.tone = payload.configured ? "ok" : "bad";
        sStatus.textContent = payload.configured ? "Vast.ai key configured (enclave)." : "No Vast.ai key saved yet.";
        break;
      case "vast_test_key_result":
        sStatus.dataset.tone = payload.ok ? "ok" : "bad";
        sStatus.textContent = payload.ok
          ? `Credentials accepted (HTTP ${payload.status}).`
          : `Rejected (HTTP ${payload.status}) — check the key and try again.`;
        break;
      case "vast_save_key_result":
        if (payload.ok) {
          if (sKey) sKey.value = "";
          sStatus.dataset.tone = "ok";
          sStatus.textContent = "Key saved to the Secure Enclave (validated).";
        } else {
          sStatus.dataset.tone = "bad";
          sStatus.textContent = `Save failed: ${payload.error ?? "unknown error"}`;
        }
        break;
      case "vast_clear_key_result":
        if (sKey) sKey.value = "";
        sStatus.dataset.tone = "bad";
        sStatus.textContent = "Key cleared.";
        break;
    }
  });

  return () => {
    unsub();
    removeStyle();
    drawer.destroy();
    settingsHandle?.destroy();
  };
}
