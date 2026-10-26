// DharmaNexus corpora datasource for the desk.
//
// The Dharmamitra API may NOT feed a third-party app (their Terms of
// Service prohibit populating third-party applications from the
// Dharmamitra/DharmaNexus database API), so the desk does NOT call it.
// Instead it reads the corpora the project itself publishes on GitHub
// under public-domain / Creative Commons licensing:
//   Pāli     dharmamitra/dharmanexus-pali     (branch main)
//   Sanskrit dharmamitra/dharmanexus-sanskrit (branch master)
//   Chinese  dharmamitra/dharmanexus-chinese  (branch master)
// Each repo has one catalog file (<LL>_files.json) and one JSON segment
// file per text under segments/<filename>.json. Segments share one
// shape: [{ segmentnr: "<filename>:<key>", original, ... }].
// The corpus filename IS the Dharmamitra reader id (verified: the
// Dhammapada's filename is literally "PA_dhp_", matching
// dharmamitra.org/db/pa/PA_dhp_/text), so every imported page can link
// back to its exact passage on the Dharmamitra reader.
//
// Tibetan has no public corpus repo under this scheme (the docs link
// 404s), so it is not offered here; the desk's BDRC datasource covers
// Tibetan scans instead.

export type CorpusLang = "pa" | "sa" | "zh";

export interface CorpusLangInfo {
  repo: string;
  branch: string;
  token: string;
  filesJson: string;
  label: string;
  ocrLang: string;
  dbLang: string;
}

export const CORPUS_LANGS: Record<CorpusLang, CorpusLangInfo> = {
  pa: {
    repo: "dharmamitra/dharmanexus-pali",
    branch: "main",
    token: "PA",
    filesJson: "PA_files.json",
    label: "Pāli",
    ocrLang: "pli",
    dbLang: "pa",
  },
  sa: {
    repo: "dharmamitra/dharmanexus-sanskrit",
    branch: "master",
    token: "SA",
    filesJson: "SA_files.json",
    label: "Sanskrit",
    ocrLang: "san",
    dbLang: "sa",
  },
  zh: {
    repo: "dharmamitra/dharmanexus-chinese",
    branch: "master",
    token: "ZH",
    filesJson: "ZH_files.json",
    label: "Chinese",
    ocrLang: "zho",
    dbLang: "zh",
  },
};

export const RAW = "https://raw.githubusercontent.com";

/// Corpus filenames: <LL>_<rest>, where rest may contain letters,
/// digits, hyphens and underscores (e.g. PA_dhp_, SA_K14_mavadsuu,
/// PA_atk-s05_02a, ZH_T01_0001_010). The trailing underscore in
/// PA_dhp_ is real — a validator that forbids it breaks the Dhammapada.
export function isCorpusFilename(lang: CorpusLang, filename: string): boolean {
  const info = CORPUS_LANGS[lang];
  if (!info) return false;
  return new RegExp(`^${info.token}_[A-Za-z0-9_\\-]+$`).test(filename);
}

export function isAllowedCorpusUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== "https:" || u.hostname !== "raw.githubusercontent.com") return false;
  const m = u.pathname.match(
    /^\/dharmamitra\/dharmanexus-(pali|sanskrit|chinese)\/(main|master)\/(.+)$/,
  );
  if (!m) return false;
  const [, repoLang, branch, rest] = m;
  const lang = (repoLang === "pali" ? "pa" : repoLang === "sanskrit" ? "sa" : "zh") as CorpusLang;
  const info = CORPUS_LANGS[lang];
  if (branch !== info.branch) return false;
  if (rest === info.filesJson) return true;
  if (rest.startsWith("segments/") && rest.endsWith(".json")) {
    return isCorpusFilename(lang, rest.slice("segments/".length, -".json".length));
  }
  return false;
}

export function catalogUrl(lang: CorpusLang): string {
  const info = CORPUS_LANGS[lang];
  return `${RAW}/${info.repo}/${info.branch}/${info.filesJson}`;
}

