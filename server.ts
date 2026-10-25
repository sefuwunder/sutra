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
