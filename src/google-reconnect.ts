/** Google web OAuth reconnect. Authorization codes and credentials never reach the UI. */
type Response = { status: number; body: string };
type Pending = { user: string; clientId: string; secret: string; redirect: string; verifier: string; expires: number };
const SCOPES = ["https://www.googleapis.com/auth/colaboratory", "https://www.googleapis.com/auth/drive.file"];
const base64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export class GoogleReconnect {
  private pending = new Map<string, Pending>();
  constructor(private deps: {
    state(): Promise<string>;
    getSecret(user: string, clientId: string): Promise<string>;
    commit(user: string, clientId: string, secret: string, refreshToken: string): Promise<void>;
    request(url: string, options: any): Promise<Response>;
  }) {}

  async begin(user: string, clientId: string, suppliedSecret: string, origin: string, callbackPath: string): Promise<{ url: string; redirect: string }> {
    if (!user || typeof clientId !== "string" || !/^\d{5,}-[a-zA-Z0-9_-]+\.apps\.googleusercontent\.com$/.test(clientId)) throw new Error("google_web_client_required");
    if (typeof suppliedSecret !== "string" || suppliedSecret.length > 1024 || /[^\x21-\x7e]/.test(suppliedSecret)) throw new Error("google_web_secret_invalid");
    let base: URL;
    try { base = new URL(origin); } catch { throw new Error("google_redirect_invalid"); }
    if (base.origin !== origin || base.username || base.password || !(base.protocol === "https:" || (base.protocol === "http:" && ["localhost", "127.0.0.1"].includes(base.hostname))) || callbackPath !== "/api/spindle-oauth/remote_gpu_manager/callback") throw new Error("google_redirect_invalid");
    const secret = suppliedSecret || await this.deps.getSecret(user, clientId);
    if (!secret) throw new Error("google_web_secret_required");
    const state = await this.deps.state();
    const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
    const challenge = base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
    for (const [key, entry] of this.pending) if (entry.user === user || entry.expires < Date.now()) this.pending.delete(key);
    if (this.pending.size >= 1000) throw new Error("google_reconnect_busy");
    const redirect = base.origin + callbackPath;
    this.pending.set(state, { user, clientId, secret, redirect, verifier, expires: Date.now() + 10 * 60_000 });
    const timer = setTimeout(() => this.pending.delete(state), 10 * 60_000);
    (timer as any).unref?.();
    const params = new URLSearchParams({ client_id: clientId, redirect_uri: redirect, response_type: "code", scope: SCOPES.join(" "), access_type: "offline", prompt: "consent", state, code_challenge: challenge, code_challenge_method: "S256" });
    return { url: `https://accounts.google.com/o/oauth2/v2/auth?${params}`, redirect };
  }

  pendingUser(state: string): string | undefined {
    const entry = this.pending.get(state);
    return entry && entry.expires >= Date.now() ? entry.user : undefined;
  }

  async finish(params: Record<string, string>): Promise<string> {
    const entry = this.pending.get(params.state);
    this.pending.delete(params.state);
    if (!entry || entry.expires < Date.now()) throw new Error("google_reconnect_expired");
    if (params.error || !params.code || params.code.length > 4096) throw new Error("google_reconnect_cancelled");
    const body = new URLSearchParams({ code: params.code, client_id: entry.clientId, client_secret: entry.secret, redirect_uri: entry.redirect, code_verifier: entry.verifier, grant_type: "authorization_code" }).toString();
    let response: Response;
    try { response = await this.deps.request("https://oauth2.googleapis.com/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body }); }
    catch { throw new Error("google_reconnect_token_network"); }
    let tokens: any;
    try { tokens = JSON.parse(response.body); } catch { throw new Error("google_reconnect_exchange_failed"); }
    if (response.status !== 200) {
      if (tokens?.error === "invalid_client") throw new Error("google_reconnect_invalid_client");
      if (tokens?.error === "invalid_grant") throw new Error("google_reconnect_invalid_grant");
      throw new Error("google_reconnect_exchange_failed");
    }
    if (typeof tokens.access_token !== "string" || !tokens.access_token) throw new Error("google_reconnect_access_missing");
    if (typeof tokens.refresh_token !== "string" || !tokens.refresh_token) throw new Error("google_reconnect_refresh_missing");
    if (typeof tokens.scope !== "string" || !SCOPES.every(scope => tokens.scope.split(/\s+/).includes(scope))) throw new Error("google_reconnect_scope_missing");
    let check: Response;
    try { check = await this.deps.request("https://colaboratory.googleapis.com/v1beta/runtimespecs", { method: "GET", headers: { Authorization: `Bearer ${tokens.access_token}` } }); }
    catch { throw new Error("google_reconnect_colab_network"); }
    if (check.status !== 200) throw new Error(check.status === 401 || check.status === 403 ? "google_reconnect_colab_denied" : "google_reconnect_colab_check_failed");
    try { await this.deps.commit(entry.user, entry.clientId, entry.secret, tokens.refresh_token); }
    catch { throw new Error("google_reconnect_save_failed"); }
    return entry.user;
  }
}
