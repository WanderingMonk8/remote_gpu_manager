# ADR-004 — Native LoRA Studio authority vs. behind-the-scenes resolver

**Status:** Accepted for design; validation pending (V3)
**Date:** 2026-11-18

## Context

PRD v2.0 §7.1 requires us to verify how Lumiverse's native LoRA pipeline handles filenames and URLs before implementing a redundant downloader. The screenshot shows a direct Civitai URL (`https://civitai.red/api/download/models/...`) in the native filename field — it proves only that a URL literal can be stored in a native field, not that the host downloads it, where, or whether model-only stacking works for MOSS/Anima.

Known from source (`src/services/image-gen.service.ts`, `comfyui-workflow-patch.ts`, `character-lora.service.ts` on both `main` v1.2.5 and `staging` v1.3.0 — files unchanged between them):

- Native workflow patching writes values **only into pre-existing mapped nodes**; it never inserts nodes. Ordered LoRA stack entries are mapped positionally onto mapped LoRA nodes (`buildLoraEntryMap`).
- Detector hints cover `LoraLoader` only; `LoraLoaderModelOnly` (MOSS/Anima) is **not** auto-detected; `EmptyFlux2LatentImage`/`EmptyLatentImage`, `CLIPLoader`, `VAELoader` are never auto-detected. Manual field mappings are mandatory.
- `lora_strength_clip` does not exist on `LoraLoaderModelOnly`; mapping it would inject an invalid input.
- Native installed-file catalog (`object_info`) is fetched from the worker; discovery refreshes on connection capabilities calls.
- Native Civitai behavior for direct-download URLs in the filename field and for `.com`/`.red` resolution **has not been proven end-to-end** (worker cache is not `/content` since the worker is not Colab; behavior observed only inside Colab session is irrelevant for Vast).

## Decision

1. **Native LoRA Studio is the only creative authority.** We do not create a second LoRA weight/order/tag editor; native preset values (order, weights, bypass) flow unchanged into the final graph.
2. **Behind-the-scenes resolver, not replacement.** The extension inspects the final native graph's LoRA nodes; for each referenced `lora_name` it:
   - accepts an existing relative filename that matches the worker's installed catalog — no network call;
   - accepts a direct `/api/download/models/{versionId}` URL on `civitai.com`/`civitai.red` — resolve to exact version + file IDs, download to `models/loras/<family>/`, validate safetensors header + SHA-256 when published, atomically rename, refresh worker catalog;
   - accepts a model-page URL or `modelVersionId` — one clearly chosen compatible version or interactive choice; wrong family rejected deterministically;
   - **fails before prompt submission** if a file is missing or incompatible — no silent omission, no fallback.
3. **No parallel stack.** Resolver only fills `lora_name` in the native graph via transient field override; it never invents a second LoRA stack or duplicates `static` + dynamic inserts.
4. **Scope** — resolver is off by default unless the worker advertises the management endpoint; it activates for the dedicated managed Vast connection only, never for unrelated native profiles.
5. **Validation before V3** — a clean-cache test against a real Vast instance is required to close `ADR-004`; until then it is a proposal, not a release claim.

## Consequences

- Civitai auth: user provides their token via a write-only secret field; never sent outside `civitai.com`/`civitai.red` without explicit approval; tokens are never persisted into presets or graphs.
- Manifest tracks `modelId/versionId/fileId`, family, expected hash, filename, and retrieval date; cache hit avoids re-download.
- If native already downloads (behavior to be proven in V3), we delete or stub our resolver and keep only the manifest/cache logic as a cache for native-resolved files — no duplicated downloads.
- `LoraLoaderModelOnly` mapping is authoritative; any request to map `lora_strength_clip` onto it is rejected client-side before submission.
