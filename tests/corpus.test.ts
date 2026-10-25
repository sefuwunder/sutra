import { describe, test, expect } from "bun:test";
import {
  CORPUS_LANGS,
  PAGE_MAX_CHARS,
  PAGE_MAX_SEGMENTS,
  catalogUrl,
  chunkSegments,
  clearCatalogCache,
  fetchCatalog,
  isAllowedCorpusUrl,
  isCorpusFilename,
  parseCatalog,
  parseSegments,
  passageUrl,
  readerUrl,
  segmentUrl,
} from "../src/corpus.ts";

describe("filenames", () => {
  test("token + rest; trailing underscore is real (Dhammapada)", () => {
    expect(isCorpusFilename("pa", "PA_dhp_")).toBe(true);
    expect(isCorpusFilename("pa", "PA_dn_1")).toBe(true);
    expect(isCorpusFilename("pa", "PA_atk-s05_02a")).toBe(true);
    expect(isCorpusFilename("sa", "SA_K14_mavadsuu")).toBe(true);
    expect(isCorpusFilename("zh", "ZH_T01_0001_010")).toBe(true);
    expect(isCorpusFilename("sa", "PA_dn_1")).toBe(false);
    expect(isCorpusFilename("pa", "PA_../x")).toBe(false);
    expect(isCorpusFilename("pa", "")).toBe(false);
    expect(isCorpusFilename("pa", "PA_")).toBe(false);
  });
});

describe("urls", () => {
  test("catalog + segment urls per language and branch", () => {
    expect(catalogUrl("pa")).toBe(
      "https://raw.githubusercontent.com/dharmamitra/dharmanexus-pali/main/PA_files.json",
    );
    expect(catalogUrl("sa")).toBe(
      "https://raw.githubusercontent.com/dharmamitra/dharmanexus-sanskrit/master/SA_files.json",
    );
    expect(catalogUrl("zh")).toBe(
      "https://raw.githubusercontent.com/dharmamitra/dharmanexus-chinese/master/ZH_files.json",
    );
    expect(segmentUrl("pa", "PA_dhp_")).toBe(
      "https://raw.githubusercontent.com/dharmamitra/dharmanexus-pali/main/segments/PA_dhp_.json",
    );
  });
  test("reader + passage links use the corpus filename as the db id", () => {
    expect(readerUrl("pa", "PA_dhp_")).toBe("https://dharmamitra.org/db/pa/PA_dhp_/text");
    expect(readerUrl("sa", "SA_K14_mavadsuu")).toBe(
      "https://dharmamitra.org/db/sa/SA_K14_mavadsuu/text",
    );
    expect(passageUrl("pa", "PA_dhp_", "PA_dhp_:1.1")).toBe(
      "https://dharmamitra.org/db/pa/PA_dhp_/text?active_segment=PA_dhp_%3A1.1",
    );
  });
  test("allowlist: only the three corpus repos, right branches, catalog or segments", () => {
    expect(isAllowedCorpusUrl(catalogUrl("pa"))).toBe(true);
    expect(isAllowedCorpusUrl(segmentUrl("zh", "ZH_T01_0001_010"))).toBe(true);
    expect(isAllowedCorpusUrl(segmentUrl("pa", "PA_dhp_"))).toBe(true);
    expect(isAllowedCorpusUrl("https://raw.githubusercontent.com/dharmamitra/dharmanexus-pali/master/PA_files.json")).toBe(false);
    expect(isAllowedCorpusUrl("https://raw.githubusercontent.com/dharmamitra/other-repo/main/PA_files.json")).toBe(false);
    expect(isAllowedCorpusUrl("https://raw.githubusercontent.com/dharmamitra/dharmanexus-pali/main/README.md")).toBe(false);
    expect(isAllowedCorpusUrl("https://raw.githubusercontent.com/dharmamitra/dharmanexus-pali/main/segments/PA_../x.json")).toBe(false);
    expect(isAllowedCorpusUrl("http://raw.githubusercontent.com/dharmamitra/dharmanexus-pali/main/PA_files.json")).toBe(false);
    expect(isAllowedCorpusUrl("https://dharmamitra.org/api-search/primary/")).toBe(false);
    expect(CORPUS_LANGS.pa.branch).toBe("main");
    expect(CORPUS_LANGS.sa.branch).toBe("master");
  });
});

