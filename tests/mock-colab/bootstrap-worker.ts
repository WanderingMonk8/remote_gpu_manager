const request = await Bun.stdin.json();
if (!request.runtime.connectionInfo.token || !request.credentials.BASIC_AUTH_PASS) process.exit(1);
console.log(JSON.stringify({ ok: true, funnel: "https://mock.ts.net", state: { "tailscaled.state": "c2VjcmV0" } }));
