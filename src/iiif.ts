// IIIF datasource: UTokyo Database for Sanskrit Manuscripts.
// The site is a single-page app with no working search API, but it
// publishes a full IIIF Collection (Presentation API 3) listing every
// manifest, and each manifest (Presentation API 2) carries the record
// metadata plus one canvas per page image on a IIIF Image API 2 server.
// The desk harvests that: collection -> manifest -> page images.
//
// Security: the server only ever fetches the two UTokyo/DHII hosts below.
// A manifest URL or image service URL from anywhere else is refused, so
// the import endpoint can never be used as an open proxy.

export const COLLECTION_URL =
  "https://dzkimgs.l.u-tokyo.ac.jp/iiif/skt2020/collection3.json";
export const MIRADOR_BASE = "https://dzkimgs.l.u-tokyo.ac.jp/mirador3/";

/// Width requested for imported page images. Full-resolution pages are
/// ~10000px wide (tens of MB each); 2000px is plenty for OCR and study,
// keeps a manuscript to a manageable size, and full resolution stays one
// Mirador click away.
export const IMPORT_WIDTH = 2000;

export function isAllowedFetchUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== "https:") return false;
  if (u.hostname === "dzkimgs.l.u-tokyo.ac.jp") {
    return u.pathname.startsWith("/iiif/skt2020/");
  }
  if (u.hostname === "imgsrv.dhii.jp") {
    return u.pathname.startsWith("/iiifimgs/skt2020/");
  }
  return false;
}

export function miradorUrl(manifestUrl: string): string {
  return `${MIRADOR_BASE}?sideBarPanel=info&manifest=${encodeURIComponent(manifestUrl)}`;
}

/// IIIF label: a plain string, or a language map like {en: ["..."]}.
export function labelText(v: unknown): string {
  if (typeof v === "string") return v;
  if (Array.isArray(v)) {
    for (const item of v) {
      const s = labelText(item);
      if (s) return s;
    }
    return "";
  }
  if (v && typeof v === "object") {
    const m = v as Record<string, unknown>;
    for (const key of ["en", "none", "ja"]) {
      const s = labelText(m[key]);
      if (s) return s;
    }
    for (const key of Object.keys(m)) {
      const s = labelText(m[key]);
      if (s) return s;
    }
  }
  return "";
}

export interface CollectionItem {
  manifest: string;
  title: string;
}

export interface ParsedCollection {
  title: string;
  attribution: string;
  items: CollectionItem[];
}

export function parseCollection(json: unknown): ParsedCollection {
  const root = (json ?? {}) as Record<string, unknown>;
  const items = Array.isArray(root.items) ? root.items : [];
  return {
    title: labelText(root.label) || "UTokyo Sanskrit Manuscripts",
    attribution: labelText(
      (root.requiredStatement as Record<string, unknown> | undefined)?.value,
    ),
    items: items
      .map((it) => {
        const m = (it ?? {}) as Record<string, unknown>;
        const id = typeof m.id === "string" ? m.id : typeof m["@id"] === "string" ? (m["@id"] as string) : "";
        return { manifest: id, title: labelText(m.label) || id };
      })
      .filter((it) => it.manifest),
  };
}

export interface ManifestCanvas {
  label: string;
  canvas: string;
  thumb: string;
  service: string;
  full: string;
  sized: string;
}

export interface ParsedManifest {
  id: string;
  label: string;
  title: string;
  metadata: { label: string; value: string }[];
  license: string;
  attribution: string;
  seeAlso: string;
  canvases: ManifestCanvas[];
}

export function parseManifest(json: unknown): ParsedManifest {
  const root = (json ?? {}) as Record<string, unknown>;
  const id =
    typeof root["@id"] === "string"
      ? (root["@id"] as string)
      : typeof root.id === "string"
        ? root.id
        : "";
  const metadata = Array.isArray(root.metadata)
    ? (root.metadata as Record<string, unknown>[]).map((m) => ({
        label: String(m.label ?? ""),
        value: String(m.value ?? ""),
      }))
    : [];
  const metaValue = (label: string): string =>
    metadata.find((m) => m.label === label)?.value ?? "";
  const sequences = Array.isArray(root.sequences) ? root.sequences : [];
  const canvases: ManifestCanvas[] = [];
  for (const seq of sequences) {
    const list = Array.isArray((seq as Record<string, unknown>).canvases)
      ? ((seq as Record<string, unknown>).canvases as Record<string, unknown>[])
      : [];
    for (const c of list) {
      const images = Array.isArray(c.images) ? c.images : [];
      const resource = (images[0]?.resource ?? {}) as Record<string, unknown>;
      const service = (resource.service ?? {}) as Record<string, unknown>;
      const serviceId =
        typeof service["@id"] === "string"
          ? (service["@id"] as string)
          : typeof service.id === "string"
            ? (service.id as string)
            : "";
      const full = typeof resource["@id"] === "string" ? (resource["@id"] as string) : "";
      if (!serviceId && !full) continue;
      const thumbObj = (c.thumbnail ?? {}) as Record<string, unknown>;
      const thumb =
        typeof thumbObj["@id"] === "string"
          ? (thumbObj["@id"] as string)
          : serviceId
            ? `${serviceId}/full/256,/0/default.jpg`
            : "";
      canvases.push({
        label: typeof c.label === "string" ? c.label : "",
        canvas: typeof c["@id"] === "string" ? (c["@id"] as string) : "",
        thumb,
        service: serviceId,
        full,
        sized: serviceId ? `${serviceId}/full/${IMPORT_WIDTH},/0/default.jpg` : full,
      });
    }
  }
  return {
    id,
    label: typeof root.label === "string" ? root.label : labelText(root.label),
    title: metaValue("title") || (typeof root.label === "string" ? root.label : labelText(root.label)),
    metadata,
    license: typeof root.license === "string" ? root.license : "",
    attribution: typeof root.attribution === "string" ? root.attribution : "",
    seeAlso:
      typeof (root.seeAlso as Record<string, unknown> | undefined)?.["@id"] === "string"
        ? ((root.seeAlso as Record<string, unknown>)["@id"] as string)
        : "",
    canvases,
  };
}

export async function fetchJson(
  url: string,
  fetchFn: typeof fetch = fetch,
): Promise<unknown> {
  if (!isAllowedFetchUrl(url)) {
    throw new Error(`Refusing to fetch non-UTokyo URL: ${url}`);
  }
  let res: Response;
  try {
    res = await fetchFn(url, { headers: { accept: "application/json" } });
  } catch {
    throw new Error(`Could not reach ${url} — is the network up?`);
  }
  if (!res.ok) throw new Error(`Upstream returned ${res.status} for ${url}`);
  return await res.json();
}
