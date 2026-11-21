/** Civitai metadata helpers. Tokens and arbitrary remote URLs are never returned. */
export type CivitaiFamily = "anima" | "moss";
export type CivitaiFile = { id: number; name: string; sizeKB: number; sha256: string | null };
export type CivitaiVersion = { id: number; modelId: number; name: string; modelName: string; family: CivitaiFamily; baseModel: string; files: CivitaiFile[] };
export function parseCivitaiUrl(input: unknown): { modelId?: number; versionId?: number } {
  if (typeof input !== "string" || input.length > 2048) throw new Error("civitai_url_invalid");
  let url: URL;
  try { url = new URL(input); } catch { throw new Error("civitai_url_invalid"); }
  if (url.protocol !== "https:" || !["civitai.com", "www.civitai.com", "civitai.red", "www.civitai.red"].includes(url.hostname) || url.username || url.password || url.port) throw new Error("civitai_url_invalid");
  const page = url.pathname.match(/^\/models\/(\d+)(?:\/[^/]*)?\/?$/);
  const download = url.pathname.match(/^\/api\/download\/models\/(\d+)\/?$/);
  const version = url.searchParams.get("modelVersionId") ?? download?.[1];
  if (version && !/^[1-9]\d{0,14}$/.test(version)) throw new Error("civitai_url_invalid");
  if (!page && !download) throw new Error("civitai_url_invalid");
  return { ...(page ? { modelId: Number(page[1]) } : {}), ...(version ? { versionId: Number(version) } : {}) };
}
export function parseCivitaiVersion(value: any): CivitaiVersion {
  const id = value?.id, modelId = value?.modelId;
  if (!Number.isSafeInteger(id) || id <= 0 || !Number.isSafeInteger(modelId) || modelId <= 0 || value?.model?.type !== "Checkpoint" || typeof value.baseModel !== "string") throw new Error("civitai_model_unsupported");
  const baseModel = value.baseModel.trim();
  const family: CivitaiFamily | null = /^anima(?:\b|[-_ ])/i.test(baseModel) ? "anima" : /^moss(?:[-_ ]?image)?(?:\b|[-_ ])/i.test(baseModel) ? "moss" : null;
  if (!family || !Array.isArray(value.files)) throw new Error("civitai_model_unsupported");
  const files = value.files.filter((file: any) => file?.type === "Model" && Number.isSafeInteger(file.id) && file.id > 0 &&
      typeof file.name === "string" && file.name.length <= 180 && /\.safetensors$/i.test(file.name) && !/[\x00-\x1f\x7f/\\]/.test(file.name) &&
      Number.isFinite(file.sizeKB) && file.sizeKB > 0 && file.sizeKB <= 100_000_000)
    .slice(0, 64).map((file: any) => ({ id: file.id, name: file.name, sizeKB: file.sizeKB,
      sha256: typeof file.hashes?.SHA256 === "string" && /^[a-f0-9]{64}$/i.test(file.hashes.SHA256) ? file.hashes.SHA256.toLowerCase() : null }));
  if (!files.length) throw new Error("civitai_no_safetensors");
  const safe = (x: unknown, fallback: string) => typeof x === "string" ? x.slice(0, 120) : fallback;
  return { id, modelId, name: safe(value.name, "Version"), modelName: safe(value.model.name, "Civitai model"), family, baseModel: baseModel.slice(0, 100), files };
}

export type CivitaiSelection = { version: CivitaiVersion; fileId: number };
export function validateCivitaiSelection(input: any): CivitaiSelection {
  if (!input?.version || !Number.isSafeInteger(input.fileId)) throw new Error("civitai_selection_invalid");
  const v = input.version;
  const version = parseCivitaiVersion({ id: v.id, modelId: v.modelId, name: v.name, baseModel: v.baseModel,
    model: { name: v.modelName, type: "Checkpoint" }, files: Array.isArray(v.files) ? v.files.map((f: any) => ({ ...f, type: "Model", hashes: { SHA256: f.sha256 } })) : [] });
  if (version.family !== v.family || !version.files.some(f => f.id === input.fileId)) throw new Error("civitai_selection_invalid");
  return { version, fileId: input.fileId };
}
