// BDRC (Buddhist Digital Resource Center) datasource for the desk.
// Unlike UTokyo's fixed IIIF collection, BDRC is a live catalogue:
//   search (BLMP literal match) -> instance (MW) or work (W)
//   -> volumes (I) -> IIIF manifest per volume -> page images.
// Access is enforced per volume via IIIFPres_volumeInfo: only
// adm:access = AccessOpen volumes are ever downloaded. Restricted
// (AccessFairUse) volumes still serve a manifest — a 40-page extract —
// so the manifest alone is NOT an access gate; the volumeInfo check is.
//
// Security: the server only fetches the three BDRC hosts below, on the
// documented public query paths. Anything else is refused.

export const LDSPDI = "https://ldspdi.bdrc.io";
export const IIIFPRES = "https://iiifpres.bdrc.io";
export const IIIF = "https://iiif.bdrc.io";
export const LIBRARY = "https://library.bdrc.io";

export const ACCESS_OPEN = "AccessOpen";

export function isAllowedBdrcUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== "https:") return false;
  if (u.hostname === "ldspdi.bdrc.io") {
    return u.pathname.startsWith("/query/table/") || u.pathname.startsWith("/query/graph/");
  }
  if (u.hostname === "iiifpres.bdrc.io") {
    return u.pathname.startsWith("/v:bdr:");
  }
  if (u.hostname === "iiif.bdrc.io") {
    return u.pathname.startsWith("/bdr:");
  }
  return false;
}

export function manifestUrl(volumeId: string): string {
  return `${IIIFPRES}/v:bdr:${volumeId}/manifest`;
}

export function libraryUrl(instanceId: string): string {
  return `${LIBRARY}/show/bdr:${instanceId}`;
}

/// BDRC ids: MW... instance, W... work, I... volume/image group.
/// Search hits often carry a suffix (outline node, etext chunk) after
/// the base id, e.g. MW2046_C2FE67 — the importable unit is the base.
export function baseId(id: string): string {
  const m = id.match(/^(MW|W|I)[A-Za-z0-9]+/);
  return m ? m[0] : id;
}

export type BdrcKind = "instance" | "work" | "volume" | "other";

export function kindOf(id: string): BdrcKind {
  const b = baseId(id);
  if (/^MW/.test(b)) return "instance";
  if (/^I/.test(b)) return "volume";
  if (/^W/.test(b)) return "work";
  return "other";
}

export function isDirectId(q: string): boolean {
  return /^(MW|W|I)[A-Za-z0-9]+$/.test(q.trim());
}

/// Script URI (e.g. .../ScriptTibt) -> desk OCR language. BDRC is
/// mostly Tibetan; Devanagari maps to Sanskrit; anything else keeps
/// the Tibetan default and the UI says the guess came from the script.
export function scriptToOcrLang(scriptUri: string): { lang: string; script: string } {
  if (scriptUri.includes("ScriptDeva")) return { lang: "san", script: "Devanagari" };
  if (scriptUri.includes("ScriptTibt")) return { lang: "bod", script: "Tibetan" };
  if (scriptUri.includes("ScriptLatn")) return { lang: "bod", script: "Latin" };
  return { lang: "bod", script: scriptUri.split("/").pop() || "" };
}

export async function fetchBdrcJson(
  url: string,
  fetchFn: typeof fetch = fetch,
): Promise<unknown> {
  if (!isAllowedBdrcUrl(url)) {
    throw new Error(`Refusing to fetch non-BDRC URL: ${url}`);
  }
  let res: Response;
  try {
    res = await fetchFn(url, { headers: { accept: "application/json" } });
  } catch {
    throw new Error(`Could not reach ${url} — is the network up?`);
  }
  if (!res.ok) throw new Error(`BDRC returned ${res.status} for ${url}`);
  return await res.json();
}

// ---- search (BLMP literal match) ----

export interface SearchHit {
  id: string;
  kind: BdrcKind;
  literal: string;
  lang: string;
}

export function parseBlmp(json: unknown): SearchHit[] {
  const root = (json ?? {}) as Record<string, unknown>;
  const results = (root.results ?? {}) as Record<string, unknown>;
  const bindings = Array.isArray(results.bindings) ? results.bindings : [];
  const out: SearchHit[] = [];
  const seen = new Set<string>();
  for (const b of bindings) {
    const row = b as Record<string, Record<string, unknown>>;
    const uri = typeof row.s?.value === "string" ? (row.s.value as string) : "";
    const short = uri.replace("http://purl.bdrc.io/resource/", "");
    const id = baseId(short);
    const kind = kindOf(id);
    if (kind === "other" || seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      kind,
      literal: typeof row.lit?.value === "string" ? (row.lit.value as string) : "",
      lang: typeof row.lit?.["xml:lang"] === "string" ? (row.lit["xml:lang"] as string) : "",
    });
  }
  return out;
}

