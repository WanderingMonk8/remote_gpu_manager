import { describe, expect, test } from "bun:test";
import { pickerOrigin } from "../src/drive-picker";

describe("Picker origin", () => {
  test("keeps the app origin for direct visits even with an external referrer", () => {
    expect(pickerOrigin("https://app.hf.space", [], "https://console.cloud.google.com/", false)).toBe("https://app.hf.space");
  });
  test("uses the topmost ancestor for embedded visits", () => {
    expect(pickerOrigin("https://app.hf.space", ["https://middle.example", "https://huggingface.co"], "", true)).toBe("https://huggingface.co");
  });
  test("uses the referring parent when ancestor origins are unavailable", () => {
    expect(pickerOrigin("https://app.hf.space", undefined, "https://huggingface.co/spaces/test", true)).toBe("https://huggingface.co");
  });
});
