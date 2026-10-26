import { describe, test, expect } from "bun:test";
import {
  cbetaPassageUrl,
  cbetaTextUrl,
  parseCbetaRef,
  segmentMatchesPage,
} from "../src/cbeta.ts";
import {
  clearCatalogCache,
  findPageInVolume,
  pageIndexForSegment,
  PAGE_MAX_SEGMENTS,
} from "../src/corpus.ts";

describe("parseCbetaRef", () => {
  test("the user's verbose reference, with both tolerances reported", () => {
    const r = parseCbetaRef("CBETA 2026.R2, TX20, no. 12, p. b137a9");
    expect(r).not.toBeNull();
    expect(r!.edition).toBe("2026.R2");
    expect(r!.canon).toBe("X");
    expect(r!.volume).toBe(20);
    expect(r!.volumeToken).toBe("X20");
    expect(r!.textNo).toBe(12);
    expect(r!.textNoForm).toBe("no");
    expect(r!.page).toBe(137);
    expect(r!.column).toBe("a");
    expect(r!.line).toBe(9);
    expect(r!.pageKey).toBe("0137a09");
    expect(r!.droppedPrefix).toBe("T");
    expect(r!.leadingPageLetter).toBe("b");
  });
  test("compact id, bracket page, academic form, plain volume+page", () => {
    const c = parseCbetaRef("X20n0358_p0137a09")!;
    expect([c.canon, c.volume, c.textNo, c.textNoForm, c.pageKey]).toEqual(["X", 20, 358, "n", "0137a09"]);
    const b = parseCbetaRef("T50n2060 [0436b15]")!;
    expect([b.canon, b.volume, b.textNo, b.pageKey]).toEqual(["T", 50, 2060, "0436b15"]);
    const a = parseCbetaRef("T 1883.45.672a15")!;
    expect([a.canon, a.textNo, a.volume, a.textNoForm, a.pageKey]).toEqual(["T", 1883, 45, "academic", "0672a15"]);
    const v = parseCbetaRef("X20, p. 137a9")!;
    expect([v.canon, v.volume, v.textNo, v.pageKey, v.droppedPrefix]).toEqual(["X", 20, null, "0137a09", ""]);
  });
  test("unparseable input returns null, never throws", () => {
    expect(parseCbetaRef("")).toBeNull();
    expect(parseCbetaRef("hello world")).toBeNull();
    expect(parseCbetaRef("no. 12, p. 137a9")).toBeNull();
  });
});

describe("urls + segment matching", () => {
  test("CBETA passage/text urls", () => {
    expect(cbetaPassageUrl("X", 20, 358, "0137a09")).toBe(
      "https://cbetaonline.dila.edu.tw/zh/X20n0358_p0137a09",
    );
    expect(cbetaTextUrl("X", 358)).toBe("https://cbetaonline.dila.edu.tw/zh/X0358");
  });
  test("exact key or split suffix, nothing else", () => {
    expect(segmentMatchesPage("ZH_X20_0358_001:0137a09", "0137a09")).toBe(true);
    expect(segmentMatchesPage("ZH_T01_0001_010:0059b11_0", "0059b11")).toBe(true);
    expect(segmentMatchesPage("ZH_T01_0001_010:0059b12", "0059b11")).toBe(false);
    expect(segmentMatchesPage("ZH_T01_0001_010:0059b11_0", "0059b12")).toBe(false);
  });
});

describe("pageIndexForSegment", () => {
  test("replays chunking boundaries exactly", () => {
    const segs = Array.from({ length: PAGE_MAX_SEGMENTS + 2 }, (_, i) => ({
      segmentnr: `s:${i}`,
      original: "short",
    }));
    expect(pageIndexForSegment(segs, "s:0")).toBe(1);
    expect(pageIndexForSegment(segs, `s:${PAGE_MAX_SEGMENTS - 1}`)).toBe(1);
    expect(pageIndexForSegment(segs, `s:${PAGE_MAX_SEGMENTS}`)).toBe(2);
    expect(pageIndexForSegment(segs, "s:missing")).toBe(0);
    const long = [
      { segmentnr: "L:0", original: "a".repeat(1800) },
      { segmentnr: "L:1", original: "b" },
    ];
    expect(pageIndexForSegment(long, "L:1")).toBe(2);
  });
});

describe("findPageInVolume (stubbed fetch)", () => {
  function stubFetch(catalog: unknown, segmentsByFile: Record<string, unknown[]>) {
    return (async (url: string) => {
      if (url.includes("ZH_files.json")) return new Response(JSON.stringify(catalog));
      const file = url.split("/segments/")[1]?.replace(".json", "");
      const body = segmentsByFile[file] ?? [];
      return new Response(JSON.stringify(body));
    }) as unknown as typeof fetch;
  }
  const catalog = [
    { displayName: "Earlier", textname: "ZH_X20_0357", category: "X20", filename: "ZH_X20_0357_001" },
    { displayName: "Target", textname: "ZH_X20_0358", category: "X20", filename: "ZH_X20_0358_001" },
  ];
  const segs = {
    ZH_X20_0357_001: [{ segmentnr: "ZH_X20_0357_001:0132a07", original: "tail" }],
    ZH_X20_0358_001: [
      { segmentnr: "ZH_X20_0358_001:0137a08", original: "before" },
      { segmentnr: "ZH_X20_0358_001:0137a09", original: "the passage", cbeta_link: "https://cbetaonline.dila.edu.tw/zh/X20n0358_p0137a09" },
      { segmentnr: "ZH_X20_0358_001:0137a10", original: "after" },
    ],
  };
  test("scans in order, returns hit with context and CBETA link", async () => {
    clearCatalogCache();
    const { hit, searchedFiles } = await findPageInVolume("X20", "0137a09", null, stubFetch(catalog, segs));
    expect(hit).not.toBeNull();
    expect(hit!.textname).toBe("ZH_X20_0358");
    expect(hit!.filename).toBe("ZH_X20_0358_001");
    expect(hit!.ordinal).toBe(2);
    expect(hit!.original).toBe("the passage");
    expect(hit!.prev).toEqual(["before"]);
    expect(hit!.next).toEqual(["after"]);
    expect(hit!.cbetaLink).toBe("https://cbetaonline.dila.edu.tw/zh/X20n0358_p0137a09");
    expect(searchedFiles).toBe(2);
  });
  test("preferred textname is scanned first", async () => {
    clearCatalogCache();
    const { hit, searchedFiles } = await findPageInVolume("X20", "0137a09", "ZH_X20_0358", stubFetch(catalog, segs));
    expect(hit!.textname).toBe("ZH_X20_0358");
    expect(searchedFiles).toBe(1);
  });
  test("miss returns null with the file count", async () => {
    clearCatalogCache();
    const { hit, searchedFiles } = await findPageInVolume("X20", "0999a01", null, stubFetch(catalog, segs));
    expect(hit).toBeNull();
    expect(searchedFiles).toBe(2);
  });
});
