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

## Tests

```sh
bun test   # 12 tests: db, OCR args, Ollama client with stubbed fetch
```