describe("parseCatalog", () => {
  test("normalizes PA/SA/ZH shapes, prefers link then link2 then cbeta", () => {
    const items = parseCatalog([
      { displayName: "Brahmajāla Sutta", textname: "DN 1", filename: "PA_dn_1", category: "dn", collection: "Suttas-Early-1", link: "https://tipitaka.org/x", link2: "https://suttacentral.net/dn1" },
      { displayName: "Darpadalana", filename: "SA_GK22_ksdarppu", collection: "Poetry", category: "GK22", author: "Kṣemendra", raw_metadata: "# Darpadalana" },
      { displayName: "長阿含經", textname: "ZH_T01_0001", filename: "ZH_T01_0001_010", category: "T01", collection: "Taisho-1", cbeta_link: "https://cbetaonline.dila.edu.tw/zh/T0001" },
      { displayName: "No file" },
    ]);
    expect(items.length).toBe(3);
    expect(items[0].sourceLink).toBe("https://tipitaka.org/x");
    expect(items[1].author).toBe("Kṣemendra");
    expect(items[2].sourceLink).toBe("https://cbetaonline.dila.edu.tw/zh/T0001");
    expect(() => parseCatalog({})).toThrow();
  });
});

describe("parseSegments + chunking", () => {
  test("drops empty originals and missing ids; keeps segment numbers", () => {
    const segs = parseSegments([
      { segmentnr: "PA_dn_1:0.1", original: "Dīgha Nikāya 1" },
      { segmentnr: "PA_dn_1:0.2", original: "   " },
      { segmentnr: "", original: "orphan" },
      { segmentnr: "PA_dn_1:1.1.1", original: "Evaṁ me sutaṁ—" },
    ]);
    expect(segs).toEqual([
      { segmentnr: "PA_dn_1:0.1", original: "Dīgha Nikāya 1" },
      { segmentnr: "PA_dn_1:1.1.1", original: "Evaṁ me sutaṁ—" },
    ]);
    expect(() => parseSegments({})).toThrow();
  });
  test("chunks by segment count, then by chars; page links at first segment", () => {
    const many = Array.from({ length: PAGE_MAX_SEGMENTS + 5 }, (_, i) => ({
      segmentnr: `PA_x:${i}`,
      original: "short",
    }));
    const pages = chunkSegments(many);
    expect(pages.length).toBe(2);
    expect(pages[0].firstSegmentnr).toBe("PA_x:0");
    expect(pages[1].firstSegmentnr).toBe(`PA_x:${PAGE_MAX_SEGMENTS}`);
    const long = [
      { segmentnr: "PA_x:0", original: "a".repeat(PAGE_MAX_CHARS) },
      { segmentnr: "PA_x:1", original: "b" },
    ];
    const pages2 = chunkSegments(long);
    expect(pages2.length).toBe(2);
    expect(pages2[1].text).toBe("b");
    expect(chunkSegments([])).toEqual([]);
  });
});

describe("fetchCatalog cache", () => {
  test("second call within the hour reuses the first fetch", async () => {
    clearCatalogCache();
    let calls = 0;
    const stub = (async (url: string) => {
      calls++;
      return new Response(JSON.stringify([{ displayName: "Dhammapada", filename: "PA_dhp_" }]));
    }) as unknown as typeof fetch;
    const first = await fetchCatalog("pa", stub);
    const second = await fetchCatalog("pa", stub);
    expect(calls).toBe(1);
    expect(second).toEqual(first);
  });
});
