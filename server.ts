// Sutra Research Study Desk server: Bun + zero deps + SQLite.
// Serves the desk UI, stores uploads under SUTRA_DATA (default ./data),
// runs local OCR (tesseract) and translation (the user's own Ollama).
// No model is ever downloaded; Ollama URL + model live in Settings.

import { Database } from "bun:sqlite";
import { join, basename, resolve, extname } from "path";
import { mkdirSync, existsSync, rmSync } from "fs";
import {
  initDb,
  createDoc,
  addPage,
  listDocs,
  getDoc,
  getDocBySourceUrl,
  updateDocSourceUrl,
  getPages,
  getPage,
  updatePage,
  deleteDoc,
  clearPages,
  getSetting,
  setSetting,
  dataDirPath,
} from "./src/db.ts";
import {
  OCR_LANGS,
  langLabel,
  toolAvailable,
  tesseractLangs,
  ocrImage,
  pdfText,
  pdfPageCount,
  renderPdfPages,
} from "./src/ocr.ts";
import { translateText, listModels } from "./src/translate.ts";
import {
  COLLECTION_URL,
  IMPORT_WIDTH,
  fetchJson,
  isAllowedFetchUrl,
  miradorUrl,
  parseCollection,
  parseManifest,
} from "./src/iiif.ts";
import {
  ACCESS_OPEN,
  blmpUrl,
  fetchBdrcJson,
  instanceGraphUrl,
  isAllowedBdrcUrl,
  isDirectId,
  kindOf,
  libraryUrl,
  manifestUrl as bdrcManifestUrl,
  parseBlmp,
  parseInstanceGraph,
  parseVolumeInfo,
  parseVolumes,
  scriptToOcrLang,
  volumeInfoUrl,
  volumesForUrl,
} from "./src/bdrc.ts";
import {
  CORPUS_LANGS,
  type CorpusLang,
  chunkSegments,
  fetchCatalog,
  fetchCorpusJson,
  findPageInVolume,
  isCorpusFilename,
  pageIndexForSegment,
  parseSegments,
  passageUrl,
  readerUrl,
  segmentUrl,
} from "./src/corpus.ts";
import {
  cbetaPassageUrl,
  cbetaTextUrl,
  parseCbetaRef,
} from "./src/cbeta.ts";

const ROOT = import.meta.dir;
const DATA = dataDirPath(ROOT);
mkdirSync(DATA, { recursive: true });
const db: Database = initDb(join(DATA, "sutra.db"));

const PORT = Number(process.env.SUTRA_PORT || 3043);
const TYPES: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".pdf": "application/pdf",
  ".svg": "image/svg+xml",
};

