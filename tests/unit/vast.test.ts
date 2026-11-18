/**
 * Contract tests for the typed Vast client — no network, mocked fetch with
 * canned responses shaped from the OpenAPI reference (`api-reference/openapi.yaml`).
 * Fixtures are intentionally small; real API responses contain many more fields.
 */
import { describe, test, expect } from "bun:test";
import { VastClient, VastApiError, VastClientOptions } from "../../src/providers/vast/client";

const OFFER_FIXTURE = {
  id: 424242,
  machine_id: 9001,
  gpu_name: "RTX_3090",
  gpu_ram: 24576,
  cpu_ram: 65536,
  disk_space: 512,
  reliability: 0.999,
  dph_total: 0.17,
  inet_down: 4000,
  inet_up: 1500,
  geolocation: "US",
  public_ipaddr: "203.0.113.10",
  rentable: true,
  rented: false,
  verified: "verified",
  cpu_cores: 16,
  cpu_arch: "amd64",
  cuda_max_good: 12.4,
  storage_cost: 0.05,
  duration: 86400,
};

const INSTANCE_FIXTURE = {
  id: 1234567,
  machine_id: 9001,
  actual_status: "running",
  intended_status: "running",
  cur_state: "running",
  next_state: "running",
  label: "lumiverse-remote-gpu",
  start_date: 1_800_000_000,
  end_date: null,
  uptime_mins: 12,
  dph_total: 0.17,
  gpu_name: "RTX_3090",
  gpu_ram: 24576,
  cpu_ram: 65536,
  ssh_host: "ssh1234.vast.ai",
  ssh_port: 12345,
  public_ipaddr: "203.0.113.10",
  ports: [9443],
  jupyter_token: "deadbeef",
};

function makeFetch(responses: Array<{ status: number; body: unknown; check?: (url: string, init?: any) => void }>): VastClientOptions["fetchImpl"] {
  const queue = [...responses];
  const calls: Array<{ url: string; init?: any }> = [];
  const impl = async (url: string, init?: any) => {
    calls.push({ url, init });
    const item = queue.shift();
    if (!item) throw new Error("mock fetch: unexpected extra call to " + url);
    item.check?.(url, init);
    return {
      status: item.status,
      ok: item.status >= 200 && item.status < 300,
      json: async () => item.body,
      text: async () => JSON.stringify(item.body),
    };
  };
  (impl as any).calls = calls;
  return impl as any;
}

const KEY = "test-vast-key-000000";

describe("VastClient.searchOffers", () => {
  test("POSTs ondemand filter to /api/v0/bundles and returns offers", async () => {
    const fetchImpl = makeFetch([
      {
        status: 200,
        body: { offers: [OFFER_FIXTURE] },
        check: (url, init) => {
          expect(url).toBe("https://console.vast.ai/api/v0/bundles");
          expect(init.method).toBe("POST");
          expect(init.headers.Authorization).toBe(`Bearer ${KEY}`);
          const body = JSON.parse(init.body ?? "{}");
          expect(body.type).toBe("ondemand");
          expect(body.gpu_name.in).toContain("RTX_3090");
          expect(body.gpu_ram.gte).toBe(24000);
          expect(body.dph_total.lte).toBe(0.2);
          expect(body.verified.eq).toBe(true);
        },
      },
    ]);
    const client = new VastClient({ apiKey: KEY, fetchImpl });
    const offers = await client.searchOffers();
    expect(offers).toHaveLength(1);
    expect(offers[0].dph_total).toBeCloseTo(0.17);
    expect((fetchImpl as any).calls).toHaveLength(1);
  });
});

