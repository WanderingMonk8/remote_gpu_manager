import { describe, expect, test } from "bun:test";
import { GoogleReconnect } from "../src/google-reconnect";

const client = "123456789012-abcdef.apps.googleusercontent.com";
const callback = "/api/spindle-oauth/remote_gpu_manager/callback";
const scopes = "https://www.googleapis.com/auth/colaboratory https://www.googleapis.com/auth/drive.file";

describe("Google reconnect", () => {
  test("binds a one-use PKCE authorization to its user and commits only after Colab succeeds", async () => {
    const writes: any[] = [], requests: any[] = [];
    const flow = new GoogleReconnect({ state: async () => "state-one", getSecret: async () => "", commit: async (...values) => { writes.push(values); },
      request: async (url, options) => { requests.push({ url, options }); return url.includes("oauth2.googleapis.com")
        ? { status: 200, body: JSON.stringify({ access_token: "access", refresh_token: "refresh", scope: scopes }) }
        : { status: 200, body: "{}" }; } });
    const begin = await flow.begin("alice", client, "web-secret", "https://app.example", callback);
    const url = new URL(begin.url);
    expect(url.searchParams.get("state")).toBe("state-one");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(begin.url).not.toContain("web-secret");
    expect(await flow.finish({ state: "state-one", code: "code" })).toBe("alice");
    const verifier = new URLSearchParams(requests[0].options.body).get("code_verifier")!;
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
    const challenge = btoa(String.fromCharCode(...digest)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    expect(url.searchParams.get("code_challenge")).toBe(challenge);
    expect(writes).toEqual([["alice", client, "web-secret", "refresh"]]);
    expect(requests[1].url).toBe("https://colaboratory.googleapis.com/v1beta/runtimespecs");
    await expect(flow.finish({ state: "state-one", code: "code" })).rejects.toThrow("google_reconnect_expired");
  });
  test("keeps old credentials when scopes are missing, consent is denied, or Colab rejects access", async () => {
    let state = 0, status = 200, scope = scopes;
    const writes: any[] = [];
    const flow = new GoogleReconnect({ state: async () => `s${++state}`, getSecret: async () => "saved-secret", commit: async (...x) => { writes.push(x); },
      request: async url => url.includes("oauth2.googleapis.com") ? { status: 200, body: JSON.stringify({ access_token: "access", refresh_token: "refresh", scope }) } : { status, body: "{}" } });
    await flow.begin("alice", client, "", "https://app.example", callback);
    await expect(flow.finish({ state: "s1", error: "access_denied" })).rejects.toThrow("google_reconnect_cancelled");
    scope = scopes.split(" ")[0]; await flow.begin("alice", client, "", "https://app.example", callback);
    await expect(flow.finish({ state: "s2", code: "code" })).rejects.toThrow("google_reconnect_scope_missing");
    scope = scopes; status = 403; await flow.begin("alice", client, "", "https://app.example", callback);
    await expect(flow.finish({ state: "s3", code: "code" })).rejects.toThrow("google_reconnect_colab_denied");
    expect(writes).toEqual([]);
    await expect(flow.begin("alice", client, "", "https://app.example/evil", callback)).rejects.toThrow("google_redirect_invalid");
  });
  test("reports a rejected web client without exposing Google's error details", async () => {
    const flow = new GoogleReconnect({ state: async () => "state", getSecret: async () => "", commit: async () => { throw new Error("must not commit"); },
      request: async () => ({ status: 401, body: JSON.stringify({ error: "invalid_client", error_description: "sensitive detail" }) }) });
    await flow.begin("alice", client, "wrong-secret", "https://app.example", callback);
    await expect(flow.finish({ state: "state", code: "code" })).rejects.toThrow("google_reconnect_invalid_client");
  });
});
