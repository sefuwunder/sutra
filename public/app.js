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

async function openDoc(id) {
  const data = await api(`/api/docs/${id}`);
  cur = data;
  pageIdx = 0;
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
