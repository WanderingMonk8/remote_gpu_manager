import notebook from "../Unified_MOSS_Anima_Colab_Studio_Tailscale_Final.ipynb" with { type: "text" };

/** Bundle the reviewed notebook with the extension, not the gateway image. */
export async function bundledWorkbook(): Promise<{ content: string; sha256: string }> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(notebook));
  const sha256 = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
  return { content: notebook, sha256 };
}
