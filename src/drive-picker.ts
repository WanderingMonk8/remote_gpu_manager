import type { DriveFile } from "./automation";

function loadScript(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = url;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("picker_load_failed"));
    document.head.appendChild(script);
  });
}

/** Launch Google's picker with a short-lived browser token; never return that token. */
export async function chooseDriveFiles(config: { clientId: string; apiKey: string; projectNumber: string }): Promise<DriveFile[]> {
  if (!config.clientId || !config.apiKey || !/^\d+$/.test(config.projectNumber)) throw new Error("picker_config_invalid");
  const globals = window as any;
  if (!globals.gapi) await loadScript("https://apis.google.com/js/api.js");
  if (!globals.google?.accounts?.oauth2) await loadScript("https://accounts.google.com/gsi/client");
  await new Promise<void>((resolve, reject) => globals.gapi.load("picker", { callback: resolve, onerror: reject }));
  const token = await new Promise<string>((resolve, reject) => {
    const client = globals.google.accounts.oauth2.initTokenClient({
      client_id: config.clientId, scope: "https://www.googleapis.com/auth/drive.file",
      callback: (response: any) => response.access_token ? resolve(response.access_token) : reject(new Error("picker_auth_failed")),
      error_callback: () => reject(new Error("picker_auth_failed")),
    });
    client.requestAccessToken();
  });
  return new Promise((resolve, reject) => {
    const picker = globals.google.picker;
    const view = new picker.DocsView().setMode(picker.DocsViewMode.LIST);
    new picker.PickerBuilder().addView(view).enableFeature(picker.Feature.MULTISELECT_ENABLED)
      .setOAuthToken(token).setDeveloperKey(config.apiKey).setAppId(config.projectNumber)
      .setOrigin(window.location.origin)
      .setCallback((result: any) => {
        if (result.action === picker.Action.CANCEL) reject(new Error("picker_cancelled"));
        if (result.action === picker.Action.PICKED) {
          resolve((result.docs ?? []).map((item: any) => ({ id: item.id, name: item.name })));
        }
      }).build().setVisible(true);
  });
}
