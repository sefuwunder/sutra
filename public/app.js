// Sutra desk UI: library, page view, OCR + Ollama translation.
// All user text travels through .value / textContent, never innerHTML.
const $ = (id) => document.getElementById(id);
const msgEl = $("msg");
let docs = [];
let cur = null; // { doc, pages }
let pageIdx = 0;
let tools = null;

function showMsg(text, isErr = false) {
  msgEl.textContent = text;
  msgEl.className = isErr ? "err" : "ok";
  clearTimeout(showMsg._t);
  showMsg._t = setTimeout(() => { msgEl.textContent = ""; }, 6000);
}

async function api(path, opts = {}) {
  const res = await fetch(path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function chip(label, ok) {
  const s = document.createElement("span");
  s.className = "chip " + (ok ? "ok" : "bad");
  s.textContent = `${label} ${ok ? "ok" : "missing"}`;
  return s;
}

async function loadTools() {
  tools = await api("/api/tools");
  const el = $("tools");
  el.replaceChildren();
  el.append(
    chip("tesseract", tools.tesseract),
    chip("pdftotext", tools.pdftotext),
    chip("pdftoppm", tools.pdftoppm),
    chip("ollama", tools.ollama_ok),
  );
  if (tools.tesseract) {
    const langs = document.createElement("span");
    langs.className = "chip";
    langs.textContent = `langs: ${tools.tesseract_langs.join(", ") || "none"}`;
    el.append(langs);
  }
  if (!tools.tesseract) {
    const hint = document.createElement("span");
    hint.className = "chip";
    hint.textContent = "OCR needs tesseract (e.g. apt install tesseract-ocr tesseract-ocr-bod tesseract-ocr-san)";
    el.append(hint);
  }
}

async function loadDocs() {
  const data = await api("/api/docs");
  docs = data.docs;
  const ul = $("doc-list");
  ul.replaceChildren();
  for (const d of docs) {
    const li = document.createElement("li");
    const b = document.createElement("button");
    b.textContent = `${d.title} (${d.page_count}p)`;
    b.onclick = () => openDoc(d.id);
    li.append(b);
    ul.append(li);
  }
}

async function loadSettings() {
  const s = await api("/api/settings");
  $("set-url").value = s.ollama_url;
  await refreshModels(s.ollama_model);
}

async function refreshModels(selected = "") {
  const sel = $("set-model");
  sel.replaceChildren();
  const none = document.createElement("option");
  none.value = "";
  none.textContent = "— no model selected —";
  sel.append(none);
  try {
    const data = await api("/api/models");
    for (const m of data.models) {
      const o = document.createElement("option");
      o.value = m;
      o.textContent = m;
      sel.append(o);
    }
    if (selected) sel.value = selected;
  } catch (e) {
    showMsg(e.message, true);
  }
}

async function openDoc(id, startPage = 0) {
  const data = await api(`/api/docs/${id}`);
  cur = data;
  pageIdx = startPage > 0 && startPage <= data.pages.length ? startPage - 1 : 0;
  renderDesk();
}

function renderDesk() {
  const desk = $("desk");
  desk.replaceChildren();
  if (!cur) return;
  const { doc, pages } = cur;
  const h = document.createElement("h2");
  h.textContent = doc.title;
  desk.append(h);
  const meta = document.createElement("p");
  meta.className = "hint";
  meta.textContent = `${doc.source_type} · ${doc.filename} · ${doc.ocr_lang} · ${pages.length} page(s)`;
  desk.append(meta);
  if (doc.source_url) {
    const src = document.createElement("p");
    src.className = "hint";
    src.textContent = `Source: ${doc.source_name || "remote datasource"} — `;
    const a = document.createElement("a");
    a.href = doc.source_url;
    a.target = "_blank";
    a.rel = "noreferrer";
    a.textContent = doc.source_type === "text" ? "Dharmamitra reader" : "manifest";
    src.append(a);
    desk.append(src);
  }

  const nav = document.createElement("div");
  nav.className = "nav";
  const prev = document.createElement("button");
  prev.textContent = "‹ Prev";
  prev.disabled = pageIdx <= 0;
  prev.onclick = () => { pageIdx--; renderDesk(); };
  const next = document.createElement("button");
  next.textContent = "Next ›";
  next.disabled = pageIdx >= pages.length - 1;
  next.onclick = () => { pageIdx++; renderDesk(); };
  const pg = document.createElement("span");
  pg.textContent = `Page ${pages.length ? pages[pageIdx].page_no + 1 : 0} of ${pages.length}`;
  nav.append(prev, pg, next);
  if (doc.source_type === "pdf" && !pages.some((p) => p.image_path)) {
    const render = document.createElement("button");
    render.textContent = "Render pages (pdftoppm)";
    render.onclick = async () => {
      try {
        const data = await api(`/api/docs/${doc.id}/render-pages`, { method: "POST" });
        cur = data;
        pageIdx = 0;
        renderDesk();
        showMsg(`Rendered ${data.pages.length} pages.`);
      } catch (e) { showMsg(e.message, true); }
    };
    nav.append(render);
  }
  const trAll = document.createElement("button");
  trAll.textContent = "Translate all pages";
  trAll.onclick = async () => {
    trAll.disabled = true;
    try {
      const data = await api(`/api/docs/${doc.id}/translate-all`, { method: "POST" });
      showMsg(`Translated ${data.translated} page(s).` + (data.errors.length ? ` Errors: ${data.errors.join("; ")}` : ""));
      await openDoc(doc.id);
    } catch (e) { showMsg(e.message, true); }
    trAll.disabled = false;
  };
  nav.append(trAll);
  const del = document.createElement("button");
  del.textContent = "Delete";
  del.className = "danger";
  del.onclick = async () => {
    if (!confirm(`Delete "${doc.title}" and its files?`)) return;
    await api(`/api/docs/${doc.id}`, { method: "DELETE" });
    cur = null;
    desk.replaceChildren();
    const p = document.createElement("p");
    p.className = "empty";
    p.textContent = "Pick a sutra from the library, or add one.";
    desk.append(p);
    loadDocs();
  };
  nav.append(del);
  desk.append(nav);

  if (!pages.length) return;
  const page = pages[pageIdx];

  if (page.image_path) {
    const img = document.createElement("img");
    img.src = `/files/${page.image_path}`;
    img.className = "page-img";
    desk.append(img);
  } else if (doc.source_type === "pdf") {
    const emb = document.createElement("embed");
    emb.src = `/files/${doc.file_path}`;
    emb.type = "application/pdf";
    emb.className = "pdf-view";
    desk.append(emb);
  }

  if (page.source_ref) {
    const ref = document.createElement("p");
    ref.className = "hint";
    const a = document.createElement("a");
    a.href = page.source_ref;
    a.target = "_blank";
    a.rel = "noreferrer";
    a.textContent = "Open this passage on Dharmamitra";
    ref.append(a);
    desk.append(ref);
  }

  const srcLabel = document.createElement("h3");
  srcLabel.textContent = `Source text (${page.source_kind === "none" ? "empty" : page.source_kind})`;
  desk.append(srcLabel);
  const src = document.createElement("textarea");
  src.className = "source";
  src.value = page.source_text;
  src.onblur = () => savePage(page, { source_text: src.value });
  desk.append(src);

  const row = document.createElement("div");
  row.className = "nav";
  if (page.image_path) {
    const ocrLang = document.createElement("select");
    for (const [v, label] of [["bod", "Tibetan"], ["san", "Sanskrit"], ["bod+san", "Tibetan or Sanskrit"]]) {
      const o = document.createElement("option");
      o.value = v;
      o.textContent = label;
      ocrLang.append(o);
    }
    ocrLang.value = doc.ocr_lang;
    const ocrBtn = document.createElement("button");
    ocrBtn.textContent = "OCR this page";
    ocrBtn.onclick = async () => {
      ocrBtn.disabled = true;
      try {
        const data = await api(`/api/docs/${doc.id}/pages/${page.page_no}/ocr`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ lang: ocrLang.value }),
        });
        cur.pages[pageIdx] = data.page;
        renderDesk();
        showMsg("OCR done.");
      } catch (e) { showMsg(e.message, true); }
      ocrBtn.disabled = false;
    };
    row.append(ocrLang, ocrBtn);
  } else {
    const note = document.createElement("span");
    note.className = "hint";
    note.textContent = "No image on this page — render the PDF into pages to OCR per page.";
    row.append(note);
  }
  desk.append(row);

  const trLabel = document.createElement("h3");
  trLabel.textContent = "Translation (English — editable)";
  desk.append(trLabel);
  const tr = document.createElement("textarea");
  tr.className = "translation";
  tr.value = page.translation;
  tr.onblur = () => savePage(page, { translation: tr.value });
  desk.append(tr);
  const trBtn = document.createElement("button");
  trBtn.textContent = "Translate this page (Ollama)";
  trBtn.onclick = async () => {
    trBtn.disabled = true;
    try {
      const data = await api(`/api/docs/${doc.id}/pages/${page.page_no}/translate`, { method: "POST" });
      cur.pages[pageIdx] = data.page;
      renderDesk();
      showMsg("Translated.");
    } catch (e) { showMsg(e.message, true); }
    trBtn.disabled = false;
  };
  desk.append(trBtn);

  const nLabel = document.createElement("h3");
  nLabel.textContent = "Notes";
  desk.append(nLabel);
  const notes = document.createElement("textarea");
  notes.className = "notes";
  notes.value = page.notes;
  notes.onblur = () => savePage(page, { notes: notes.value });
  desk.append(notes);
}