export function blmpUrl(query: string, lang: string, limit: number): string {
  const clean = query.replace(/["()]/g, " ").trim();
  return (
    `${LDSPDI}/query/table/BLMP?L_NAME=(${encodeURIComponent(`"${clean}"`)})` +
    `&LG_NAME=${encodeURIComponent(lang)}&I_LIM=${limit}&format=json`
  );
}

// ---- instance graph (ResInfo-SameAs_MW) ----

type GraphNode = Record<string, { type: string; value: string; lang?: string }[]>;

function predEnds(node: GraphNode, suffix: string): { type: string; value: string; lang?: string }[] {
  for (const key of Object.keys(node)) {
    if (key.endsWith(suffix)) return node[key];
  }
  return [];
}

function literalValue(
  vals: { value: string; lang?: string }[],
  preferEn = true,
): string {
  if (!vals.length) return "";
  if (preferEn) {
    const en = vals.find((v) => v.lang === "en");
    if (en) return en.value;
  }
  return vals[0].value;
}

export interface InstanceInfo {
  id: string;
  title: string;
  publisher: string;
  location: string;
  script: string;
  printMethod: string;
  extent: string;
  volumes: number;
  thumb: string;
  work: string;
}

export function parseInstanceGraph(json: unknown, id: string): InstanceInfo {
  const graph = (json ?? {}) as Record<string, GraphNode>;
  const node = graph[`http://purl.bdrc.io/resource/${id}`] ?? {};
  const uriShort = (v: string) => v.replace("http://purl.bdrc.io/resource/", "");
  return {
    id,
    title: literalValue(predEnds(node, "prefLabel")),
    publisher: literalValue(predEnds(node, "publisherName"), false),
    location: literalValue(predEnds(node, "publisherLocation"), false),
    script: uriShort(literalValue(predEnds(node, "script"), false)),
    printMethod: uriShort(literalValue(predEnds(node, "printMethod"), false)),
    extent: literalValue(predEnds(node, "extentStatement"), false),
    volumes: Number(literalValue(predEnds(node, "numberOfVolumes"), false)) || 0,
    thumb: literalValue(predEnds(node, "thumbnailIIIFService"), false),
    work: uriShort(literalValue(predEnds(node, "instanceOf"), false)),
  };
}

// ---- volumes ----

export interface VolumeRef {
  num: number;
  id: string;
}

export function parseVolumes(json: unknown): VolumeRef[] {
  const root = (json ?? {}) as Record<string, unknown>;
  const results = (root.results ?? {}) as Record<string, unknown>;
  const bindings = Array.isArray(results.bindings) ? results.bindings : [];
  return bindings
    .map((b) => {
      const row = b as Record<string, Record<string, unknown>>;
      const id = typeof row.volid?.value === "string" ? (row.volid.value as string) : "";
      const num = Number(row.volnum?.value ?? 0) || 0;
      return { num, id: id.replace("http://purl.bdrc.io/resource/", "") };
    })
    .filter((v) => v.id)
    .sort((a, b) => a.num - b.num);
}

export interface VolumeInfo {
  volume: string;
  access: string;
  status: string;
  restrictedInChina: boolean;
  volumeNumber: number;
  instanceId: string;
}

export function parseVolumeInfo(json: unknown): VolumeInfo | null {
  const root = (json ?? {}) as Record<string, unknown>;
  const results = (root.results ?? {}) as Record<string, unknown>;
  const bindings = Array.isArray(results.bindings) ? results.bindings : [];
  const row = (bindings[0] ?? {}) as Record<string, Record<string, unknown>>;
  if (!row.access) return null;
  const short = (v: unknown) =>
    typeof v === "string" ? v.replace("http://purl.bdrc.io/admindata/", "").replace("http://purl.bdrc.io/resource/", "") : "";
  return {
    volume: "",
    access: short(row.access.value),
    status: short(row.status?.value),
    restrictedInChina: row.ric?.value === "true",
    volumeNumber: Number(row.volumeNumber?.value ?? 0) || 0,
    instanceId: short(row.iinstanceId?.value),
  };
}

export function volumesForUrl(id: string, kind: BdrcKind): string {
  const q = kind === "work" ? "volumesForWork" : "volumesForInstance";
  return `${LDSPDI}/query/table/${q}?R_RES=bdr:${id}&format=json`;
}

export function volumeInfoUrl(volumeId: string): string {
  return `${LDSPDI}/query/table/IIIFPres_volumeInfo?R_RES=bdr:${volumeId}&format=json`;
}

export function instanceGraphUrl(instanceId: string): string {
  return `${LDSPDI}/query/graph/ResInfo-SameAs_MW?R_RES=bdr:${instanceId}`;
}