export function segmentUrl(lang: CorpusLang, filename: string): string {
  const info = CORPUS_LANGS[lang];
  return `${RAW}/${info.repo}/${info.branch}/segments/${filename}.json`;
}

export function readerUrl(lang: CorpusLang, filename: string): string {
  return `https://dharmamitra.org/db/${CORPUS_LANGS[lang].dbLang}/${filename}/text`;
}

export function passageUrl(lang: CorpusLang, filename: string, segmentnr: string): string {
  return `${readerUrl(lang, filename)}?active_segment=${encodeURIComponent(segmentnr)}`;
}

export async function fetchCorpusJson(
  url: string,
  fetchFn: typeof fetch = fetch,
): Promise<unknown> {
  if (!isAllowedCorpusUrl(url)) {
    throw new Error(`Refusing to fetch non-corpus URL: ${url}`);
  }
  let res: Response;
  try {
    res = await fetchFn(url);
  } catch {
    throw new Error(`Could not reach ${url} — is the network up?`);
  }
  if (!res.ok) throw new Error(`Corpus server returned ${res.status} for ${url}`);
  return await res.json();
}

// ---- catalog ----

export interface CatalogEntry {
  displayName: string;
  textname: string;
  filename: string;
  category: string;
  collection: string;
  author: string;
  sourceLink: string;
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");

export function parseCatalog(json: unknown): CatalogEntry[] {
  if (!Array.isArray(json)) throw new Error("Catalog is not a JSON array.");
  return json
    .map((e) => {
      const r = (e ?? {}) as Record<string, unknown>;
      return {
        displayName: str(r.displayName),
        textname: str(r.textname),
        filename: str(r.filename),
        category: str(r.category),
        collection: str(r.collection),
        author: str(r.author),
        sourceLink: str(r.link) || str(r.link2) || str(r.cbeta_link),
      };
    })
    .filter((e) => e.filename);
}

// The catalogs are large (Pāli ~1.6MB, Sanskrit ~12MB, Chinese ~26MB),
// so the server caches each language's parsed catalog for an hour.
const catalogCache = new Map<string, { at: number; items: CatalogEntry[] }>();
const CATALOG_TTL_MS = 3600_000;

/// Test hook: drop all cached catalogs so a test can count fetches.
export function clearCatalogCache(): void {
  catalogCache.clear();
}

export async function fetchCatalog(
  lang: CorpusLang,
  fetchFn: typeof fetch = fetch,
): Promise<CatalogEntry[]> {
  const hit = catalogCache.get(lang);
  if (hit && Date.now() - hit.at < CATALOG_TTL_MS) return hit.items;
  const items = parseCatalog(await fetchCorpusJson(catalogUrl(lang), fetchFn));
  catalogCache.set(lang, { at: Date.now(), items });
  return items;
}

// ---- segments ----

export interface Segment {
  segmentnr: string;
  original: string;
  cbetaLink?: string;
}

export const MAX_SEGMENTS = 100_000;

export function parseSegments(json: unknown): Segment[] {
  if (!Array.isArray(json)) throw new Error("Segment file is not a JSON array.");
  const out: Segment[] = [];
  for (const e of json) {
    const r = (e ?? {}) as Record<string, unknown>;
    const original = str(r.original);
    const segmentnr = str(r.segmentnr);
    if (!original.trim() || !segmentnr) continue;
    const link = str(r.cbeta_link);
    out.push(link ? { segmentnr, original, cbetaLink: link } : { segmentnr, original });
  }
  if (out.length > MAX_SEGMENTS) {
    throw new Error(
      `Text has ${out.length} segments — over the ${MAX_SEGMENTS} import cap.`,
    );
  }
  return out;
}

// ---- paging ----
// A desk page is a run of consecutive segments: at most 25 segments or
// ~1800 characters, whichever comes first. The page keeps the first
// segment's id so it can link back to its exact passage on Dharmamitra.

export interface TextPage {
  text: string;
  firstSegmentnr: string;
}

export const PAGE_MAX_SEGMENTS = 25;
export const PAGE_MAX_CHARS = 1800;

export function chunkSegments(segments: Segment[]): TextPage[] {
  const pages: TextPage[] = [];
  let cur: Segment[] = [];
  let chars = 0;
  const flush = () => {
    if (!cur.length) return;
    pages.push({
      text: cur.map((s) => s.original).join("\n"),
      firstSegmentnr: cur[0].segmentnr,
    });
    cur = [];
    chars = 0;
  };
  for (const s of segments) {
    if (
      cur.length > 0 &&
      (cur.length >= PAGE_MAX_SEGMENTS || chars + s.original.length > PAGE_MAX_CHARS)
    ) {
      flush();
    }
    cur.push(s);
    chars += s.original.length;
  }
  flush();
  return pages;
}

/// Replay chunkSegments' boundaries to find which 1-based desk page a
/// segment lands on (0 when absent). Used so a CBETA resolve can open
/// an imported text at the exact page of the passage.
export function pageIndexForSegment(segments: Segment[], segmentnr: string): number {
  let page = 1;
  let count = 0;
  let chars = 0;
  for (const s of segments) {
    if (count > 0 && (count >= PAGE_MAX_SEGMENTS || chars + s.original.length > PAGE_MAX_CHARS)) {
      page++;
      count = 0;
      chars = 0;
    }
    if (s.segmentnr === segmentnr) return page;
    count++;
    chars += s.original.length;
  }
  return 0;
}

// ---- volume scan (CBETA resolve) ----

export interface PageHit {
  textname: string;
  filename: string;
  displayName: string;
  ordinal: number;
  segmentnr: string;
  original: string;
  prev: string[];
  next: string[];
  cbetaLink: string;
}

export const MAX_SCAN_FILES = 120;

/// Find a page key inside one corpus volume (category like "X20").
/// Pages run continuously through a volume, so scanning the volume's
/// texts in catalogue order finds the passage even when the citation's
/// text number is missing or wrong. Stops at the first hit; the cap
/// bounds the worst case for the largest volumes.
export async function findPageInVolume(
  category: string,
  pageKey: string,
  preferTextname: string | null,
  fetchFn: typeof fetch = fetch,
): Promise<{ hit: PageHit | null; searchedFiles: number }> {
  const items = await fetchCatalog("zh", fetchFn);
  const vol = items.filter((e) => e.category === category);
  const names: string[] = [];
  for (const e of vol) {
    if (!names.includes(e.textname)) names.push(e.textname);
  }
  if (preferTextname && names.includes(preferTextname)) {
    names.splice(names.indexOf(preferTextname), 1);
    names.unshift(preferTextname);
  }
  let searchedFiles = 0;
  for (const textname of names) {
    const files = vol
      .filter((e) => e.textname === textname)
      .map((e) => e.filename)
      .sort();
    const ordinal = names.indexOf(textname) + 1;
    for (const file of files) {
      if (searchedFiles >= MAX_SCAN_FILES) return { hit: null, searchedFiles };
      const segments = parseSegments(await fetchCorpusJson(segmentUrl("zh", file), fetchFn));
      searchedFiles++;
      const idx = segments.findIndex((s) => {
        const key = s.segmentnr.split(":").pop() || "";
        return key === pageKey || key.startsWith(pageKey + "_");
      });
      if (idx >= 0) {
        const displayName = vol.find((e) => e.textname === textname)?.displayName || textname;
        return {
          hit: {
            textname,
            filename: file,
            displayName,
            ordinal,
            segmentnr: segments[idx].segmentnr,
            original: segments[idx].original,
            prev: segments.slice(Math.max(0, idx - 2), idx).map((s) => s.original),
            next: segments.slice(idx + 1, idx + 3).map((s) => s.original),
            cbetaLink: segments[idx].cbetaLink || "",
          },
          searchedFiles,
        };
      }
    }
  }
  return { hit: null, searchedFiles };
}
