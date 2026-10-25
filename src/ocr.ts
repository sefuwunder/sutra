// OCR + PDF helpers. All tools are optional and detected at runtime:
// tesseract (OCR), pdftotext (text-layer extraction), pdftoppm (page
// rendering), pdfinfo (page count). Missing tools surface as a clear
// status in the UI, never a crash — the desk still opens, views and
// stores everything, and the user installs what's missing.

export const OCR_LANGS: Record<string, { label: string; tess: string }> = {
  bod: { label: "Tibetan", tess: "bod" },
  san: { label: "Sanskrit", tess: "san" },
  "bod+san": { label: "Tibetan or Sanskrit", tess: "bod+san" },
};

export function langLabel(ocrLang: string): string {
  return OCR_LANGS[ocrLang]?.label ?? "Tibetan or Sanskrit";
}

async function run(
  cmd: string[],
): Promise<{ code: number; out: string; err: string }> {
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const out = await new Response(proc.stdout).text();
  const err = await new Response(proc.stderr).text();
  const code = await proc.exited;
  return { code, out, err };
}

export async function toolAvailable(cmd: string): Promise<boolean> {
  try {
    const r = await run([cmd, "--version"]);
    return r.code === 0;
  } catch {
    return false;
  }
}

export async function tesseractLangs(): Promise<string[]> {
  try {
    const r = await run(["tesseract", "--list-langs"]);
    if (r.code !== 0) return [];
    // --list-langs writes to stderr on some builds, stdout on others.
    const text = (r.out + "\n" + r.err).trim();
    return text
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("List of available"));
  } catch {
    return [];
  }
}

export function tesseractArgs(imagePath: string, tessLang: string): string[] {
  // --psm 6: assume a uniform block of text (a sutra page), the best
  // default for dense scripture layouts.
  return ["tesseract", imagePath, "stdout", "--psm", "6", "-l", tessLang];
}

/// OCR one page image. Throws with tesseract's stderr on failure, or a
/// plain-English install hint when tesseract itself is missing.
export async function ocrImage(imagePath: string, tessLang: string): Promise<string> {
  let r;
  try {
    r = await run(tesseractArgs(imagePath, tessLang));
  } catch {
    throw new Error(
      "tesseract is not installed — e.g. apt install tesseract-ocr tesseract-ocr-bod tesseract-ocr-san",
    );
  }
  if (r.code !== 0) {
    throw new Error(`tesseract failed: ${r.err.trim() || "exit " + r.code}`);
  }
  return r.out;
}

/// Extract a PDF's embedded text layer. Returns null when pdftotext is
/// missing; returns "" for a scanned PDF (no text layer) — the caller
/// then offers page OCR instead.
export async function pdfText(pdfPath: string): Promise<string | null> {
  if (!(await toolAvailable("pdftotext"))) return null;
  const r = await run(["pdftotext", pdfPath, "-"]);
  if (r.code !== 0) throw new Error(`pdftotext failed: ${r.err.trim()}`);
  return r.out;
}

export async function pdfPageCount(pdfPath: string): Promise<number | null> {
  if (!(await toolAvailable("pdfinfo"))) return null;
  const r = await run(["pdfinfo", pdfPath]);
  if (r.code !== 0) return null;
  const m = r.out.match(/^Pages:\s*(\d+)/m);
  return m ? parseInt(m[1], 10) : null;
}

/// Render PDF pages to PNGs in outDir (page-1.png, page-2.png, ...).
/// Returns the number of pages rendered. Throws when pdftoppm is missing.
export async function renderPdfPages(
  pdfPath: string,
  outDir: string,
): Promise<number> {
  if (!(await toolAvailable("pdftoppm"))) {
    throw new Error("pdftoppm is not installed (poppler-utils)");
  }
  const { mkdirSync, readdirSync } = await import("fs");
  mkdirSync(outDir, { recursive: true });
  const r = await run(["pdftoppm", "-png", "-r", "200", pdfPath, `${outDir}/page`]);
  if (r.code !== 0) {
    throw new Error(`pdftoppm failed: ${r.err.trim()}`);
  }
  return readdirSync(outDir).filter((f) => f.endsWith(".png")).length;
}
