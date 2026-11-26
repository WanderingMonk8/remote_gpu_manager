import { describe, expect, test } from "bun:test";
import { runBootstrap } from "../host-gateway/bootstrap";

const request = {
  runtime: { name: "runtimes/test", connectionInfo: { url: "https://example.invalid", token: "proxy-secret" } },
  credentials: { TS_AUTHKEY: "tailnet-secret", BASIC_AUTH_USER: "user", BASIC_AUTH_PASS: "password-secret" },
  state: { "tailscaled.state": "private-state" },
};

describe("bootstrap worker stdio", () => {
  test("passes credentials privately and returns the worker result", async () => {
    const script = `const req = await Bun.stdin.json();
      if (req.credentials.TS_AUTHKEY !== 'tailnet-secret') process.exit(1);
      console.log(JSON.stringify({ok:true, funnel:'https://worker.example', state:req.state, kernelId:'kernel-1'}));`;
    const result = await runBootstrap([process.execPath, "-e", script], request, 5000);
    expect(result).toEqual({ funnel: "https://worker.example", state: request.state, kernelId: "kernel-1" });
  });

  test("does not expose worker output or secrets in an error", async () => {
    const script = `console.error('password-secret'); console.log('proxy-secret'); process.exit(1)`;
    await expect(runBootstrap([process.execPath, "-e", script], request, 5000)).rejects.toThrow("bootstrap_failed");
  });
  test("passes the successful LoRA report through the worker bridge", async () => {
    const script = `console.log(JSON.stringify({ok:true, funnel:'https://worker.example', state:{}, kernelId:'kernel-1', loraInstalled:[{url:'https://civitai.red/api/download/models/1',name:'model.safetensors'}]}))`;
    const result = await runBootstrap([process.execPath, "-e", script], request, 5000);
    expect(result.loraInstalled).toEqual([{ url: "https://civitai.red/api/download/models/1", name: "model.safetensors" }]);
  });
});