const IMG_EXTS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function readJson(req: Request): Promise<Record<string, unknown>> {
  try {
    return (await req.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function docDir(id: number): string {
  return join(DATA, "docs", String(id));
}

function ollamaUrl(): string {
  return getSetting(db, "ollama_url", process.env.OLLAMA_URL || "http://localhost:11434");
}

function ollamaModel(): string {
  return getSetting(db, "ollama_model", process.env.OLLAMA_MODEL || "");
}

async function toolsStatus() {
  const [tess, pdftotext, pdftoppm, pdfinfo, langs] = await Promise.all([
    toolAvailable("tesseract"),
    toolAvailable("pdftotext"),
    toolAvailable("pdftoppm"),
    toolAvailable("pdfinfo"),
    tesseractLangs(),
  ]);
  let ollamaOk = false;
  try {
    await listModels(ollamaUrl());
    ollamaOk = true;
  } catch {
    ollamaOk = false;
  }
  return {
    tesseract: tess,
    tesseract_langs: langs,
    pdftotext,
    pdftoppm,
    pdfinfo,
    ollama_url: ollamaUrl(),
    ollama_ok: ollamaOk,
    ollama_model: ollamaModel(),
  };
}

Bun.serve({
  port: PORT,
  hostname: "127.0.0.1",
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;

    try {
      // ---- static ----
      if (method === "GET" && path === "/") {
        return new Response(Bun.file(join(ROOT, "public", "index.html")), {
          headers: { "content-type": "text/html" },
        });
      }
      if (method === "GET" && path.startsWith("/public/")) {
        const file = Bun.file(join(ROOT, path.slice(1)));
        if (!(await file.exists())) return new Response("Not found", { status: 404 });
        return new Response(file, {
          headers: { "content-type": TYPES[extname(path)] || "application/octet-stream" },
        });
      }
      if (method === "GET" && path.startsWith("/files/")) {
        const rel = path.slice("/files/".length);
        const abs = resolve(join(DATA, rel));
        if (!abs.startsWith(resolve(DATA)) || !existsSync(abs)) {
          return new Response("Not found", { status: 404 });
        }
        return new Response(Bun.file(abs), {
          headers: { "content-type": TYPES[extname(abs)] || "application/octet-stream" },
        });
      }

      // ---- tools + settings ----
      if (method === "GET" && path === "/api/tools") {
        return json(await toolsStatus());
      }
      if (method === "GET" && path === "/api/settings") {
        return json({ ollama_url: ollamaUrl(), ollama_model: ollamaModel() });
      }
      if (method === "PATCH" && path === "/api/settings") {
        const body = await readJson(req);
        if (typeof body.ollama_url === "string" && body.ollama_url.trim()) {
          setSetting(db, "ollama_url", body.ollama_url.trim());
        }
        if (typeof body.ollama_model === "string") {
          setSetting(db, "ollama_model", body.ollama_model.trim());
        }
        return json({ ollama_url: ollamaUrl(), ollama_model: ollamaModel() });
      }
      if (method === "GET" && path === "/api/models") {
        try {
          return json({ models: await listModels(ollamaUrl()) });
        } catch (e) {
          return json({ error: (e as Error).message }, 502);
        }
      }

      // ---- datasources: UTokyo Sanskrit Manuscripts (IIIF) ----
      if (method === "GET" && path === "/api/datasources/utokyo") {
        try {
          const coll = parseCollection(await fetchJson(COLLECTION_URL));
          return json(coll);
        } catch (e) {
          return json({ error: (e as Error).message }, 502);
        }
      }
      if (method === "GET" && path === "/api/datasources/utokyo/manifest") {
        const manifestUrl = url.searchParams.get("url") || "";
        if (!isAllowedFetchUrl(manifestUrl)) {
          return json({ error: "Only UTokyo Sanskrit Manuscripts manifests are allowed." }, 400);
        }
        try {
          const m = parseManifest(await fetchJson(manifestUrl));
          return json({ ...m, mirador: miradorUrl(manifestUrl) });
        } catch (e) {
          return json({ error: (e as Error).message }, 502);
        }
      }
      if (method === "POST" && path === "/api/datasources/utokyo/import") {
        const body = await readJson(req);
        const manifestUrl = typeof body.manifest === "string" ? body.manifest : "";
        if (!isAllowedFetchUrl(manifestUrl)) {
          return json({ error: "Only UTokyo Sanskrit Manuscripts manifests are allowed." }, 400);
        }
        // Idempotent: re-importing a manuscript already in the library
        // returns the existing document instead of duplicating it.
        const existing = getDocBySourceUrl(db, manifestUrl);
        if (existing) {
          return json({ doc: existing, pages: getPages(db, existing.id), already: true });
        }
        let m;
        try {
          m = parseManifest(await fetchJson(manifestUrl));
        } catch (e) {
          return json({ error: (e as Error).message }, 502);
        }
        if (m.canvases.length === 0) {
          return json({ error: "This manuscript has no page images." }, 502);
        }
        const docId = createDoc(db, {
          title: m.title || m.label || "UTokyo manuscript",
          source_type: "image",
          filename: manifestUrl,
          file_path: "",
          ocr_lang: "san",
          source_url: manifestUrl,
          source_name: "UTokyo Sanskrit Manuscripts (CC BY 4.0)",
        });
        const dir = docDir(docId);
        mkdirSync(dir, { recursive: true });
        const failures: string[] = [];
        for (let i = 0; i < m.canvases.length; i++) {
          const canvas = m.canvases[i];
          const pageNo = i + 1;
          try {
            if (!isAllowedFetchUrl(canvas.sized)) {
              throw new Error("image URL outside the UTokyo hosts");
            }
            const res = await fetch(canvas.sized);
            if (!res.ok) throw new Error(`image server returned ${res.status}`);
            const rel = `docs/${docId}/page-${pageNo}.jpg`;
            await Bun.write(join(dir, `page-${pageNo}.jpg`), await res.arrayBuffer());
            addPage(db, docId, pageNo, rel);
          } catch (e) {
            failures.push(`page ${pageNo} (${canvas.label}): ${(e as Error).message}`);
          }
        }
        const pages = getPages(db, docId);
        if (pages.length === 0) {
          deleteDoc(db, docId);
          rmSync(dir, { recursive: true, force: true });
          return json({ error: `Import failed: ${failures.join("; ")}` }, 502);
        }
        db.query(`UPDATE documents SET file_path = ? WHERE id = ?`).run(
          pages[0].image_path,
          docId,
        );
        return json(
          { doc: getDoc(db, docId), pages, failures, import_width: IMPORT_WIDTH },
          201,
        );
      }

      // ---- datasources: BDRC Library (live catalogue + IIIF) ----
      if (method === "GET" && path === "/api/datasources/bdrc/search") {
        const q = (url.searchParams.get("q") || "").trim();
        if (!q) return json({ error: "Empty search." }, 400);
        if (isDirectId(q)) {
          return json({ direct: kindOf(q), id: q });
        }
        try {
          // Literal match in Tibetan (EWTS) and in English; merge, dedupe.
          const [bo, en] = await Promise.allSettled([
            fetchBdrcJson(blmpUrl(q, "bo-x-ewts", 50)),
            fetchBdrcJson(blmpUrl(q, "en", 50)),
          ]);
          const hits = new Map<string, { id: string; kind: string; literal: string; lang: string }>();
          for (const r of [bo, en]) {
            if (r.status !== "fulfilled") continue;
            for (const h of parseBlmp(r.value)) {
              if (!hits.has(h.id)) hits.set(h.id, h);
            }
          }
          return json({ hits: [...hits.values()].slice(0, 50) });
        } catch (e) {
          return json({ error: (e as Error).message }, 502);
        }
      }
      if (method === "GET" && path === "/api/datasources/bdrc/instance") {
        const id = url.searchParams.get("id") || "";
        if (!/^MW[A-Za-z0-9]+$/.test(id)) {
          return json({ error: "Not a BDRC instance id." }, 400);
        }
        try {
          const [graph, vols] = await Promise.all([
            fetchBdrcJson(instanceGraphUrl(id)),
            fetchBdrcJson(volumesForUrl(id, "instance")),
          ]);
          const info = parseInstanceGraph(graph, id);
          const volumes = parseVolumes(vols);
          const withAccess = await Promise.all(
            volumes.map(async (v) => {
              try {
                const vi = parseVolumeInfo(await fetchBdrcJson(volumeInfoUrl(v.id)));
                return { ...v, access: vi?.access ?? "unknown", status: vi?.status ?? "", restrictedInChina: vi?.restrictedInChina ?? false, manifest: bdrcManifestUrl(v.id) };
              } catch {
                return { ...v, access: "unknown", status: "", restrictedInChina: false, manifest: bdrcManifestUrl(v.id) };
              }
            }),
          );
          const ocr = scriptToOcrLang(info.script);
          return json({ info, volumes: withAccess, library: libraryUrl(id), ocr_lang: ocr.lang, script_label: ocr.script });
        } catch (e) {
          return json({ error: (e as Error).message }, 502);
        }
      }
      if (method === "GET" && path === "/api/datasources/bdrc/work") {
        const id = url.searchParams.get("id") || "";
        if (!/^W[A-Za-z0-9]+$/.test(id)) {
          return json({ error: "Not a BDRC work id." }, 400);
        }
        try {
          const [graph, vols] = await Promise.allSettled([
            fetchBdrcJson(`https://ldspdi.bdrc.io/query/graph/ResInfo?R_RES=bdr:${id}`),
            fetchBdrcJson(volumesForUrl(id, "work")),
          ]);
          const title =
            graph.status === "fulfilled" ? parseInstanceGraph(graph.value, id).title : "";
          const volumes = vols.status === "fulfilled" ? parseVolumes(vols.value) : [];
          const withAccess = await Promise.all(
            volumes.map(async (v) => {
              try {
                const vi = parseVolumeInfo(await fetchBdrcJson(volumeInfoUrl(v.id)));
                return { ...v, access: vi?.access ?? "unknown", status: vi?.status ?? "", restrictedInChina: vi?.restrictedInChina ?? false, manifest: bdrcManifestUrl(v.id) };
              } catch {
                return { ...v, access: "unknown", status: "", restrictedInChina: false, manifest: bdrcManifestUrl(v.id) };
              }
            }),
          );
          return json({ id, title, volumes: withAccess, library: libraryUrl(id) });
        } catch (e) {
          return json({ error: (e as Error).message }, 502);
        }
      }
      if (method === "GET" && path === "/api/datasources/bdrc/volume") {
        const id = url.searchParams.get("id") || "";
        if (!/^I[A-Za-z0-9]+$/.test(id)) {
          return json({ error: "Not a BDRC volume id." }, 400);
        }
        try {
          const [viJson, manJson] = await Promise.all([
            fetchBdrcJson(volumeInfoUrl(id)),
            fetchBdrcJson(bdrcManifestUrl(id)),
          ]);
          const vi = parseVolumeInfo(viJson);
          const m = parseManifest(manJson);
          return json({
            volume: id,
            info: vi,
            label: m.label,
            canvases: m.canvases,
            manifest: bdrcManifestUrl(id),
            library: vi?.instanceId ? libraryUrl(vi.instanceId) : null,
          });
        } catch (e) {
          return json({ error: (e as Error).message }, 502);
        }
      }
      if (method === "POST" && path === "/api/datasources/bdrc/import") {
        const body = await readJson(req);
        const volume = typeof body.volume === "string" ? body.volume : "";
        const title = typeof body.title === "string" && body.title.trim() ? body.title.trim() : "";
        const ocrLang = typeof body.ocr_lang === "string" && OCR_LANGS[body.ocr_lang] ? body.ocr_lang : "bod";
        if (!/^I[A-Za-z0-9]+$/.test(volume)) {
          return json({ error: "Not a BDRC volume id." }, 400);
        }
        const manifest = bdrcManifestUrl(volume);
        // Access gate FIRST: restricted volumes serve an extract manifest,
        // so the manifest alone must never authorize a download.
        let vi;
        try {
          vi = parseVolumeInfo(await fetchBdrcJson(volumeInfoUrl(volume)));
        } catch (e) {
          return json({ error: (e as Error).message }, 502);
        }
        if (!vi || vi.access !== ACCESS_OPEN) {
          return json(
            { error: `This volume is not open access (access: ${vi?.access ?? "unknown"}) — BDRC does not offer it for download.` },
            403,
          );
        }
        const existing = getDocBySourceUrl(db, manifest);
        if (existing) {
          return json({ doc: existing, pages: getPages(db, existing.id), already: true });
        }
        let m;
        try {
          m = parseManifest(await fetchBdrcJson(manifest));
        } catch (e) {
          return json({ error: (e as Error).message }, 502);
        }
        if (m.canvases.length === 0) {
          return json({ error: "This volume has no page images." }, 502);
        }
        const docId = createDoc(db, {
          title: title || `${volume} (BDRC)`,
          source_type: "image",
          filename: manifest,
          file_path: "",
          ocr_lang: ocrLang,
          source_url: manifest,
          source_name: "Buddhist Digital Resource Center (BDRC) Library",
        });
        const dir = docDir(docId);
        mkdirSync(dir, { recursive: true });
        const failures: string[] = [];
        for (let i = 0; i < m.canvases.length; i++) {
          const canvas = m.canvases[i];
          const pageNo = i + 1;
          try {
            if (!isAllowedBdrcUrl(canvas.sized)) {
              throw new Error("image URL outside the BDRC hosts");
            }
            const res = await fetch(canvas.sized);
            if (!res.ok) throw new Error(`image server returned ${res.status}`);
            const rel = `docs/${docId}/page-${pageNo}.jpg`;
            await Bun.write(join(dir, `page-${pageNo}.jpg`), await res.arrayBuffer());
            addPage(db, docId, pageNo, rel);
          } catch (e) {
            failures.push(`page ${pageNo} (${canvas.label}): ${(e as Error).message}`);
          }
        }
        const pages = getPages(db, docId);
        if (pages.length === 0) {
          deleteDoc(db, docId);
          rmSync(dir, { recursive: true, force: true });
          return json({ error: `Import failed: ${failures.join("; ")}` }, 502);
        }
        db.query(`UPDATE documents SET file_path = ? WHERE id = ?`).run(
          pages[0].image_path,
          docId,
        );
        return json(
          { doc: getDoc(db, docId), pages, failures, import_width: IMPORT_WIDTH },
          201,
        );
      }

      // ---- datasources: DharmaNexus corpora (GitHub, public domain / CC) ----
      // NOTE: the desk never calls the Dharmamitra API — its terms forbid
      // feeding third-party apps. It reads the project's own public
      // GitHub corpora and links back to the Dharmamitra reader.
      if (method === "GET" && path === "/api/datasources/corpus/catalog") {
        const lang = url.searchParams.get("lang") || "";
        if (!(lang in CORPUS_LANGS)) {
          return json({ error: "Unknown corpus language (pa, sa, zh)." }, 400);
        }
        try {
          const items = await fetchCatalog(lang as CorpusLang);
          return json({ lang, label: CORPUS_LANGS[lang as CorpusLang].label, count: items.length, items });
        } catch (e) {
          return json({ error: (e as Error).message }, 502);
        }
      }
      if (method === "GET" && path === "/api/datasources/corpus/text") {
        const lang = url.searchParams.get("lang") || "";
        const file = url.searchParams.get("file") || "";
        if (!(lang in CORPUS_LANGS) || !isCorpusFilename(lang as CorpusLang, file)) {
          return json({ error: "Unknown corpus language or file." }, 400);
        }
        try {
          const [items, segments] = await Promise.all([
            fetchCatalog(lang as CorpusLang),
            fetchCorpusJson(segmentUrl(lang as CorpusLang, file)).then(parseSegments),
          ]);
          const entry = items.find((e) => e.filename === file);
          return json({
            lang,
            filename: file,
            displayName: entry?.displayName || file,
            textname: entry?.textname || "",
            collection: entry?.collection || "",
            category: entry?.category || "",
            author: entry?.author || "",
            sourceLink: entry?.sourceLink || "",
            segmentCount: segments.length,
            preview: segments.slice(0, 5),
            reader: readerUrl(lang as CorpusLang, entry?.textname || file),
          });
        } catch (e) {
          return json({ error: (e as Error).message }, 502);
        }
      }
      if (method === "POST" && path === "/api/datasources/corpus/import") {
        const body = await readJson(req);
        const lang = typeof body.lang === "string" ? body.lang : "";
        const file = typeof body.file === "string" ? body.file : "";
        if (!(lang in CORPUS_LANGS) || !isCorpusFilename(lang as CorpusLang, file)) {
          return json({ error: "Unknown corpus language or file." }, 400);
        }
        const info = CORPUS_LANGS[lang as CorpusLang];
        const segment = typeof body.segment === "string" ? body.segment : "";
        // The Dharmamitra reader id is the corpus TEXT name, not the
        // juan file: /db/zh/ZH_X20_0358_001/text loads the title but
        // shows "No results found", while /db/zh/ZH_X20_0358/text shows
        // the text (verified live 2026-10-26). For Pāli/Sanskrit the
        // file name already is the text name, so this changes nothing
        // there. Docs imported before this fix carry the juan-file
        // reader URL; they are matched by that legacy URL and repaired
        // to the text-name URL instead of duplicating.
        const items = await fetchCatalog(lang as CorpusLang).catch(() => []);
        const entry = items.find((e) => e.filename === file);
        const textname = entry?.textname || file;
        const reader = readerUrl(lang as CorpusLang, textname);
        let existing = getDocBySourceUrl(db, reader);
        if (!existing && textname !== file) {
          existing = getDocBySourceUrl(db, readerUrl(lang as CorpusLang, file));
          if (existing) {
            updateDocSourceUrl(db, existing.id, reader);
            existing = getDoc(db, existing.id) ?? existing;
          }
        }
        if (existing) {
          let targetPage = 0;
          if (segment) {
            try {
              const segs = parseSegments(await fetchCorpusJson(segmentUrl(lang as CorpusLang, file)));
              targetPage = pageIndexForSegment(segs, segment);
            } catch {
              // leave 0: the doc still opens at page 1
            }
          }
          return json({ doc: existing, pages: getPages(db, existing.id), already: true, targetPage });
        }
        let segments;
        try {
          segments = parseSegments(await fetchCorpusJson(segmentUrl(lang as CorpusLang, file)));
        } catch (e) {
          return json({ error: (e as Error).message }, 502);
        }
        if (segments.length === 0) {
          return json({ error: "This text has no segments." }, 502);
        }
        const title = typeof body.title === "string" && body.title.trim()
          ? body.title.trim()
          : entry?.displayName || file;
        const pages = chunkSegments(segments);
        const docId = createDoc(db, {
          title,
          source_type: "text",
          filename: file,
          file_path: "",
          ocr_lang: info.ocrLang,
          source_url: reader,
          source_name: `DharmaNexus ${info.label} corpus (GitHub, public domain / CC)`,
        });
        for (let i = 0; i < pages.length; i++) {
          addPage(
            db, docId, i + 1, null, pages[i].text, "text",
            passageUrl(lang as CorpusLang, textname, pages[i].firstSegmentnr),
          );
        }
        const targetPage = segment ? pageIndexForSegment(segments, segment) : 0;
        return json({ doc: getDoc(db, docId), pages: getPages(db, docId), targetPage }, 201);
      }

      // ---- datasources: CBETA reference resolve ----
      // Pasted citations ("CBETA 2026.R2, TX20, no. 12, p. b137a9",
      // "X20n0358_p0137a09", "T 1883.45.672a15") resolve to the passage
      // in the desk's Chinese corpus. Volume + page is the key: pages
      // run continuously through a volume, so the scan finds the text
      // even when the citation's text number is missing or wrong.
      if (method === "GET" && path === "/api/datasources/cbeta/resolve") {
        const raw = url.searchParams.get("ref") || "";
        const parsed = parseCbetaRef(raw);
        if (!parsed) {
          return json({ error: "Could not parse that as a CBETA reference. Try e.g. CBETA 2026.R2, TX20, no. 12, p. b137a9, or a CBETA id like X20n0358_p0137a09." }, 400);
        }
        const warnings: string[] = [];
        if (parsed.droppedPrefix) {
          warnings.push(`Read "${parsed.raw}" as ${parsed.canon} canon, volume ${parsed.volume} — the leading "${parsed.droppedPrefix}" is not a CBETA canon code and was ignored.`);
        }
        if (parsed.leadingPageLetter) {
          warnings.push(`Page "${parsed.leadingPageLetter}${parsed.page}${parsed.column}${parsed.line}" read as page ${parsed.page}, column ${parsed.column}, line ${parsed.line}.`);
        }
        if (parsed.canon !== "T" && parsed.canon !== "X") {
          return json({
            ref: parsed, warnings: [...warnings, `Corpus lookup covers the Taishō (T) and Zokuzōkyō (X) canons; ${parsed.canon} is not in the desk's Chinese corpus.`],
            found: false,
            cbeta: parsed.textNo !== null ? cbetaTextUrl(parsed.canon, parsed.textNo) : null,
          });
        }
        let prefer: string | null = null;
        if ((parsed.textNoForm === "n" || parsed.textNoForm === "academic") && parsed.textNo !== null) {
          prefer = `ZH_${parsed.volumeToken}_${String(parsed.textNo).padStart(4, "0")}`;
        }
        let scan;
        try {
          scan = await findPageInVolume(parsed.volumeToken, parsed.pageKey, prefer);
        } catch (e) {
          return json({ error: (e as Error).message }, 502);
        }
        if (!scan.hit) {
          return json({ ref: parsed, warnings, found: false, searchedFiles: scan.searchedFiles, note: `No segment with page key ${parsed.pageKey} in the first ${scan.searchedFiles} juan file(s) of volume ${parsed.volumeToken}.` });
        }
        const hit = scan.hit;
        const suffix = hit.textname.slice(`ZH_${parsed.volumeToken}_`.length);
        const globalNo = parseInt(suffix, 10);
        const ord = hit.ordinal;
        const ordSuffix = ord % 10 === 1 && ord % 100 !== 11 ? "st" : ord % 10 === 2 && ord % 100 !== 12 ? "nd" : ord % 10 === 3 && ord % 100 !== 13 ? "rd" : "th";
        if (parsed.textNoForm === "no" && parsed.textNo !== null && parsed.textNo !== globalNo) {
          warnings.push(`The citation's "no. ${parsed.textNo}" does not match the text this page lands in (${hit.textname}, the ${ord}${ordSuffix} text in volume ${parsed.volumeToken}) — the page match is trusted over the number.`);
        }
        if (prefer && hit.textname !== prefer) {
          warnings.push(`The citation's text number points at ${prefer}, but page ${parsed.pageKey} was found in ${hit.textname} instead.`);
        }
        const cbeta = hit.cbetaLink || (!Number.isNaN(globalNo)
          ? cbetaPassageUrl(parsed.canon, parsed.volume, globalNo, parsed.pageKey)
          : null);
        return json({ ref: parsed, warnings, found: true, searchedFiles: scan.searchedFiles, hit: { ...hit, cbeta, reader: passageUrl("zh", hit.textname, hit.segmentnr) } });
      }

      // ---- documents ----
      if (method === "GET" && path === "/api/docs") {
        return json({ docs: listDocs(db) });
      }
      if (method === "POST" && path === "/api/docs") {
        const form = await req.formData();
        const title = String(form.get("title") || "").trim();
        const ocrLang = String(form.get("ocr_lang") || "bod");
        const files = form.getAll("files").filter((f) => f instanceof File) as File[];
        if (files.length === 0) return json({ error: "No files uploaded." }, 400);
        const lang = OCR_LANGS[ocrLang] ? ocrLang : "bod";

        const firstExt = extname(files[0].name).toLowerCase();
        const isPdf = firstExt === ".pdf";
        if (isPdf && files.length > 1) {
          return json({ error: "Upload one PDF at a time; images can be batched." }, 400);
        }
        if (!isPdf && !files.every((f) => IMG_EXTS.has(extname(f.name).toLowerCase()))) {
          return json({ error: "Only PDF or images (png/jpg/webp/gif) are accepted." }, 400);
        }

        const docId = createDoc(db, {
          title: title || files[0].name.replace(/\.[^.]+$/, ""),
          source_type: isPdf ? "pdf" : "image",
          filename: files[0].name,
          file_path: "",
          ocr_lang: lang,
        });
        const dir = docDir(docId);
        mkdirSync(dir, { recursive: true });

        if (isPdf) {
          const pdfPath = join(dir, "original.pdf");
          await Bun.write(pdfPath, await files[0].arrayBuffer());
          db.query(`UPDATE documents SET file_path = ? WHERE id = ?`).run(
            `docs/${docId}/original.pdf`,
            docId,
          );
          // Text layer first: no OCR needed when the PDF carries text.
          let text = "";
          let kind = "none";
          try {
            const extracted = await pdfText(pdfPath);
            if (extracted !== null && extracted.trim()) {
              text = extracted;
              kind = "text";
            }
          } catch {
            // fall through: scanned PDF, page OCR offered in the UI
          }
          addPage(db, docId, 0, null, text, kind);
          void pdfPageCount(pdfPath); // informational only in v1
        } else {
          for (let i = 0; i < files.length; i++) {
            const ext = extname(files[i].name).toLowerCase() || ".png";
            const rel = `docs/${docId}/page-${i + 1}${ext}`;
            await Bun.write(join(dir, `page-${i + 1}${ext}`), await files[i].arrayBuffer());
            addPage(db, docId, i + 1, rel);
          }
          db.query(`UPDATE documents SET file_path = ? WHERE id = ?`).run(
            `docs/${docId}/page-1${extname(files[0].name).toLowerCase() || ".png"}`,
            docId,
          );
        }
        return json({ doc: getDoc(db, docId), pages: getPages(db, docId) }, 201);
      }

      const docMatch = path.match(/^\/api\/docs\/(\d+)$/);
      if (docMatch) {
        const id = Number(docMatch[1]);
        const doc = getDoc(db, id);
        if (!doc) return json({ error: "Document not found." }, 404);
        if (method === "GET") {
          return json({ doc, pages: getPages(db, id) });
        }
        if (method === "DELETE") {
          deleteDoc(db, id);
          rmSync(docDir(id), { recursive: true, force: true });
          return json({ ok: true });
        }
      }

      const renderMatch = path.match(/^\/api\/docs\/(\d+)\/render-pages$/);
      if (method === "POST" && renderMatch) {
        const id = Number(renderMatch[1]);
        const doc = getDoc(db, id);
        if (!doc) return json({ error: "Document not found." }, 404);
        if (doc.source_type !== "pdf") {
          return json({ error: "Only PDFs can be rendered into pages." }, 400);
        }
        const pages = getPages(db, id);
        if (pages.some((p) => p.image_path)) {
          return json({ error: "This PDF is already rendered into pages." }, 400);
        }
        const outDir = join(docDir(id), "pages");
        const n = await renderPdfPages(join(docDir(id), "original.pdf"), outDir);
        if (n === 0) return json({ error: "No pages rendered." }, 500);
        clearPages(db, id);
        const { readdirSync } = await import("fs");
        const pngs = readdirSync(outDir)
          .filter((f) => f.endsWith(".png"))
          .sort();
        for (let i = 0; i < pngs.length; i++) {
          addPage(db, id, i + 1, `docs/${id}/pages/${pngs[i]}`);
        }
        return json({ doc: getDoc(db, id), pages: getPages(db, id) });
      }

      const pageMatch = path.match(/^\/api\/docs\/(\d+)\/pages\/(\d+)$/);
      if (pageMatch) {
        const id = Number(pageMatch[1]);
        const pageNo = Number(pageMatch[2]);
        const doc = getDoc(db, id);
        if (!doc) return json({ error: "Document not found." }, 404);
        const page = getPage(db, id, pageNo);
        if (!page) return json({ error: "Page not found." }, 404);
        if (method === "PATCH") {
          const body = await readJson(req);
          const patch: { source_text?: string; translation?: string; notes?: string } = {};
          if (typeof body.source_text === "string") patch.source_text = body.source_text;
          if (typeof body.translation === "string") patch.translation = body.translation;
          if (typeof body.notes === "string") patch.notes = body.notes;
          updatePage(db, id, pageNo, patch);
          return json({ page: getPage(db, id, pageNo) });
        }
      }

      const ocrMatch = path.match(/^\/api\/docs\/(\d+)\/pages\/(\d+)\/ocr$/);
      if (method === "POST" && ocrMatch) {
        const id = Number(ocrMatch[1]);
        const pageNo = Number(ocrMatch[2]);
        const doc = getDoc(db, id);
        if (!doc) return json({ error: "Document not found." }, 404);
        const page = getPage(db, id, pageNo);
        if (!page) return json({ error: "Page not found." }, 404);
        if (!page.image_path) {
          return json(
            { error: "This page has no image — render the PDF into pages first." },
            400,
          );
        }
        const body = await readJson(req);
        const langKey =
          typeof body.lang === "string" && OCR_LANGS[body.lang] ? body.lang : doc.ocr_lang;
        const abs = resolve(join(DATA, page.image_path));
        if (!abs.startsWith(resolve(DATA))) return json({ error: "Bad image path." }, 400);
        try {
          const text = await ocrImage(abs, OCR_LANGS[langKey].tess);
          db.query(
            `UPDATE pages SET source_text = ?, source_kind = 'ocr' WHERE doc_id = ? AND page_no = ?`,
          ).run(text, id, pageNo);
          return json({ page: getPage(db, id, pageNo) });
        } catch (e) {
          return json({ error: (e as Error).message }, 500);
        }
      }

      const trMatch = path.match(/^\/api\/docs\/(\d+)\/pages\/(\d+)\/translate$/);
      if (method === "POST" && trMatch) {
        const id = Number(trMatch[1]);
        const pageNo = Number(trMatch[2]);
        const doc = getDoc(db, id);
        if (!doc) return json({ error: "Document not found." }, 404);
        const page = getPage(db, id, pageNo);
        if (!page) return json({ error: "Page not found." }, 404);
        if (!page.source_text.trim()) {
          return json({ error: "No source text on this page — OCR or extract it first." }, 400);
        }
        const model = ollamaModel();
        if (!model) {
          return json({ error: "No Ollama model selected — pick one in Settings." }, 400);
        }
        try {
          const out = await translateText(page.source_text, langLabel(doc.ocr_lang), {
            url: ollamaUrl(),
            model,
          });
          updatePage(db, id, pageNo, { translation: out });
          return json({ page: getPage(db, id, pageNo) });
        } catch (e) {
          return json({ error: (e as Error).message }, 502);
        }
      }

      const trAllMatch = path.match(/^\/api\/docs\/(\d+)\/translate-all$/);
      if (method === "POST" && trAllMatch) {
        const id = Number(trAllMatch[1]);
        const doc = getDoc(db, id);
        if (!doc) return json({ error: "Document not found." }, 404);
        const model = ollamaModel();
        if (!model) {
          return json({ error: "No Ollama model selected — pick one in Settings." }, 400);
        }
        let done = 0;
        const errors: string[] = [];
        for (const page of getPages(db, id)) {
          if (!page.source_text.trim()) continue;
          try {
            const out = await translateText(page.source_text, langLabel(doc.ocr_lang), {
              url: ollamaUrl(),
              model,
            });
            updatePage(db, id, page.page_no, { translation: out });
            done++;
          } catch (e) {
            errors.push(`page ${page.page_no}: ${(e as Error).message}`);
          }
        }
        return json({ translated: done, errors });
      }

      return new Response("Not found", { status: 404 });
    } catch (e) {
      console.error(e);
      return json({ error: (e as Error).message || "Server error." }, 500);
    }
  },
});

console.log(`Sutra desk on http://127.0.0.1:${PORT}`);
