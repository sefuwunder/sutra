import { describe, test, expect, beforeEach } from "bun:test";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  initDb,
  createDoc,
  addPage,
  listDocs,
  getDoc,
  getPages,
  updatePage,
  clearPages,
  getSetting,
  setSetting,
} from "../src/db.ts";

let db: ReturnType<typeof initDb>;

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), "sutra-test-"));
  db = initDb(join(dir, "test.db"));
});

describe("documents and pages", () => {
  test("create, list, page, update, clear", () => {
    const id = createDoc(db, {
      title: "Heart Sutra",
      source_type: "image",
      filename: "p1.png",
      file_path: "docs/1/page-1.png",
      ocr_lang: "bod",
    });
    addPage(db, id, 1, "docs/1/page-1.png");
    addPage(db, id, 2, "docs/1/page-2.png");
    expect(listDocs(db)).toHaveLength(1);
    expect(getDoc(db, id)?.title).toBe("Heart Sutra");
    expect(getPages(db, id)).toHaveLength(2);
    expect(updatePage(db, id, 1, { notes: "n1", translation: "t1" })).toBe(true);
    expect(getPages(db, id)[0].notes).toBe("n1");
    expect(getDoc(db, id)?.page_count).toBe(2);
    clearPages(db, id);
    expect(getPages(db, id)).toHaveLength(0);
    expect(getDoc(db, id)?.page_count).toBe(0);
  });

  test("page numbers are unique per document", () => {
    const id = createDoc(db, {
      title: "X",
      source_type: "image",
      filename: "p.png",
      file_path: "",
      ocr_lang: "san",
    });
    addPage(db, id, 1, null);
    expect(() => addPage(db, id, 1, null)).toThrow();
  });
});

describe("settings", () => {
  test("fallback, set, overwrite", () => {
    expect(getSetting(db, "ollama_url", "http://localhost:11434")).toBe(
      "http://localhost:11434",
    );
    setSetting(db, "ollama_url", "http://x:11434");
    expect(getSetting(db, "ollama_url", "")).toBe("http://x:11434");
    setSetting(db, "ollama_url", "http://y:11434");
    expect(getSetting(db, "ollama_url", "")).toBe("http://y:11434");
  });
});
