# sutra

A **Sutra Research Study Desk**: open a sutra as a PDF or a batch of page
images, OCR it from Tibetan or Sanskrit when there is no text layer, and
translate it with the user's own local Ollama model — all self-hosted, all
editable, source and translation always side by side.

Bun + zero dependencies + SQLite. No model is ever downloaded by this desk:
translation calls the Ollama server you already run, with the model you
pick in Settings from your installed list.

## Run

```sh
bun server.ts
# Sutra desk on http://127.0.0.1:3043
```

`SUTRA_PORT` overrides the port, `SUTRA_DATA` the data directory
(default `./data`), `OLLAMA_URL` / `OLLAMA_MODEL` seed the Settings
defaults. The desk binds 127.0.0.1 only.

## The desk

- **Library**: upload one PDF, or a batch of page images (one page per
  image). Title and OCR language (Tibetan / Sanskrit / both) per document.
- **Page view**: the page image (or the PDF itself), the source text, the
  English translation, and notes — every text field is editable and saves
  on blur.
- **OCR**: per page, via local `tesseract` (`--psm 6`, `bod` / `san`).
  PDFs with a text layer skip OCR entirely: `pdftotext` extracts the
  layer on upload. Scanned PDFs render into per-page PNGs with `pdftoppm`
  ("Render pages"), then OCR per page.
- **Translate**: per page or whole document, via Ollama `/api/generate`
  (temperature 0.2, "output only the translation"). Settings holds the
  Ollama URL and the model, populated from your Ollama's `/api/tags`.
- **Tools status**: the header shows what is installed — tesseract (+
  its languages), pdftotext, pdftoppm, Ollama reachability. Missing tools
  degrade gracefully: the desk still opens, views, stores and edits
  everything.
- **Datasources**: browse the UTokyo Database for Sanskrit Manuscripts
  (525 manuscripts, CC BY 4.0) from the Library panel, filter by title,
  read a manuscript's catalogue metadata and thumbnails, and import it:
  every page downloads at 2000px wide (full resolution stays one
  Mirador click away), lands as a Sanskrit document, and is ready to OCR
  and translate. Re-importing returns the existing copy, never a
  duplicate. The desk only ever fetches the database's own two hosts —
  its IIIF collection/manifests and its image server — so the import
  endpoint cannot be used as an open proxy.
- **BDRC Library**: search the Buddhist Digital Resource Center by title
  or author (Wylie or Tibetan script), or paste a BDRC id (MW… instance,
  W… work, I… volume). Open an instance to see its volumes with their
  access badges, preview a volume's pages, and import one volume at a
  time at 2000px wide. Access is enforced per volume through BDRC's
  volume info: only AccessOpen volumes download — restricted volumes
  still serve a manifest (a 40-page extract), so they are shown but
  never imported. OCR language is guessed from the volume's script
  (Tibetan → bod, Devanagari → san).

## Tool setup (on the machine that runs the desk)

```sh
# OCR + Tibetan/Sanskrit data
sudo apt-get install -y tesseract-ocr tesseract-ocr-bod tesseract-ocr-san
# PDF text extraction + page rendering
sudo apt-get install -y poppler-utils
# Translation: any Ollama server with an installed multilingual model
```

## Honest caveats

- Tibetan OCR with tesseract is usable but imperfect — dense pecha layouts
  and woodblock prints will need hand correction. That is why the source
  text stays editable.
- Translation quality varies a lot by model, especially for Tibetan.
  The desk never hides this: source and translation sit side by side,
  the translation is editable, and nothing is auto-saved over your edits.
- PDFs are stored as uploaded; page images render at 200 dpi.

## API

| Route | Action |
|---|---|
| `GET /api/tools` | Installed-tool + Ollama status |
| `GET/PATCH /api/settings` | Ollama URL + model |
| `GET /api/models` | Models from Ollama `/api/tags` |
| `GET/POST /api/docs`, `GET/DELETE /api/docs/:id` | Library |
| `POST /api/docs/:id/render-pages` | PDF → per-page PNGs (pdftoppm) |
| `PATCH /api/docs/:id/pages/:n` | Edit source / translation / notes |
| `POST /api/docs/:id/pages/:n/ocr` | OCR one page (`{lang}`) |
| `POST /api/docs/:id/pages/:n/translate` | Translate one page |
| `POST /api/docs/:id/translate-all` | Translate every page with source text |
| `GET /api/datasources/utokyo` | UTokyo catalogue: all 525 manifests + titles |
| `GET /api/datasources/utokyo/manifest?url=…` | One manuscript: metadata + page images |
| `POST /api/datasources/utokyo/import` | Import a manuscript (`{manifest}`) as a doc |
| `GET /api/datasources/bdrc/search?q=…` | BDRC literal-match search (or direct MW/W/I id) |
| `GET /api/datasources/bdrc/instance?id=…` | BDRC instance: metadata + volumes + access |
| `GET /api/datasources/bdrc/work?id=…` | BDRC work: volumes + access |
| `GET /api/datasources/bdrc/volume?id=…` | BDRC volume: access + manifest + pages |
| `POST /api/datasources/bdrc/import` | Import one open volume (`{volume, title, ocr_lang}`) |

## Tests

```sh
bun test   # 24 tests: db, OCR args, Ollama client with stubbed fetch, IIIF parsing + URL allowlists, BDRC search/volumes/access
```