async function savePage(page, patch) {
  try {
    const data = await api(`/api/docs/${cur.doc.id}/pages/${page.page_no}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    });
    cur.pages[pageIdx] = data.page;
  } catch (e) {
    showMsg(e.message, true);
  }
}

// ---- Datasources: UTokyo Sanskrit Manuscripts (IIIF) ----
let dsItems = [];
let dsTitle = "";
let dsAttribution = "";

function openDatasource() {
  const desk = $("desk");
  desk.replaceChildren();
  const h = document.createElement("h2");
  h.textContent = "UTokyo Sanskrit Manuscripts";
  desk.append(h);
  const loading = document.createElement("p");
  loading.className = "hint";
  loading.textContent = "Loading the catalogue…";
  desk.append(loading);
  api("/api/datasources/utokyo")
    .then((data) => {
      dsItems = data.items;
      dsTitle = data.title;
      dsAttribution = data.attribution;
      renderDsList("");
    })
    .catch((e) => {
      loading.textContent = "";
      showMsg(e.message, true);
    });
}

function renderDsList(filter) {
  const desk = $("desk");
  desk.replaceChildren();
  const h = document.createElement("h2");
  h.textContent = dsTitle || "UTokyo Sanskrit Manuscripts";
  desk.append(h);
  const meta = document.createElement("p");
  meta.className = "hint";
  meta.textContent = `${dsItems.length} manuscripts · ${dsAttribution || "The University of Tokyo and The SAT Daizōkyō Database Committee"}`;
  desk.append(meta);
  const input = document.createElement("input");
  input.type = "text";
  input.placeholder = "Filter by title or catalogue number…";
  input.value = filter;
  input.oninput = () => renderDsList(input.value);
  desk.append(input);
  const q = filter.trim().toLowerCase();
  const shown = q
    ? dsItems.filter((it) => it.title.toLowerCase().includes(q) || it.manifest.toLowerCase().includes(q))
    : dsItems;
  const count = document.createElement("p");
  count.className = "hint";
  count.textContent = q ? `${shown.length} of ${dsItems.length} shown` : `${shown.length} shown`;
  desk.append(count);
  const ul = document.createElement("ul");
  for (const it of shown) {
    const li = document.createElement("li");
    const b = document.createElement("button");
    b.textContent = it.title;
    b.onclick = () => openDsDetail(it.manifest, it.title);
    li.append(b);
    ul.append(li);
  }
  desk.append(ul);
}

async function openDsDetail(manifest, fallbackTitle) {
  const desk = $("desk");
  desk.replaceChildren();
  const h = document.createElement("h2");
  h.textContent = fallbackTitle;
  desk.append(h);
  const loading = document.createElement("p");
  loading.className = "hint";
  loading.textContent = "Loading manuscript…";
  desk.append(loading);
  let m;
  try {
    m = await api(`/api/datasources/utokyo/manifest?url=${encodeURIComponent(manifest)}`);
  } catch (e) {
    showMsg(e.message, true);
    return;
  }
  desk.replaceChildren();
  const title = document.createElement("h2");
  title.textContent = m.title || m.label || fallbackTitle;
  desk.append(title);
  const meta = document.createElement("p");
  meta.className = "hint";
  meta.textContent = `${m.label} · ${m.canvases.length} page image(s) · ${m.license ? "CC BY 4.0" : ""}`;
  desk.append(meta);

  const nav = document.createElement("div");
  nav.className = "nav";
  const back = document.createElement("button");
  back.textContent = "‹ Back to catalogue";
  back.onclick = () => renderDsList("");
  nav.append(back);
  const mirador = document.createElement("a");
  mirador.href = m.mirador;
  mirador.target = "_blank";
  mirador.rel = "noreferrer";
  mirador.textContent = "Open in Mirador (full resolution)";
  nav.append(mirador);
  const imp = document.createElement("button");
  imp.textContent = "Import into library";
  imp.onclick = async () => {
    imp.disabled = true;
    imp.textContent = "Importing pages… (long manuscripts take a while)";
    try {
      const data = await api("/api/datasources/utokyo/import", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ manifest }),
      });
      await loadDocs();
      showMsg(
        data.already
          ? "Already in the library — opened the existing copy."
          : `Imported ${data.pages.length} page(s) at 2000px wide.` +
              (data.failures && data.failures.length ? ` ${data.failures.length} page(s) failed to download.` : ""),
      );
      await openDoc(data.doc.id);
    } catch (e) {
      showMsg(e.message, true);
      imp.disabled = false;
      imp.textContent = "Import into library";
    }
  };
  nav.append(imp);
  desk.append(nav);

  if (m.metadata.length) {
    const dl = document.createElement("dl");
    for (const row of m.metadata) {
      const dt = document.createElement("dt");
      dt.textContent = row.label;
      const dd = document.createElement("dd");
      dd.textContent = row.value;
      dl.append(dt, dd);
    }
    desk.append(dl);
  }
  const thumbs = document.createElement("div");
  thumbs.className = "thumbs";
  for (const c of m.canvases) {
    const fig = document.createElement("figure");
    const img = document.createElement("img");
    img.src = c.thumb;
    img.alt = c.label;
    img.loading = "lazy";
    const cap = document.createElement("figcaption");
    cap.textContent = c.label;
    fig.append(img, cap);
    thumbs.append(fig);
  }
  desk.append(thumbs);
}

$("ds-utokyo").addEventListener("click", openDatasource);

// ---- Datasources: DharmaNexus corpora (GitHub, public domain / CC) ----
// The desk never calls the Dharmamitra API (its terms forbid feeding
// third-party apps); it reads the project's public GitHub corpora and
// links each imported page back to the Dharmamitra reader.
let corpusItems = [];
let corpusLang = "pa";
const CORPUS_LABELS = { pa: "Pāli", sa: "Sanskrit", zh: "Chinese" };

function corpusView() {
  const desk = $("desk");
  desk.replaceChildren();
  const h = document.createElement("h2");
  h.textContent = "DharmaNexus corpora";
  desk.append(h);
  const hint = document.createElement("p");
  hint.className = "hint";
  hint.textContent = "Full texts from the DharmaNexus GitHub corpora (public domain / CC). Imported as text pages — no OCR needed — each page links to its exact passage on Dharmamitra. Tibetan has no public corpus repo, so it is not listed here.";
  desk.append(hint);
  const nav = document.createElement("div");
  nav.className = "nav";
  for (const lang of ["pa", "sa", "zh"]) {
    const b = document.createElement("button");
    b.textContent = CORPUS_LABELS[lang];
    b.disabled = lang === corpusLang;
    b.onclick = () => { corpusLang = lang; corpusView(); };
    nav.append(b);
  }
  desk.append(nav);
  const loading = document.createElement("p");
  loading.className = "hint";
  loading.textContent = "Loading the catalogue… (the Chinese catalogue is large; first load takes a while)";
  desk.append(loading);
  api(`/api/datasources/corpus/catalog?lang=${corpusLang}`)
    .then((data) => {
      corpusItems = data.items;
      renderCorpusList("");
    })
    .catch((e) => {
      loading.textContent = "";
      showMsg(e.message, true);
    });
}

function renderCorpusList(filter) {
  const desk = $("desk");
  desk.replaceChildren();
  const h = document.createElement("h2");
  h.textContent = `DharmaNexus corpora — ${CORPUS_LABELS[corpusLang]}`;
  desk.append(h);
  const nav = document.createElement("div");
  nav.className = "nav";
  for (const lang of ["pa", "sa", "zh"]) {
    const b = document.createElement("button");
    b.textContent = CORPUS_LABELS[lang];
    b.disabled = lang === corpusLang;
    b.onclick = () => { corpusLang = lang; corpusView(); };
    nav.append(b);
  }
  desk.append(nav);
  const input = document.createElement("input");
  input.type = "text";
  input.placeholder = "Filter by title, reference, or filename…";
  input.value = filter;
  input.oninput = () => renderCorpusList(input.value);
  desk.append(input);
  const q = filter.trim().toLowerCase();
  const shown = q
    ? corpusItems.filter((it) =>
        (it.displayName || "").toLowerCase().includes(q) ||
        (it.textname || "").toLowerCase().includes(q) ||
        (it.filename || "").toLowerCase().includes(q) ||
        (it.collection || "").toLowerCase().includes(q))
    : corpusItems;
  const count = document.createElement("p");
  count.className = "hint";
  const capped = shown.slice(0, 200);
  count.textContent = q
    ? `${shown.length} match(es)${shown.length > 200 ? " — showing the first 200, refine the filter" : ""}`
    : `${corpusItems.length} texts — showing the first 200, filter to narrow`;
  desk.append(count);
  const ul = document.createElement("ul");
  for (const it of capped) {
    const li = document.createElement("li");
    const b = document.createElement("button");
    b.textContent = `${it.displayName || it.filename}${it.textname ? ` (${it.textname})` : ""}`;
    b.onclick = () => openCorpusText(it.filename, it.displayName || it.filename);
    const meta = document.createElement("span");
    meta.className = "hint";
    meta.textContent = ` ${it.collection || ""}${it.collection && it.category ? " · " : ""}${it.category || ""}`;
    li.append(b, meta);
    ul.append(li);
  }
  desk.append(ul);
}

async function openCorpusText(file, fallbackTitle) {
  const desk = $("desk");
  desk.replaceChildren();
  const h = document.createElement("h2");
  h.textContent = fallbackTitle;
  desk.append(h);
  const loading = document.createElement("p");
  loading.className = "hint";
  loading.textContent = "Loading text…";
  desk.append(loading);
  let t;
  try {
    t = await api(`/api/datasources/corpus/text?lang=${corpusLang}&file=${encodeURIComponent(file)}`);
  } catch (e) {
    showMsg(e.message, true);
    return;
  }
  desk.replaceChildren();
  const title = document.createElement("h2");
  title.textContent = t.displayName || fallbackTitle;
  desk.append(title);
  const meta = document.createElement("p");
  meta.className = "hint";
  meta.textContent = `${t.textname ? t.textname + " · " : ""}${t.collection || ""}${t.category ? " · " + t.category : ""}${t.author ? " · " + t.author : ""} · ${t.segmentCount} segment(s)`;
  desk.append(meta);
  const nav = document.createElement("div");
  nav.className = "nav";
  const back = document.createElement("button");
  back.textContent = "‹ Back to catalogue";
  back.onclick = () => renderCorpusList("");
  nav.append(back);
  const reader = document.createElement("a");
  reader.href = t.reader;
  reader.target = "_blank";
  reader.rel = "noreferrer";
  reader.textContent = "Open on Dharmamitra";
  nav.append(reader);
  const imp = document.createElement("button");
  imp.textContent = "Import into library";
  imp.onclick = async () => {
    imp.disabled = true;
    imp.textContent = "Importing text…";
    try {
      const data = await api("/api/datasources/corpus/import", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ lang: corpusLang, file, title: t.displayName || fallbackTitle }),
      });
      await loadDocs();
      showMsg(data.already ? "Already in the library — opened the existing copy." : `Imported ${data.pages.length} text page(s).`);
      await openDoc(data.doc.id);
    } catch (e) {
      showMsg(e.message, true);
      imp.disabled = false;
      imp.textContent = "Import into library";
    }
  };
  nav.append(imp);
  desk.append(nav);
  const preview = document.createElement("div");
  for (const s of t.preview) {
    const p = document.createElement("p");
    p.textContent = `${s.segmentnr} — ${s.original}`;
    preview.append(p);
  }
  desk.append(preview);
}

$("ds-corpus").addEventListener("click", corpusView);

// ---- Datasources: CBETA reference resolve ----
async function cbetaResolveView() {
  const raw = $("cbeta-ref").value.trim();
  if (!raw) { showMsg("Paste a CBETA reference first.", true); return; }
  const desk = $("desk");
  desk.replaceChildren();
  const h = document.createElement("h2");
  h.textContent = "CBETA passage";
  desk.append(h);
  const loading = document.createElement("p");
  loading.className = "hint";
  loading.textContent = "Resolving the reference… (scanning the volume's texts for the page)";
  desk.append(loading);
  let data;
  try {
    data = await api(`/api/datasources/cbeta/resolve?ref=${encodeURIComponent(raw)}`);
  } catch (e) {
    showMsg(e.message, true);
    return;
  }
  desk.replaceChildren();
  const title = document.createElement("h2");
  title.textContent = "CBETA passage";
  desk.append(title);
  const r = data.ref;
  const meta = document.createElement("p");
  meta.className = "hint";
  meta.textContent = `${r.canon} canon, volume ${r.volume}${r.edition ? ` · CBETA ${r.edition}` : ""} · page ${r.page}, column ${r.column}, line ${r.line} (page key ${r.pageKey})${r.textNo !== null ? ` · cited no. ${r.textNo}` : ""}`;
  desk.append(meta);
  for (const w of (data.warnings || [])) {
    const warn = document.createElement("p");
    warn.className = "hint";
    warn.textContent = `Note: ${w}`;
    desk.append(warn);
  }
  if (!data.found) {
    const p = document.createElement("p");
    p.textContent = data.note || "Passage not found in the corpus.";
    desk.append(p);
    if (data.cbeta) {
      const a = document.createElement("a");
      a.href = data.cbeta;
      a.target = "_blank";
      a.rel = "noreferrer";
      a.textContent = "Open on CBETA Online";
      desk.append(a);
    }
    return;
  }
  const hit = data.hit;
  const head = document.createElement("p");
  head.textContent = `${hit.displayName} (${hit.textname}, ${hit.ordinal}${hit.ordinal % 10 === 1 && hit.ordinal % 100 !== 11 ? "st" : hit.ordinal % 10 === 2 && hit.ordinal % 100 !== 12 ? "nd" : hit.ordinal % 10 === 3 && hit.ordinal % 100 !== 13 ? "rd" : "th"} text in volume ${r.volumeToken}) — juan file ${hit.filename}, segment ${hit.segmentnr}`;
  desk.append(head);
  const nav = document.createElement("div");
  nav.className = "nav";
  if (hit.cbeta) {
    const a = document.createElement("a");
    a.href = hit.cbeta;
    a.target = "_blank";
    a.rel = "noreferrer";
    a.textContent = "Open on CBETA Online";
    nav.append(a);
  }
  if (hit.reader) {
    const a = document.createElement("a");
    a.href = hit.reader;
    a.target = "_blank";
    a.rel = "noreferrer";
    a.textContent = "Open this passage on Dharmamitra";
    nav.append(a);
  }
  const imp = document.createElement("button");
  imp.textContent = "Import this juan into library";
  imp.onclick = async () => {
    imp.disabled = true;
    imp.textContent = "Importing…";
    try {
      const res = await api("/api/datasources/corpus/import", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ lang: "zh", file: hit.filename, title: `${hit.displayName} — juan ${hit.filename.split("_").pop()}`, segment: hit.segmentnr }),
      });
      await loadDocs();
      showMsg(res.already ? "Already in the library — opened at the passage." : "Imported — opened at the passage.");
      await openDoc(res.doc.id, res.targetPage || 1);
    } catch (e) {
      showMsg(e.message, true);
      imp.disabled = false;
      imp.textContent = "Import this juan into library";
    }
  };
  nav.append(imp);
  desk.append(nav);
  for (const line of [...hit.prev, hit.original, ...hit.next]) {
    const p = document.createElement("p");
    if (line === hit.original) p.style.fontWeight = "bold";
    p.textContent = line;
    desk.append(p);
  }
}

$("cbeta-form").addEventListener("submit", (ev) => {
  ev.preventDefault();
  cbetaResolveView();
});

// ---- Datasources: BDRC Library (live search -> instance -> volume) ----
let bdrcReturn = null;

function bdrcSearchView() {
  const desk = $("desk");
  desk.replaceChildren();
  const h = document.createElement("h2");
  h.textContent = "BDRC Library";
  desk.append(h);
  const meta = document.createElement("p");
  meta.className = "hint";
  meta.textContent = "Search the Buddhist Digital Resource Center by title or author (Wylie or Tibetan script) — or paste a BDRC id (MW…, W…, I…). Only open-access volumes can be imported; restricted ones are shown but not downloaded.";
  desk.append(meta);
  const row = document.createElement("div");
  row.className = "nav";
  const input = document.createElement("input");
  input.type = "text";
  input.placeholder = "e.g. lam rim chen mo, or MW3CN7814";
  input.id = "bdrc-q";
  const btn = document.createElement("button");
  btn.textContent = "Search";
  const go = async () => {
    const q = input.value.trim();
    if (!q) return;
    btn.disabled = true;
    btn.textContent = "Searching…";
    try {
      const data = await api(`/api/datasources/bdrc/search?q=${encodeURIComponent(q)}`);
      if (data.direct) {
        if (data.direct === "instance") await openBdrcInstance(data.id, bdrcSearchView);
        else if (data.direct === "work") await openBdrcWork(data.id, bdrcSearchView);
        else await openBdrcVolume(data.id, "", "bod", bdrcSearchView);
        return;
      }
      renderBdrcHits(data.hits || [], q);
    } catch (e) {
      showMsg(e.message, true);
    }
    btn.disabled = false;
    btn.textContent = "Search";
  };
  btn.onclick = go;
  input.onkeydown = (ev) => { if (ev.key === "Enter") { ev.preventDefault(); go(); } };
  row.append(input, btn);
  desk.append(row);
}

function renderBdrcHits(hits, q) {
  const desk = $("desk");
  desk.replaceChildren();
  const h = document.createElement("h2");
  h.textContent = `BDRC results for “${q}”`;
  desk.append(h);
  const meta = document.createElement("p");
  meta.className = "hint";
  meta.textContent = hits.length ? `${hits.length} match(es) — instances and works with matching titles or names.` : "No matches. Try Wylie transliteration, or a BDRC id.";
  desk.append(meta);
  const back = document.createElement("button");
  back.textContent = "‹ New search";
  back.onclick = bdrcSearchView;
  desk.append(back);
  const ul = document.createElement("ul");
  for (const hit of hits) {
    const li = document.createElement("li");
    const b = document.createElement("button");
    b.textContent = `${hit.literal || hit.id} (${hit.id})`;
    b.onclick = async () => {
      if (hit.kind === "instance") await openBdrcInstance(hit.id, () => renderBdrcHits(hits, q));
      else if (hit.kind === "work") await openBdrcWork(hit.id, () => renderBdrcHits(hits, q));
      else await openBdrcVolume(hit.id, hit.literal, "bod", () => renderBdrcHits(hits, q));
    };
    li.append(b);
    ul.append(li);
  }
  desk.append(ul);
}

async function openBdrcInstance(id, backFn) {
  const desk = $("desk");
  desk.replaceChildren();
  const h = document.createElement("h2");
  h.textContent = id;
  desk.append(h);
  const loading = document.createElement("p");
  loading.className = "hint";
  loading.textContent = "Loading instance…";
  desk.append(loading);
  let data;
  try {
    data = await api(`/api/datasources/bdrc/instance?id=${encodeURIComponent(id)}`);
  } catch (e) {
    showMsg(e.message, true);
    return;
  }
  desk.replaceChildren();
  const title = document.createElement("h2");
  title.textContent = data.info.title || id;
  desk.append(title);
  const meta = document.createElement("p");
  meta.className = "hint";
  meta.textContent = [data.info.publisher, data.info.location, data.info.extent, data.info.script, data.info.printMethod].filter(Boolean).join(" · ");
  desk.append(meta);
  const nav = document.createElement("div");
  nav.className = "nav";
  if (backFn) {
    const back = document.createElement("button");
    back.textContent = "‹ Back";
    back.onclick = backFn;
    nav.append(back);
  }
  const lib = document.createElement("a");
  lib.href = data.library;
  lib.target = "_blank";
  lib.rel = "noreferrer";
  lib.textContent = "Open in BDRC Library";
  nav.append(lib);
  desk.append(nav);
  const vh = document.createElement("h3");
  vh.textContent = `Volumes (${data.volumes.length})`;
  desk.append(vh);
  const ul = document.createElement("ul");
  for (const v of data.volumes) {
    const li = document.createElement("li");
    const b = document.createElement("button");
    const open = v.access === "AccessOpen";
    b.textContent = `Volume ${v.num} (${v.id}) — ${open ? "open access" : v.access === "AccessFairUse" ? "restricted, not importable" : "access unknown"}`;
    b.disabled = false;
    b.onclick = () => openBdrcVolume(v.id, `${data.info.title || id} — volume ${v.num}`, data.ocr_lang || "bod", () => openBdrcInstance(id, backFn));
    li.append(b);
    ul.append(li);
  }
  desk.append(ul);
}

async function openBdrcWork(id, backFn) {
  const desk = $("desk");
  desk.replaceChildren();
  const h = document.createElement("h2");
  h.textContent = id;
  desk.append(h);
  const loading = document.createElement("p");
  loading.className = "hint";
  loading.textContent = "Loading work…";
  desk.append(loading);
  let data;
  try {
    data = await api(`/api/datasources/bdrc/work?id=${encodeURIComponent(id)}`);
  } catch (e) {
    showMsg(e.message, true);
    return;
  }
  desk.replaceChildren();
  const title = document.createElement("h2");
  title.textContent = data.title || id;
  desk.append(title);
  const nav = document.createElement("div");
  nav.className = "nav";
  if (backFn) {
    const back = document.createElement("button");
    back.textContent = "‹ Back";
    back.onclick = backFn;
    nav.append(back);
  }
  const lib = document.createElement("a");
  lib.href = data.library;
  lib.target = "_blank";
  lib.rel = "noreferrer";
  lib.textContent = "Open in BDRC Library";
  nav.append(lib);
  desk.append(nav);
  const vh = document.createElement("h3");
  vh.textContent = `Volumes (${data.volumes.length})`;
  desk.append(vh);
  const ul = document.createElement("ul");
  for (const v of data.volumes) {
    const li = document.createElement("li");
    const b = document.createElement("button");
    const open = v.access === "AccessOpen";
    b.textContent = `Volume ${v.num} (${v.id}) — ${open ? "open access" : v.access === "AccessFairUse" ? "restricted, not importable" : "access unknown"}`;
    b.onclick = () => openBdrcVolume(v.id, `${data.title || id} — volume ${v.num}`, "bod", () => openBdrcWork(id, backFn));
    li.append(b);
    ul.append(li);
  }
  desk.append(ul);
}

async function openBdrcVolume(id, titleHint, ocrLang, backFn) {
  const desk = $("desk");
  desk.replaceChildren();
  const h = document.createElement("h2");
  h.textContent = titleHint || id;
  desk.append(h);
  const loading = document.createElement("p");
  loading.className = "hint";
  loading.textContent = "Loading volume…";
  desk.append(loading);
  let data;
  try {
    data = await api(`/api/datasources/bdrc/volume?id=${encodeURIComponent(id)}`);
  } catch (e) {
    showMsg(e.message, true);
    return;
  }
  desk.replaceChildren();
  const title = document.createElement("h2");
  title.textContent = titleHint || `${data.label} (${id})`;
  desk.append(title);
  const open = data.info && data.info.access === "AccessOpen";
  const meta = document.createElement("p");
  meta.className = "hint";
  meta.textContent = `${data.label} · ${data.canvases.length} page image(s) · access: ${data.info ? data.info.access : "unknown"}` +
    (data.info && data.info.restrictedInChina ? " · note: BDRC marks this volume restricted in China" : "");
  desk.append(meta);
  const nav = document.createElement("div");
  nav.className = "nav";
  if (backFn) {
    const back = document.createElement("button");
    back.textContent = "‹ Back";
    back.onclick = backFn;
    nav.append(back);
  }
  if (data.library) {
    const lib = document.createElement("a");
    lib.href = data.library;
    lib.target = "_blank";
    lib.rel = "noreferrer";
    lib.textContent = "Open in BDRC Library";
    nav.append(lib);
  }
  const imp = document.createElement("button");
  imp.textContent = open ? "Import volume into library" : "Import unavailable — volume is not open access";
  imp.disabled = !open;
  imp.onclick = async () => {
    imp.disabled = true;
    imp.textContent = "Importing pages… (long volumes take a while)";
    try {
      const res = await api("/api/datasources/bdrc/import", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ volume: id, title: titleHint || `${data.label} (${id})`, ocr_lang: ocrLang || "bod" }),
      });
      await loadDocs();
      showMsg(
        res.already
          ? "Already in the library — opened the existing copy."
          : `Imported ${res.pages.length} page(s) at 2000px wide.` +
              (res.failures && res.failures.length ? ` ${res.failures.length} page(s) failed to download.` : ""),
      );
      await openDoc(res.doc.id);
    } catch (e) {
      showMsg(e.message, true);
      imp.disabled = false;
      imp.textContent = "Import volume into library";
    }
  };
  nav.append(imp);
  desk.append(nav);
  const thumbs = document.createElement("div");
  thumbs.className = "thumbs";
  const shown = data.canvases.slice(0, 60);
  for (const c of shown) {
    const fig = document.createElement("figure");
    const img = document.createElement("img");
    img.src = c.thumb;
    img.alt = c.label;
    img.loading = "lazy";
    const cap = document.createElement("figcaption");
    cap.textContent = c.label;
    fig.append(img, cap);
    thumbs.append(fig);
  }
  desk.append(thumbs);
  if (data.canvases.length > shown.length) {
    const more = document.createElement("p");
    more.className = "hint";
    more.textContent = `Showing first ${shown.length} of ${data.canvases.length} pages — the import brings in all of them.`;
    desk.append(more);
  }
}

$("ds-bdrc").addEventListener("click", bdrcSearchView);

$("upload").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const files = $("up-files").files;
  if (!files.length) { showMsg("Choose a PDF or images first.", true); return; }
  const form = new FormData();
  form.append("title", $("up-title").value);
  form.append("ocr_lang", $("up-lang").value);
  for (const f of files) form.append("files", f);
  try {
    const data = await api("/api/docs", { method: "POST", body: form });
    $("up-title").value = "";
    $("up-files").value = "";
    await loadDocs();
    await openDoc(data.doc.id);
    showMsg("Added to library.");
  } catch (e) { showMsg(e.message, true); }
});

$("settings").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  try {
    await api("/api/settings", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ollama_url: $("set-url").value,
        ollama_model: $("set-model").value,
      }),
    });
    showMsg("Settings saved.");
    loadTools();
  } catch (e) { showMsg(e.message, true); }
});

$("refresh-models").addEventListener("click", () => refreshModels($("set-model").value));

loadTools().catch((e) => showMsg(e.message, true));
loadDocs().catch((e) => showMsg(e.message, true));
loadSettings().catch((e) => showMsg(e.message, true));
