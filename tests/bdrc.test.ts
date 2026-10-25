import { describe, test, expect } from "bun:test";
import {
  ACCESS_OPEN,
  baseId,
  blmpUrl,
  isAllowedBdrcUrl,
  isDirectId,
  kindOf,
  manifestUrl,
  parseBlmp,
  parseInstanceGraph,
  parseVolumeInfo,
  parseVolumes,
  scriptToOcrLang,
} from "../src/bdrc.ts";
import { labelText } from "../src/iiif.ts";

describe("ids", () => {
  test("base id strips outline/etext suffixes; kinds; direct ids", () => {
    expect(baseId("MW2046_C2FE67")).toBe("MW2046");
    expect(baseId("MW3MS701_O3MS701_CQ6K2L")).toBe("MW3MS701");
    expect(baseId("MW3KG323")).toBe("MW3KG323");
    expect(kindOf("MW3CN7814")).toBe("instance");
    expect(kindOf("W23703")).toBe("work");
    expect(kindOf("I3CN7816")).toBe("volume");
    expect(kindOf("P64")).toBe("other");
    expect(isDirectId("MW3CN7814")).toBe(true);
    expect(isDirectId("lam rim chen mo")).toBe(false);
    expect(isDirectId("MW3CN7814 ")).toBe(true);
  });
});

describe("parseBlmp", () => {
  test("dedupes by base id, drops non-work/instance hits", () => {
    const hits = parseBlmp({
      results: {
        bindings: [
          { s: { value: "http://purl.bdrc.io/resource/MW2046_C2FE67" }, lit: { value: "lam rim chen mo'i …", "xml:lang": "bo-x-ewts" } },
          { s: { value: "http://purl.bdrc.io/resource/MW2046" }, lit: { value: "lam rim chen mo", "xml:lang": "bo-x-ewts" } },
          { s: { value: "http://purl.bdrc.io/resource/P64" }, lit: { value: "tsong kha pa", "xml:lang": "bo-x-ewts" } },
          { s: { value: "http://purl.bdrc.io/resource/W23703" }, lit: { value: "lam rim chen mo", "xml:lang": "en" } },
        ],
      },
    });
    expect(hits).toHaveLength(2);
    expect(hits[0]).toMatchObject({ id: "MW2046", kind: "instance" });
    expect(hits[1]).toMatchObject({ id: "W23703", kind: "work" });
  });
});

describe("parseInstanceGraph", () => {
  const graph = {
    "http://purl.bdrc.io/resource/MW3CN7814": {
      "http://purl.bdrc.io/ontology/core#prefLabel": [
        { type: "literal", value: "byang chub lam rim chen mo par gzhi gsar pa/", lang: "bo-x-ewts" },
        { type: "literal", value: "Lamrim Chenmo, new print", lang: "en" },
      ],
      "http://purl.bdrc.io/ontology/core#publisherName": [{ type: "literal", value: "[s.n.]" }],
      "http://purl.bdrc.io/ontology/core#script": [{ type: "uri", value: "http://purl.bdrc.io/resource/ScriptTibt" }],
      "http://purl.bdrc.io/ontology/core#extentStatement": [{ type: "literal", value: "1 v." }],
      "http://purl.bdrc.io/ontology/core#numberOfVolumes": [{ type: "literal", value: "1" }],
      "http://purl.bdrc.io/ontology/core#thumbnailIIIFService": [{ type: "uri", value: "https://iiif.bdrc.io/bdr:I3CN7816::I3CN78160003.tif" }],
      "http://purl.bdrc.io/ontology/core#instanceOf": [{ type: "uri", value: "http://purl.bdrc.io/resource/WA466" }],
    },
  };
  test("title prefers English, script + thumb + work extracted", () => {
    const info = parseInstanceGraph(graph, "MW3CN7814");
    expect(info.title).toBe("Lamrim Chenmo, new print");
    expect(info.publisher).toBe("[s.n.]");
    expect(info.script).toBe("ScriptTibt");
    expect(info.extent).toBe("1 v.");
    expect(info.volumes).toBe(1);
    expect(info.thumb).toContain("iiif.bdrc.io");
    expect(info.work).toBe("WA466");
  });
});