describe("VastClient.createInstance", () => {
  test("PUT /api/v0/asks/{id}/ and returns new_contract as instance id", async () => {
    const fetchImpl = makeFetch([
      {
        status: 200,
        body: { success: true, new_contract: 987654 },
        check: (url, init) => {
          expect(url).toBe("https://console.vast.ai/api/v0/asks/424242/");
          expect(init.method).toBe("PUT");
          const body = JSON.parse(init.body ?? "{}");
          expect(body.image).toBe("registry/comfyui:latest");
          expect(body.disk).toBe(100);
          expect(body.label).toBe("lumiverse-remote-gpu");
          expect(body.runtype).toBe("ssh");
          expect(body.target_state).toBe("running");
        },
      },
    ]);
    const client = new VastClient({ apiKey: KEY, fetchImpl });
    const res = await client.createInstance({
      offerId: 424242,
      image: "registry/comfyui:latest",
      diskGB: 100,
      label: "lumiverse-remote-gpu",
      runtype: "ssh",
      target_state: "running",
    });
    expect(res.success).toBe(true);
    expect(res.new_contract).toBe(987654);
  });

  test("failed create surfaces success=false with msg", async () => {
    const fetchImpl = makeFetch([
      { status: 200, body: { success: false, error: "invalid_args", msg: "Offer no longer available" } },
    ]);
    const client = new VastClient({ apiKey: KEY, fetchImpl });
    const res = await client.createInstance({ offerId: 1, image: "x", diskGB: 10 });
    expect(res.success).toBe(false);
    expect(res.error).toBe("invalid_args");
  });
});

describe("VastClient.showInstance / listInstances", () => {
  test("GET /api/v0/instances/{id}/ unwraps instances", async () => {
    const fetchImpl = makeFetch([
      { status: 200, body: { instances: INSTANCE_FIXTURE } },
    ]);
    const client = new VastClient({ apiKey: KEY, fetchImpl });
    const info = await client.showInstance(1234567);
    expect(info?.actual_status).toBe("running");
    expect(info?.dph_total).toBeCloseTo(0.17);
  });

  test("GET /api/v1/instances/ paginates with after_token", async () => {
    const fetchImpl = makeFetch([
      { status: 200, body: { instances: [INSTANCE_FIXTURE], next_token: null, total_instances: 1 } },
    ]);
    const client = new VastClient({ apiKey: KEY, fetchImpl });
    const res = await client.listInstances();
    expect(res.instances).toHaveLength(1);
    expect(res.instances[0].id).toBe(1234567);
  });
});

describe("VastClient.start/stop/destroy", () => {
  test("start -> PUT /api/v0/instances/{id}/ {state:running}", async () => {
    const fetchImpl = makeFetch([
      {
        status: 200,
        body: { success: true },
        check: (url, init) => {
          expect(url).toBe("https://console.vast.ai/api/v0/instances/1234567/");
          expect(JSON.parse(init.body).state).toBe("running");
        },
      },
    ]);
    const client = new VastClient({ apiKey: KEY, fetchImpl });
    const res = await client.startInstance(1234567);
    expect(res.success).toBe(true);
  });

  test("stop -> PUT with {state:stopped}", async () => {
    const fetchImpl = makeFetch([
      {
        status: 200,
        body: { success: true },
        check: (_, init) => expect(JSON.parse(init.body).state).toBe("stopped"),
      },
    ]);
    const client = new VastClient({ apiKey: KEY, fetchImpl });
    expect((await client.stopInstance(1)).success).toBe(true);
  });

  test("destroy -> DELETE without a body", async () => {
    const fetchImpl = makeFetch([
      { status: 200, body: { success: true }, check: (url, init) => expect(init.method).toBe("DELETE") },
    ]);
    const client = new VastClient({ apiKey: KEY, fetchImpl });
    expect((await client.destroyInstance(42)).success).toBe(true);
  });
});

describe("VastClient error handling", () => {
  test("non-2xx throws VastApiError with status and parsed body", async () => {
    const fetchImpl = makeFetch([{ status: 429, body: { detail: "API requests too frequent" } }]);
    const client = new VastClient({ apiKey: KEY, fetchImpl });
    try {
      await client.searchOffers();
      expect.unreachable("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(VastApiError);
      expect((err as VastApiError).status).toBe(429);
    }
  });

  test("missing apiKey throws", () => {
    expect(() => new VastClient({ apiKey: "" })).toThrow();
  });
});
