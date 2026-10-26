// Sutra desk storage: documents, pages, settings. SQLite via bun:sqlite.
// A document is one uploaded sutra: either a set of images (one page per
// image) or a PDF (one "whole document" page until its pages are rendered
// with pdftoppm). Source text, translation and notes are all editable.

import { Database } from "bun:sqlite";
import { join } from "path";

export interface DocRow {
  id: number;
  title: string;
  source_type: string;
  filename: string;
  file_path: string;
  ocr_lang: string;
  page_count: number;
  created_at: number;
  source_url: string | null;
  source_name: string | null;
}

export interface PageRow {
  id: number;
  doc_id: number;
  page_no: number;
  image_path: string | null;
  source_text: string;
  source_kind: string;
  translation: string;
  notes: string;
  source_ref: string | null;
}

export function initDb(path: string): Database {
  const db = new Database(path);
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(`
    CREATE TABLE IF NOT EXISTS documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      source_type TEXT NOT NULL,
      filename TEXT NOT NULL,
      file_path TEXT NOT NULL,
      ocr_lang TEXT NOT NULL DEFAULT 'bod',
      page_count INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS pages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      doc_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
      page_no INTEGER NOT NULL,
      image_path TEXT,
      source_text TEXT NOT NULL DEFAULT '',
      source_kind TEXT NOT NULL DEFAULT 'none',
      translation TEXT NOT NULL DEFAULT '',
      notes TEXT NOT NULL DEFAULT '',
      UNIQUE(doc_id, page_no)
    );
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  // Datasource provenance (added after v1): never break old databases.
  const cols = db
    .query(`PRAGMA table_info(documents)`)
    .all() as { name: string }[];
  const names = new Set(cols.map((c) => c.name));
  if (!names.has("source_url")) {
    db.exec(`ALTER TABLE documents ADD COLUMN source_url TEXT`);
  }
  if (!names.has("source_name")) {
    db.exec(`ALTER TABLE documents ADD COLUMN source_name TEXT`);
  }
  // Per-page deep link (added with the DharmaNexus corpora): a passage
  // URL for text imports, null for uploads and image imports.
  const pageCols = db
    .query(`PRAGMA table_info(pages)`)
    .all() as { name: string }[];
  if (!pageCols.some((c) => c.name === "source_ref")) {
    db.exec(`ALTER TABLE pages ADD COLUMN source_ref TEXT`);
  }
  return db;
}

export function createDoc(
  db: Database,
  d: {
    title: string;
    source_type: string;
    filename: string;
    file_path: string;
    ocr_lang: string;
    source_url?: string | null;
    source_name?: string | null;
  },
): number {
  const r = db
    .query(
      `INSERT INTO documents (title, source_type, filename, file_path, ocr_lang, page_count, created_at, source_url, source_name)
       VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)`,
    )
    .run(
      d.title,
      d.source_type,
      d.filename,
      d.file_path,
      d.ocr_lang,
      Date.now(),
      d.source_url ?? null,
      d.source_name ?? null,
    );
  return Number(r.lastInsertRowid);
}

export function addPage(
  db: Database,
  docId: number,
  pageNo: number,
  imagePath: string | null,
  sourceText = "",
  sourceKind = "none",
  sourceRef: string | null = null,
): number {
  const r = db
    .query(
      `INSERT INTO pages (doc_id, page_no, image_path, source_text, source_kind, source_ref)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(docId, pageNo, imagePath, sourceText, sourceKind, sourceRef);
  db.query(`UPDATE documents SET page_count = page_count + 1 WHERE id = ?`).run(
    docId,
  );
  return Number(r.lastInsertRowid);
}

export function listDocs(db: Database): DocRow[] {
  return db
    .query(`SELECT * FROM documents ORDER BY created_at DESC`)
    .all() as DocRow[];
}

export function getDoc(db: Database, id: number): DocRow | null {
  return (
    (db.query(`SELECT * FROM documents WHERE id = ?`).get(id) as DocRow) ?? null
  );
}

export function getDocBySourceUrl(db: Database, url: string): DocRow | null {
  return (
    (db.query(`SELECT * FROM documents WHERE source_url = ?`).get(url) as DocRow) ??
    null
  );
}

/// Repair a document's source URL (used when an older import stored a
/// reader id that later turned out to be wrong — the doc itself is
/// kept, only its link is corrected).
export function updateDocSourceUrl(db: Database, id: number, url: string): void {
  db.query(`UPDATE documents SET source_url = ? WHERE id = ?`).run(url, id);
}

export function getPages(db: Database, docId: number): PageRow[] {
  return db
    .query(`SELECT * FROM pages WHERE doc_id = ? ORDER BY page_no ASC`)
    .all(docId) as PageRow[];
}

export function getPage(db: Database, docId: number, pageNo: number): PageRow | null {
  return (
    (db
      .query(`SELECT * FROM pages WHERE doc_id = ? AND page_no = ?`)
      .get(docId, pageNo) as PageRow) ?? null
  );
}

export function updatePage(
  db: Database,
  docId: number,
  pageNo: number,
  patch: { source_text?: string; translation?: string; notes?: string },
): boolean {
  const sets: string[] = [];
  const vals: unknown[] = [];
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    sets.push(`${k} = ?`);
    vals.push(v);
  }
  if (sets.length === 0) return false;
  vals.push(docId, pageNo);
  const r = db
    .query(`UPDATE pages SET ${sets.join(", ")} WHERE doc_id = ? AND page_no = ?`)
    .run(...vals);
  return r.changes > 0;
}

export function deleteDoc(db: Database, id: number): boolean {
  const r = db.query(`DELETE FROM documents WHERE id = ?`).run(id);
  return r.changes > 0;
}

/// Remove all pages of a document and reset its page count (used when a
/// PDF's whole-document page is replaced by rendered per-page rows).
export function clearPages(db: Database, docId: number): void {
  db.query(`DELETE FROM pages WHERE doc_id = ?`).run(docId);
  db.query(`UPDATE documents SET page_count = 0 WHERE id = ?`).run(docId);
}

export function getSetting(db: Database, key: string, fallback: string): string {
  const row = db
    .query(`SELECT value FROM settings WHERE key = ?`)
    .get(key) as { value: string } | null;
  return row ? row.value : fallback;
}

export function setSetting(db: Database, key: string, value: string): void {
  db.query(
    `INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(key, value);
}

export function dataDirPath(root: string): string {
  return process.env.SUTRA_DATA || join(root, "data");
}
