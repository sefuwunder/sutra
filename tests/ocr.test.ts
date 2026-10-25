import { describe, test, expect } from "bun:test";
import { tesseractArgs, langLabel, OCR_LANGS } from "../src/ocr.ts";

describe("tesseractArgs", () => {
  test("uses psm 6 and the requested language", () => {
    expect(tesseractArgs("/tmp/p.png", "bod")).toEqual([
      "tesseract",
      "/tmp/p.png",
      "stdout",
      "--psm",
      "6",
      "-l",
      "bod",
    ]);
    expect(tesseractArgs("/tmp/p.png", "bod+san")).toContain("bod+san");
  });
});

describe("langLabel", () => {
  test("maps known codes and falls back for unknown ones", () => {
    expect(langLabel("bod")).toBe("Tibetan");
    expect(langLabel("san")).toBe("Sanskrit");
    expect(langLabel("bod+san")).toBe("Tibetan or Sanskrit");
    expect(langLabel("xyz")).toBe("Tibetan or Sanskrit");
  });

  test("every OCR_LANGS entry has a tesseract code", () => {
    for (const v of Object.values(OCR_LANGS)) {
      expect(v.tess.length).toBeGreaterThan(0);
      expect(v.label.length).toBeGreaterThan(0);
    }
  });
});