describe("parseVolumes + parseVolumeInfo", () => {
  test("volumes sorted by number; access gate reads AccessOpen vs FairUse", () => {
    const vols = parseVolumes({
      results: {
        bindings: [
          { volnum: { value: "2" }, volid: { value: "http://purl.bdrc.io/resource/I2" } },
          { volnum: { value: "1" }, volid: { value: "http://purl.bdrc.io/resource/I1" } },
        ],
      },
    });
    expect(vols).toEqual([
      { num: 1, id: "I1" },
      { num: 2, id: "I2" },
    ]);
    const open = parseVolumeInfo({
      results: {
        bindings: [
          {
            access: { value: "http://purl.bdrc.io/admindata/AccessOpen" },
            status: { value: "http://purl.bdrc.io/admindata/StatusReleased" },
            ric: { value: "true" },
            volumeNumber: { value: "1" },
            iinstanceId: { value: "http://purl.bdrc.io/resource/W3CN7814" },
          },
        ],
      },
    });
    expect(open?.access).toBe(ACCESS_OPEN);
    expect(open?.restrictedInChina).toBe(true);
    expect(open?.instanceId).toBe("W3CN7814");
    const restricted = parseVolumeInfo({
      results: {
        bindings: [
          {
            access: { value: "http://purl.bdrc.io/admindata/AccessFairUse" },
            volumeNumber: { value: "1" },
            iinstanceId: { value: "http://purl.bdrc.io/resource/W3KG1059" },
          },
        ],
      },
    });
    expect(restricted?.access).toBe("AccessFairUse");
    expect(parseVolumeInfo({ results: { bindings: [] } })).toBeNull();
  });
});

describe("scriptToOcrLang", () => {
  test("Tibetan -> bod, Devanagari -> san", () => {
    expect(scriptToOcrLang("http://purl.bdrc.io/resource/ScriptTibt").lang).toBe("bod");
    expect(scriptToOcrLang("http://purl.bdrc.io/resource/ScriptDeva").lang).toBe("san");
  });
});

describe("urls + allowlist", () => {
  test("manifest url shape; only BDRC hosts and public paths", () => {
    expect(manifestUrl("I3CN7816")).toBe("https://iiifpres.bdrc.io/v:bdr:I3CN7816/manifest");
    expect(blmpUrl("lam rim", "bo-x-ewts", 50)).toContain("format=json");
    expect(isAllowedBdrcUrl("https://ldspdi.bdrc.io/query/table/BLMP?format=json")).toBe(true);
    expect(isAllowedBdrcUrl("https://ldspdi.bdrc.io/query/graph/ResInfo?R_RES=bdr:W1")).toBe(true);
    expect(isAllowedBdrcUrl("https://iiifpres.bdrc.io/v:bdr:I3CN7816/manifest")).toBe(true);
    expect(isAllowedBdrcUrl("https://iiif.bdrc.io/bdr:I3CN7816::I3CN78160003.tif/full/2000,/0/default.jpg")).toBe(true);
    expect(isAllowedBdrcUrl("https://iiif.bdrc.io/download/pdf/v:bdr:I3CN7816::1-")).toBe(false);
    expect(isAllowedBdrcUrl("https://library.bdrc.io/show/bdr:MW3CN7814")).toBe(false);
    expect(isAllowedBdrcUrl("https://evil.example.com/query/table/BLMP")).toBe(false);
  });
});

describe("IIIF v2 labels (BDRC manifests)", () => {
  test("language objects prefer English, else first value", () => {
    expect(
      labelText([
        { "@language": "bo-x-ewts", "@value": "pod/_1" },
        { "@language": "en", "@value": "volume 1" },
      ]),
    ).toBe("volume 1");
    expect(labelText([{ "@language": "bo", "@value": "pod/_1" }])).toBe("pod/_1");
  });
});
