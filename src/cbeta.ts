// CBETA reference resolver for the desk.
//
// Scholars cite Chinese Buddhist texts by canon, volume, text number,
// page, column and line — but the exact shape varies by source, e.g.:
//   CBETA 2026.R2, TX20, no. 12, p. b137a9   (verbose, CBETA edition)
//   X20n0358_p0137a09                        (compact CBETA id / URL tail)
//   T50n2060 [0436b15]                       (id + bracket page)
//   T 1883.45.672a15                          (academic: number.volume.page)
// The resolver parses all four, normalizes to one page key
// (page 4-digit + column + line 2-digit, e.g. 0137a09), and finds the
// passage in the desk's DharmaNexus Chinese corpus, where pages run
// continuously through a volume — so volume + page alone identifies
// the passage, and the text number is a cross-check, not the key.
//
// Two parse tolerances, both reported back as warnings rather than
// silently swallowed:
//   - a leading letter run before the volume ("TX20" -> X canon vol 20,
//     the "T" is dropped and reported);
//   - a leading letter on the page ("b137a9" -> page 137, col a, line 9,
//     the "b" is dropped and reported).
// The desk never guesses a text number: when the number in the citation
// does not match the text the page lands in, that is a warning, and the
// page match is what the desk trusts.

export interface CbetaRef {
  raw: string;
  edition: string;
  canon: string;
  volume: number;
  volumeToken: string;
  textNo: number | null;
  textNoForm: "n" | "no" | "academic" | null;
  page: number;
  column: string;
  line: number;
  pageKey: string;
  droppedPrefix: string;
  leadingPageLetter: string;
}

const pad = (n: number, w: number) => String(n).padStart(w, "0");

export function pageKeyOf(page: number, column: string, line: number): string {
  return `${pad(page, 4)}${column.toLowerCase()}${pad(line, 2)}`;
}

const KNOWN_CANONS = new Set(["T", "X", "J", "N", "K", "L", "P", "S", "Y", "A", "B", "C", "D", "F", "G", "M"]);

/// Parse one reference string. Returns null when nothing recognizable
/// is present. Never throws on odd input.
export function parseCbetaRef(raw: string): CbetaRef | null {
  const text = (raw || "").trim();
  if (!text) return null;
  let rest = text;
  let edition = "";
  const ed = rest.match(/^CBETA\s+([0-9]{4}\.R\d+)\s*,\s*/i);
  if (ed) {
    edition = ed[1];
    rest = rest.slice(ed[0].length);
  }
  // Compact CBETA id or URL tail: X20n0358_p0137a09 (also inside a URL).
  const compact = rest.match(/([A-Za-z])(\d+)n(\d+)_p([A-Za-z]?)(\d+)([a-z])(\d+)/i);
  if (compact) {
    const [, canon, vol, no, lead, page, col, line] = compact;
    if (!KNOWN_CANONS.has(canon.toUpperCase())) return null;
    return finish(raw, edition, canon.toUpperCase(), Number(vol), Number(no), "n",
      Number(page), col.toLowerCase(), Number(line), "", lead || "");
  }
  // Id + bracket page: T50n2060 [0436b15]
  const bracket = rest.match(/([A-Za-z])(\d+)n(\d+)[^\[]*\[(\d+)([a-z])(\d+)\]/i);
  if (bracket) {
    const [, canon, vol, no, page, col, line] = bracket;
    if (!KNOWN_CANONS.has(canon.toUpperCase())) return null;
    return finish(raw, edition, canon.toUpperCase(), Number(vol), Number(no), "n",
      Number(page), col.toLowerCase(), Number(line), "", "");
  }
  // Academic form: T 1883.45.672a15 (number.volume.page+column+line).
  const academic = rest.match(/([A-Za-z])\s*(\d+)\.(\d+)\.(\d+)([a-z])(\d+)/i);
  if (academic) {
    const [, canon, no, vol, page, col, line] = academic;
    if (!KNOWN_CANONS.has(canon.toUpperCase())) return null;
    return finish(raw, edition, canon.toUpperCase(), Number(vol), Number(no), "academic",
      Number(page), col.toLowerCase(), Number(line), "", "");
  }
  // Verbose form: TX20, no. 12, p. b137a9 (also "X20, p. 137a9",
  // "X20n0358, p. 137a9"). The volume token must sit before the page
  // marker — otherwise a bare "p. 137a9" would misread its own "a9"
  // tail as a volume.
  const pageAt = rest.search(/p\./i);
  const head = pageAt >= 0 ? rest.slice(0, pageAt) : rest;
  const vol = head.match(/([A-Za-z]+)(\d+)/);
  if (!vol) return null;
  const run = vol[1];
  const canon = run.slice(-1).toUpperCase();
  if (!KNOWN_CANONS.has(canon)) return null;
  const droppedPrefix = run.length > 1 ? run.slice(0, -1) : "";
  const volume = Number(vol[2]);
  let textNo: number | null = null;
  let textNoForm: CbetaRef["textNoForm"] = null;
  const nForm = head.match(/n(\d+)/i);
  if (nForm) {
    textNo = Number(nForm[1]);
    textNoForm = "n";
  } else {
    const no = head.match(/no\.\s*(\d+)/i);
    if (no) {
      textNo = Number(no[1]);
      textNoForm = "no";
    }
  }
  const page = rest.match(/p\.\s*([A-Za-z]?)(\d+)([a-z])(\d+)/i);
  if (!page) return null;
  return finish(raw, edition, canon, volume, textNo, textNoForm,
    Number(page[2]), page[3].toLowerCase(), Number(page[4]), droppedPrefix, page[1] || "");
}

function finish(
  raw: string, edition: string, canon: string, volume: number,
  textNo: number | null, textNoForm: CbetaRef["textNoForm"],
  page: number, column: string, line: number,
  droppedPrefix: string, leadingPageLetter: string,
): CbetaRef {
  return {
    raw, edition, canon, volume,
    volumeToken: `${canon}${pad(volume, 2)}`,
    textNo, textNoForm, page, column, line,
    pageKey: pageKeyOf(page, column, line),
    droppedPrefix, leadingPageLetter,
  };
}

/// CBETA Online passage URL. Needs the text's global number, which the
/// resolver supplies from the corpus text it finds (or from an n-form
/// reference, which carries it directly).
export function cbetaPassageUrl(canon: string, volume: number, textNo: number, pageKey: string): string {
  return `https://cbetaonline.dila.edu.tw/zh/${canon}${pad(volume, 2)}n${pad(textNo, 4)}_p${pageKey}`;
}

export function cbetaTextUrl(canon: string, textNo: number): string {
  return `https://cbetaonline.dila.edu.tw/zh/${canon}${pad(textNo, 4)}`;
}

/// A segment key matches a page key exactly ("0137a09") or with a
/// trailing split suffix ("0059b11_0", "_1", ... — Taishō segments
/// split one CBETA line across several segments).
export function segmentMatchesPage(segmentnr: string, pageKey: string): boolean {
  const key = segmentnr.split(":").pop() || "";
  return key === pageKey || key.startsWith(pageKey + "_");
}
