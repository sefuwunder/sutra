import { describe, test, expect } from "bun:test";
import {
  labelText,
  parseCollection,
  parseManifest,
  isAllowedFetchUrl,
  IMPORT_WIDTH,
  miradorUrl,
} from "../src/iiif.ts";

describe("labelText", () => {
  test("plain string, language map, and fallbacks", () => {
    expect(labelText("plain")).toBe("plain");
    expect(labelText({ en: ["Ajīrṇamañjarī (?) (Matsunami Catalogue 1)"] })).toBe(
      "Ajīrṇamañjarī (?) (Matsunami Catalogue 1)",
    );
    expect(labelText({ none: ["x"] })).toBe("x");
    expect(labelText(["", "second"])).toBe("second");
    expect(labelText(null)).toBe("");
    expect(labelText(42)).toBe("");
  });
});

describe("parseCollection", () => {
  test("v3 collection items, letter-suffixed ids kept verbatim", () => {
    const coll = parseCollection({
      label: { en: ["Database for Sanskrit manuscripts in the UTokyo Library"] },
      requiredStatement: { value: { en: ["The University of Tokyo"] } },
      items: [
        { type: "Manifest", id: "https://dzkimgs.l.u-tokyo.ac.jp/iiif/skt2020/0001/manifest.json", label: { en: ["Ajīrṇamañjarī (?) (Matsunami Catalogue 1)"] } },
        { type: "Manifest", id: "https://dzkimgs.l.u-tokyo.ac.jp/iiif/skt2020/0050a/manifest.json", label: { en: ["Aṣṭasāhasrikā Prajñāpāramitā (Matsunami Catalogue 50)"] } },
        { type: "Manifest", label: { en: ["no id, dropped"] } },
      ],
    });
    expect(coll.title).toBe("Database for Sanskrit manuscripts in the UTokyo Library");
    expect(coll.attribution).toBe("The University of Tokyo");
    expect(coll.items).toHaveLength(2);
    expect(coll.items[1].manifest).toContain("/0050a/manifest.json");
  });
});

describe("parseManifest", () => {
  const fixture = {
    "@id": "https://dzkimgs.l.u-tokyo.ac.jp/iiif/skt2020/0001/manifest.json",
    label: "Matsunami Catalogue 1",
    license: "https://creativecommons.org/licenses/by/4.0",
    attribution: "SAT Daizokyo Database Committee and The University of Tokyo Library System",
    seeAlso: { "@id": "https://dzkimgs.l.u-tokyo.ac.jp/iiif/skt2020/metadata/sktmsdb_Matsunami-001.xml" },
    metadata: [
      { label: "title", value: "Ajīrṇamañjarī (?)" },
      { label: "author", value: "Kāsirāja" },
      { label: "msIdentifier_idno", value: "Matsunami 1" },
      { label: "scriptDesc", value: "Devanāgarī" },
    ],
    sequences: [
      {
        canvases: [
          {
            label: "p. 1",
            "@id": "https://dzkimgs.l.u-tokyo.ac.jp/iiif/skt2020/0001/canvas/p1.json",
            thumbnail: { "@id": "https://dzkimgs.l.u-tokyo.ac.jp/iiif/skt2020/0001/tn_0001.jpg" },
            images: [
              {
                resource: {
                  "@id": "https://imgsrv.dhii.jp/iiifimgs/skt2020/0001/0001.tif/full/full/0/default.jpg",
                  service: { "@id": "https://imgsrv.dhii.jp/iiifimgs/skt2020/0001/0001.tif" },
                },
              },
            ],
          },
          {
            label: "p. 2",
            "@id": "https://dzkimgs.l.u-tokyo.ac.jp/iiif/skt2020/0001/canvas/p2.json",
            images: [
              {
                resource: {
                  "@id": "https://imgsrv.dhii.jp/iiifimgs/skt2020/0001/0002.tif/full/full/0/default.jpg",
                  service: { "@id": "https://imgsrv.dhii.jp/iiifimgs/skt2020/0001/0002.tif" },
                },
              },
            ],
          },
        ],
      },
    ],
  };

  test("metadata, canvases, thumbnails, sized import URLs", () => {
    const m = parseManifest(fixture);
    expect(m.title).toBe("Ajīrṇamañjarī (?)");
    expect(m.label).toBe("Matsunami Catalogue 1");
    expect(m.metadata.find((r) => r.label === "author")?.value).toBe("Kāsirāja");
    expect(m.license).toContain("creativecommons.org/licenses/by/4.0");
    expect(m.seeAlso).toContain("sktmsdb_Matsunami-001.xml");
    expect(m.canvases).toHaveLength(2);
    expect(m.canvases[0].thumb).toContain("tn_0001.jpg");
    // No thumbnail on canvas 2: falls back to a IIIF sized request.
    expect(m.canvases[1].thumb).toBe(
      "https://imgsrv.dhii.jp/iiifimgs/skt2020/0001/0002.tif/full/256,/0/default.jpg",
    );
    expect(m.canvases[0].sized).toBe(
      `https://imgsrv.dhii.jp/iiifimgs/skt2020/0001/0001.tif/full/${IMPORT_WIDTH},/0/default.jpg`,
    );
    expect(m.canvases[0].full).toContain("/full/full/0/default.jpg");
  });
});

describe("isAllowedFetchUrl", () => {
  test("only the two UTokyo/DHII hosts and paths", () => {
    expect(isAllowedFetchUrl("https://dzkimgs.l.u-tokyo.ac.jp/iiif/skt2020/0001/manifest.json")).toBe(true);
    expect(isAllowedFetchUrl("https://dzkimgs.l.u-tokyo.ac.jp/iiif/skt2020/collection3.json")).toBe(true);
    expect(isAllowedFetchUrl("https://imgsrv.dhii.jp/iiifimgs/skt2020/0001/0001.tif/full/2000,/0/default.jpg")).toBe(true);
    expect(isAllowedFetchUrl("http://dzkimgs.l.u-tokyo.ac.jp/iiif/skt2020/0001/manifest.json")).toBe(false);
    expect(isAllowedFetchUrl("https://dzkimgs.l.u-tokyo.ac.jp/ut_skt_manuscripts/")).toBe(false);
    expect(isAllowedFetchUrl("https://dzkimgs.l.u-tokyo.ac.jp/iiif/other/manifest.json")).toBe(false);
    expect(isAllowedFetchUrl("https://evil.example.com/iiif/skt2020/0001/manifest.json")).toBe(false);
    expect(isAllowedFetchUrl("not a url")).toBe(false);
  });
});

describe("miradorUrl", () => {
  test("points at the site's own Mirador with the manifest param", () => {
    const u = miradorUrl("https://dzkimgs.l.u-tokyo.ac.jp/iiif/skt2020/0001/manifest.json");
    expect(u).toStartWith("https://dzkimgs.l.u-tokyo.ac.jp/mirador3/?");
    expect(u).toContain("manifest=https%3A%2F%2Fdzkimgs");
  });
});
