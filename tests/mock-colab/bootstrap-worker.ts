const request = await Bun.stdin.json();
if (!request.runtime.connectionInfo.token || !request.credentials.BASIC_AUTH_PASS || !request.workbook?.content || !request.workbook?.sha256) process.exit(1);
console.log(JSON.stringify({ ok: true, funnel: process.env.MOCK_BOOTSTRAP_URL, state: { "tailscaled.state": "c2VjcmV0" }, kernelId: "mock-kernel" }));
