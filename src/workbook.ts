import notebook from "../Unified_MOSS_Anima_Colab_Studio_Tailscale_Final.ipynb" with { type: "text" };

import { validateWorkbookSettings, type WorkbookSettings } from "./workbook-settings";

/** Bundle the reviewed notebook with the extension, not the gateway image. */
export async function bundledWorkbook(settings?: WorkbookSettings): Promise<{ content: string; sha256: string }> {
  let content = notebook;
  if (settings) {
    const values = validateWorkbookSettings(settings);
    // An empty URL list must not fall through to Colab's interactive file picker.
    if (!String(values.LORA_URLS).trim()) values.UPLOAD_LOCAL_LORA = false;
    const parsed = JSON.parse(notebook);
    for (const [key, value] of Object.entries(values)) {
      let count = 0;
      for (const cell of parsed.cells) {
        if (!Array.isArray(cell.source)) continue;
        cell.source = cell.source.map((line: string) => {
          const match = line.replace(/\r?\n$/, "").match(new RegExp(`^(\\s*${key}\\s*=\\s*)(.*?)(\\s*#\\s*@param.*)$`));
          if (!match) return line;
          count++;
          const literal = typeof value === "boolean" ? (value ? "True" : "False") : JSON.stringify(value);
          return `${match[1]}${literal}${match[3]}${line.endsWith("\n") ? "\n" : ""}`;
        });
      }
      if (count !== 1) throw new Error("workbook_settings_incompatible");
    }
    content = JSON.stringify(parsed);
  }
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(content));
  const sha256 = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
  return { content, sha256 };
}
