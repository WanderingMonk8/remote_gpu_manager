/** Maintain a real Jupyter channels connection without executing synthetic work. */
export class JupyterConnection {
  private socket: WebSocket | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private generation = 0;
  private failures = 0;
  private current: "stopped" | "connecting" | "connected" | "reconnecting" = "stopped";

  constructor(private readonly credentials: () => Promise<{ url: string; token: string; expireTime?: string }>,
              private readonly openSocket: (url: string, token: string) => WebSocket = (url, token) =>
                new WebSocket(url, { headers: { "X-Colab-Runtime-Proxy-Token": token } } as unknown as string[])) {}

  status() { return this.current; }

  start(kernelId: string) {
    this.stop();
    const generation = this.generation;
    this.current = "connecting";
    void this.connect(kernelId, generation);
  }

  stop() {
    this.generation++;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const socket = this.socket;
    this.socket = null;
    if (socket) socket.close();
    this.failures = 0;
    this.current = "stopped";
  }

  private retry(kernelId: string, generation: number) {
    if (generation !== this.generation || this.timer) return;
    this.current = "reconnecting";
    const delay = Math.min(300_000, 5_000 * 2 ** Math.min(this.failures++, 6));
    this.timer = setTimeout(() => { this.timer = null; void this.connect(kernelId, generation); }, delay);
  }

  private async connect(kernelId: string, generation: number) {
    try {
      const info = await this.credentials();
      if (generation !== this.generation) return;
      const base = new URL(info.url);
      if (base.protocol !== "https:" || !/^[a-z0-9.-]+\.colab\.dev$/i.test(base.hostname) || !info.token) throw new Error("invalid connection");
      const url = new URL(`/api/kernels/${encodeURIComponent(kernelId)}/channels`, base);
      url.protocol = "wss:";
      url.searchParams.set("session_id", crypto.randomUUID());
      url.searchParams.set("colab-runtime-proxy-token", info.token);
      const socket = this.openSocket(url.toString(), info.token);
      this.socket = socket;
      this.timer = setTimeout(() => {
        this.timer = null;
        if (this.socket === socket) { this.socket = null; socket.close(); this.retry(kernelId, generation); }
      }, 30_000);
      socket.onopen = () => {
        if (generation !== this.generation || this.socket !== socket) return;
        if (this.timer) clearTimeout(this.timer);
        this.timer = null;
        this.current = "connected";
        this.failures = 0;
        const expiry = Date.parse(info.expireTime || "");
        const delay = Number.isFinite(expiry) ? Math.max(30_000, Math.min(3_600_000, expiry - Date.now() - 60_000)) : 3_600_000;
        this.timer = setTimeout(() => { this.timer = null; if (this.socket === socket) { this.socket = null; socket.close(); this.retry(kernelId, generation); } }, delay);
      };
      const failed = () => {
        if (generation !== this.generation || this.socket !== socket) return;
        this.socket = null;
        if (this.timer) clearTimeout(this.timer);
        this.timer = null;
        socket.close();
        this.retry(kernelId, generation);
      };
      socket.onerror = failed;
      socket.onclose = failed;
    } catch { this.retry(kernelId, generation); }
  }
}
