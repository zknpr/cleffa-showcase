// Batch mode: many images, one schema, up to eight requests in flight (the server micro-batches),
// a gallery with filters on every answer, and JSON/CSV export.

import { $, $$, el, fmtMs, fmtInt, quantile, downloadBlob } from "./dom.js";
import { systemone, describeError } from "./api.js";
import { buildRequest } from "./schema.js";
import { DecisionPanel, answerChips, answerText, fits, nearestLevel, optionColor } from "./answers.js";
import { prepareImage } from "./media.js";
import { FACTOR, MIN_PIXELS } from "./resize.js";
import { bindRange, setRadio, toast, droppedFiles, dropZone, openOverlay, overlayOpen } from "./ui.js";
import { settings, emit, on } from "./store.js";
import { snapshotConnection } from "./connection.js";

const MAX_ITEMS = 2000;
const B = {
  items: [], running: false, stop: false, startedAt: 0, doneAt: 0,
  questions: null, view: "grid", filters: new Map(), text: "", lb: { list: [], i: -1, panel: null }, pending: 0, okRun: 0, failRun: 0,
  config: null, run: null, facetKey: null, facetRows: [], tableKey: null,
};

export function initBatch() {
  on("connection", ({ enabled }) => { if (!enabled) B.stop = true; });
  on("connection", ({ backend }) => {
    const input = $("#batch-budget");
    input.min = backend === "hosted" ? "128" : "64";
    if (Number(input.value) < Number(input.min)) input.value = input.min;
    input.dispatchEvent(new Event("input"));
  });
  for (const id of ["batch-files", "batch-files-2", "batch-folder", "batch-folder-2"]) {
    $(`#${id}`).addEventListener("change", (e) => { addFiles([...e.target.files].map((file) => ({ file, path: file.webkitRelativePath || file.name }))); e.target.value = ""; });
  }
  dropZone($("#pane-batch"), $("#pane-batch"), async (dt) => {
    try { addFiles(await droppedFiles(dt, MAX_ITEMS * 2)); } catch (e) { toast(`could not read the drop: ${e.message}`, "bad"); }
  });
  $("#batch-run").addEventListener("click", run);
  $("#batch-stop").addEventListener("click", () => { B.stop = true; });
  $("#batch-clear").addEventListener("click", clear);
  const budgetNote = $("#batch-budget-ctl").title;
  bindRange($("#batch-budget"), $("#batch-budget-out"), (v) => fmtInt(v), (v) => {
    const side = Math.round(Math.sqrt(v) * FACTOR);
    $("#batch-budget-ctl").title = `${budgetNote}\n${settings.backend === "hosted" ? "Resized in the browser to" : "max_pixels"} ${fmtInt(v * FACTOR * FACTOR)}, about ${side}×${side}.`;
  });
  bindRange($("#batch-conc"), $("#batch-conc-out"));
  $("#batch-filter").addEventListener("input", (e) => { B.text = e.target.value.trim().toLowerCase(); applyFilters(); });
  $("#batch-reset").addEventListener("click", () => { B.filters.clear(); B.text = ""; $("#batch-filter").value = ""; applyFilters(); renderFacets(); });
  for (const b of $$("[data-view]", $("#pane-batch"))) b.addEventListener("click", () => setView(b.dataset.view));
  $("#batch-export-json").addEventListener("click", () => exportResults("json"));
  $("#batch-export-csv").addEventListener("click", () => exportResults("csv"));
  B.lb.panel = new DecisionPanel($("#lb-decisions"));
  $("#lb-prev").addEventListener("click", () => stepLightbox(-1));
  $("#lb-next").addEventListener("click", () => stepLightbox(1));
  document.addEventListener("keydown", (e) => {
    if (overlayOpen() !== $("#lightbox")) return;
    if (e.key === "ArrowLeft") { e.preventDefault(); stepLightbox(-1); }
    if (e.key === "ArrowRight") { e.preventDefault(); stepLightbox(1); }
  });
}

export function enterBatch() { /* the schema is read when a run starts */ }

// ------------------------------------------------------------------------------------- items

function addFiles(list) {
  let wrongType = 0, overCap = 0, added = 0;
  for (const { file, path } of list) {
    if (file.type !== "image/png" && file.type !== "image/jpeg") { wrongType++; continue; }
    if (B.items.length >= MAX_ITEMS) { overCap++; continue; }
    const it = { file, name: path || file.name, url: URL.createObjectURL(file), status: "queued", result: null, req: null, ms: null, server: null, tokens: null, error: null, shrunk: null };
    it.node = card(it);
    B.items.push(it);
    $("#batch-gallery").append(it.node);
    added++;
  }
  const notes = [];
  if (wrongType) notes.push(`${wrongType} skipped (not PNG or JPEG; the engine does not read WebP)`);
  if (overCap) notes.push(`${overCap} over the ${fmtInt(MAX_ITEMS)}-image limit of this page`);
  if (notes.length) toast(`${notes.join("; ")}.`, added ? "" : "bad");
  layout();
  applyFilters();
  status();
}

function clear() {
  if (B.running) return;
  for (const it of B.items) URL.revokeObjectURL(it.url);
  Object.assign(B, { items: [], questions: null, config: null, run: null, startedAt: 0, doneAt: 0, okRun: 0, failRun: 0, text: "", facetKey: null, tableKey: null });
  B.filters.clear();
  $("#batch-filter").value = "";
  $("#batch-gallery").replaceChildren();
  $("#batch-body").replaceChildren();
  layout();
  renderFacets();
  status();
}

function layout() {
  const has = B.items.length > 0;
  $("#batch-empty").hidden = has;
  $("#batch-main").hidden = !has;
}

function card(it) {
  const node = el("figure", { class: "gcard queued", tabindex: "0" }, [
    el("div", { class: "gthumb" }, [el("img", { src: it.url, alt: "", loading: "lazy", decoding: "async" }), el("span", { class: "gstate hud-chip", text: "queued" })]),
    el("figcaption", {}, [el("div", { class: "gname", text: it.name, title: it.name }), el("div", { class: "gmeta" }), el("div", { class: "chips" })]),
  ]);
  const open = () => openLightbox(it);
  node.addEventListener("click", open);
  node.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } });
  return node;
}

function updateCard(it) {
  const n = it.node;
  n.className = `gcard ${it.status}`;
  $(".gstate", n).textContent = it.status === "done" ? "✓" : it.status === "running" ? "reading…" : it.status;
  $(".gname", n).textContent = it.shrunk ? `${it.name} ↓` : it.name;
  $(".gname", n).title = it.shrunk ? `${it.name}: shrunk in the browser, ${it.shrunk}` : it.name;
  const meta = $(".gmeta", n);
  // With several in flight the server packs requests into one pass, so a request's time includes
  // its batch-mates; the status line's images per second is the throughput figure.
  meta.textContent = it.status === "done" ? `${fmtMs(it.server)}, ${fmtInt(it.tokens)} tokens` : "";
  meta.title = "Engine time of this request, including any requests packed into the same pass";
  const chips = $(".chips", n);
  if (it.status === "error") chips.replaceChildren(el("div", { class: "gerr", text: it.error, title: it.error }));
  else chips.replaceChildren(...answerChips(it.req?.questions, it.result?.answers));
  if (it.row) updateRow(it);
}

// ------------------------------------------------------------------------------------- run

async function run() {
  if (B.running) return;
  let base;
  try { base = buildRequest(["<image>"], {}, "batch"); } catch (e) { toast(`Questions: ${e.message}`, "bad"); return; }
  const budget = Number($("#batch-budget").value);
  const connection = snapshotConnection();
  // The reference's own bounds, so the engine resizes exactly as the processor would; the engine
  // rejects a lone bound, so both go together.
  const media_kwargs = { min_pixels: MIN_PIXELS, max_pixels: budget * FACTOR * FACTOR };
  // One configuration per result set: answers to other questions, from another model or backend,
  // or at another budget do not belong in one table, filter or export, so a change re-runs all.
  const config = { model: base.model, backend: settings.backend, state: base.state, media_kwargs, questions: base.questions };
  const key = JSON.stringify([config, connection.url, connection.revision]);
  if (B.config && B.config !== key) {
    for (const it of B.items) if (it.status === "done") { it.status = "queued"; it.result = null; }
    B.filters.clear();
  }
  B.config = key;
  B.run = config;
  B.questions = base.questions;
  const queue = B.items.filter((x) => x.status !== "done");
  if (!queue.length) { toast("Every image already has answers for this configuration."); return; }
  for (const it of queue) { it.status = "queued"; it.error = null; updateCard(it); }
  B.running = true;
  B.stop = false;
  B.startedAt = performance.now();
  B.okRun = 0;
  B.failRun = 0;
  setRunButtons();
  emit("activity", { mode: "batch", running: true });
  const worker = async () => {
    while (!B.stop) {
      const it = queue.shift();
      if (!it) return;
      it.status = "running";
      updateCard(it);
      try {
        const prep = await prepareImage(it.file);
        if (B.stop) { it.status = "queued"; updateCard(it); return; }
        it.shrunk = prep.shrunk ? `${prep.w}×${prep.h} → ${prep.shrunk.w}×${prep.shrunk.h}` : null;
        it.req = { model: base.model, state: base.state, images: [prep.dataUrl], media_kwargs, questions: base.questions };
        const r = await systemone(it.req, { source: "batch", connection });
        if (r.request.images[0] !== prep.dataUrl) it.shrunk = [it.shrunk, "Cloudflare budget resize"].filter(Boolean).join("; ");
        it.req = r.request;
        Object.assign(it, { result: r.body, ms: r.total, server: r.server, tokens: r.tokens, status: "done" });
        B.okRun++;
      } catch (e) {
        it.status = "error";
        it.error = describeError(e);
        B.failRun++;
      }
      updateCard(it);
      scheduleRefresh();
    }
  };
  await Promise.all(Array.from({ length: Math.min(Number($("#batch-conc").value), queue.length) }, worker));
  for (const it of queue) if (it.status === "queued") updateCard(it); // stopped before these
  B.running = false;
  B.doneAt = performance.now();
  setRunButtons();
  emit("activity", { mode: "batch", running: false });
  refresh();
}

function setRunButtons() {
  $("#batch-run").disabled = B.running;
  $("#batch-stop").disabled = !B.running;
  $("#batch-clear").disabled = B.running;
}

// Facets, filters and the table are rebuilt at most a few times a second while results stream in.
function scheduleRefresh() {
  if (B.pending) return;
  B.pending = setTimeout(() => { B.pending = 0; refresh(); }, 200);
}

function refresh() {
  status();
  renderFacets();
  applyFilters();
}

function status() {
  const total = B.items.length;
  const ok = B.items.filter((x) => x.status === "done").length;
  const failed = B.items.filter((x) => x.status === "error").length;
  $("#batch-progress i").style.width = total ? `${((ok + failed) / total) * 100}%` : "0";
  const parts = [`${ok + failed} / ${total}`];
  if (failed) parts.push(`${failed} failed`);
  if (B.startedAt && B.okRun + B.failRun) {
    const secs = ((B.running ? performance.now() : B.doneAt) - B.startedAt) / 1000;
    // Throughput counts images answered in the current run; errors are not throughput.
    if (secs > 0) parts.push(`${(B.okRun / secs).toFixed(2)} img/s`);
    parts.push(`median ${fmtMs(quantile(B.items.filter((x) => x.status === "done").map((x) => x.server), 0.5))}`);
  }
  $("#batch-status").textContent = parts.join(", ");
  $("#batch-export-json").disabled = $("#batch-export-csv").disabled = ok === 0;
}

// ------------------------------------------------------------------------------------- filters

function facetValue(q, a) {
  if (!fits(q, a)) return null;
  if (q.type === "noul") return a.noul >= 0.5 ? "yes" : "no";
  if (q.type === "choice") return a.choice;
  return String(nearestLevel(q, a));
}

// Built once per schema and updated in place, so a focused or half-clicked filter survives the
// refreshes that run several times a second while results stream in.
function renderFacets() {
  const box = $("#batch-facets");
  const key = B.questions ? JSON.stringify(B.questions) : "";
  if (key !== B.facetKey) {
    B.facetKey = key;
    B.facetRows = [];
    if (!B.questions) box.replaceChildren(el("p", { class: "panel-note", text: "Filters appear once results arrive." }));
    else box.replaceChildren(...Object.entries(B.questions).map(([id, q]) => {
      const values = q.type === "noul" ? ["yes", "no"] : q.type === "choice" ? Object.keys(q.criteria) : q.criteria.map((_, k) => String(k));
      const rows = values.map((v, k) => {
        const sw = el("i", { class: "sw" });
        sw.style.background = q.type === "choice" ? optionColor(k) : q.type === "noul" ? (v === "yes" ? "var(--yes)" : "var(--no)") : "var(--score)";
        const bar = el("i", { class: "fbar" });
        const n = el("span", { class: "n", text: "0" });
        const level = q.type === "score" ? q.criteria[k] : null;
        const label = level == null ? v : `${v} · ${typeof level === "string" ? level : JSON.stringify(level)}`;
        const node = el("button", { type: "button", class: "facet-row", "aria-pressed": "false", onclick: () => {
          if (B.filters.get(id) === v) B.filters.delete(id); else B.filters.set(id, v);
          applyFilters();
          renderFacets();
        } }, [bar, sw, el("span", { class: "name", text: label }), n]);
        B.facetRows.push({ id, v, label, node, bar, n });
        return node;
      });
      return el("div", { class: "facet" }, [el("h4", { text: id, title: id }), ...rows]);
    }));
  }
  if (!B.questions) { $("#batch-reset").hidden = true; return; }
  const counts = new Map();
  for (const it of B.items) {
    if (it.status !== "done") continue;
    for (const [id, q] of Object.entries(B.questions)) {
      const v = facetValue(q, it.result.answers?.[id]);
      if (v != null) counts.set(`${id}\u0000${v}`, (counts.get(`${id}\u0000${v}`) ?? 0) + 1);
    }
  }
  const max = new Map();
  for (const r of B.facetRows) max.set(r.id, Math.max(max.get(r.id) ?? 1, counts.get(`${r.id}\u0000${r.v}`) ?? 0));
  for (const r of B.facetRows) {
    const c = counts.get(`${r.id}\u0000${r.v}`) ?? 0;
    r.bar.style.width = `${(c / max.get(r.id)) * 100}%`;
    r.n.textContent = String(c);
    r.node.title = `${r.id} = ${r.label}: ${c}`;
    r.node.setAttribute("aria-pressed", String(B.filters.get(r.id) === r.v));
  }
  $("#batch-reset").hidden = !B.filters.size && !B.text;
}

function passes(it) {
  if (B.text) {
    const hay = `${it.name} ${it.result ? JSON.stringify(it.result.answers) : ""} ${it.error ?? ""}`.toLowerCase();
    if (!hay.includes(B.text)) return false;
  }
  for (const [id, v] of B.filters) {
    const q = B.questions?.[id];
    if (!q || it.status !== "done" || facetValue(q, it.result.answers?.[id]) !== v) return false;
  }
  return true;
}

function visible() { return B.items.filter(passes); }

function applyFilters() {
  let shown = 0;
  for (const it of B.items) { const ok = passes(it); it.node.hidden = !ok; if (it.row) it.row.hidden = !ok; if (ok) shown++; }
  const filtered = B.filters.size || B.text;
  $("#batch-count").textContent = B.items.length ? (filtered ? `${shown} of ${B.items.length} images` : `${B.items.length} image${B.items.length === 1 ? "" : "s"}`) : "";
  $("#batch-reset").hidden = !filtered;
  if (B.view === "table") renderTable();
}

function setView(v) {
  B.view = v;
  setRadio($("#pane-batch .view-bar"), "data-view", v);
  $("#batch-gallery").hidden = v !== "grid";
  $("#batch-table").hidden = v !== "table";
  if (v === "table") renderTable();
}

// One row per image, created once and updated in place like the gallery cards.
function renderTable() {
  const key = JSON.stringify(B.questions ?? {});
  if (key !== B.tableKey) {
    B.tableKey = key;
    const qs = Object.entries(B.questions ?? {});
    $("#batch-head").replaceChildren(el("th"), el("th", { text: "file" }), ...qs.map(([id, q]) => el("th", { text: id, title: q.type })), el("th", { text: "tokens" }), el("th", { text: "engine ms" }), el("th", { text: "status" }));
    for (const it of B.items) it.row = null;
    $("#batch-body").replaceChildren();
  }
  const body = $("#batch-body");
  for (const it of B.items) {
    if (!it.row) {
      const n = Object.keys(B.questions ?? {}).length;
      it.row = el("tr", {}, [el("td", {}, [el("img", { src: it.url, alt: "", loading: "lazy" })]), ...Array.from({ length: n + 4 }, () => el("td"))]);
      it.row.addEventListener("click", () => openLightbox(it));
      body.append(it.row);
    }
    updateRow(it);
    it.row.hidden = !passes(it);
  }
}

function updateRow(it) {
  const qs = Object.entries(B.questions ?? {});
  const td = it.row.children;
  td[1].textContent = it.shrunk ? `${it.name} ↓` : it.name;
  td[1].title = it.name;
  qs.forEach(([id, q], j) => {
    const a = it.result?.answers?.[id];
    td[2 + j].className = q.type === "noul" && fits(q, a) ? (a.noul >= 0.5 ? "yes" : "no") : "";
    td[2 + j].textContent = it.status === "done" ? answerText(q, a) : "";
  });
  const k = 2 + qs.length;
  td[k].className = td[k + 1].className = "num";
  td[k].textContent = fmtInt(it.tokens);
  td[k + 1].textContent = it.server != null ? String(Math.round(it.server)) : "—";
  td[k + 2].className = it.status === "error" ? "err" : "";
  td[k + 2].textContent = it.status === "error" ? it.error : it.status;
}

// ------------------------------------------------------------------------------------- lightbox

function openLightbox(it) {
  B.lb.list = visible();
  B.lb.i = B.lb.list.indexOf(it);
  showLightbox();
  openOverlay($("#lightbox"), { scrim: false });
}

function stepLightbox(d) {
  if (!B.lb.list.length) return;
  B.lb.i = (B.lb.i + d + B.lb.list.length) % B.lb.list.length;
  showLightbox();
}

function showLightbox() {
  const it = B.lb.list[B.lb.i];
  if (!it) return;
  $("#lb-img").src = it.url;
  $("#lb-title").textContent = it.name;
  $("#lb-title").title = it.name;
  const meta = [`${B.lb.i + 1} of ${B.lb.list.length}`];
  if (it.status === "done") meta.push(`${fmtInt(it.tokens)} input tokens`, `engine ${fmtMs(it.server)}`, `round trip ${fmtMs(it.ms)}`);
  else meta.push(it.status === "error" ? it.error : it.status);
  if (it.shrunk) meta.push(`shrunk in the browser, ${it.shrunk}`);
  $("#lb-meta").textContent = meta.join(", ");
  if (it.status === "done") B.lb.panel.show(it.req.questions, it.result.answers);
  else B.lb.panel.setQuestions(null, it.status === "error" ? "No answers: the request failed." : "Not answered yet.");
}

// ------------------------------------------------------------------------------------- export

function exportResults(kind) {
  const done = B.items.filter((x) => x.status === "done");
  if (!done.length) return;
  if (kind === "json") {
    // The shape of the earlier triage export, plus media_kwargs and shrunk_in_browser. Every done row
    // shares B.run, since run() re-runs everything when the configuration changes.
    const results = done.map((it) => ({ file: it.name, input_tokens: it.tokens, engine_ms: it.server, round_trip_ms: it.ms, backend: B.run.backend, shrunk_in_browser: it.shrunk, answers: it.result.answers }));
    const sizing = B.run.backend === "hosted"
      ? { browser_resize: { max_pixels: B.run.media_kwargs.max_pixels } }
      : { media_kwargs: B.run.media_kwargs };
    const body = { model: B.run.model, schema: B.questions, state: B.run.state, ...sizing, results };
    downloadBlob(new Blob([JSON.stringify(body, null, 2)], { type: "application/json" }), "batch.json");
    return;
  }
  // CSV quoting does not stop a spreadsheet from evaluating untrusted filenames or option IDs.
  const esc = (v) => {
    let text = String(v ?? "");
    if (/^[\s\u0000-\u001f]*[=+@-]/.test(text) || /^[\t\r\n]/.test(text)) text = `'${text}`;
    return `"${text.replace(/"/g, '""')}"`;
  };
  const qs = Object.entries(B.questions);
  const header = ["file", ...qs.flatMap(([id, q]) => (q.type === "noul" ? [id] : [id, `${id}_confidence`])), "input_tokens", "engine_ms"];
  const lines = [header.map(esc).join(",")];
  for (const it of done) {
    const vals = qs.flatMap(([id, q]) => {
      const a = it.result.answers?.[id];
      if (!fits(q, a)) return q.type === "noul" ? [""] : ["", ""];
      if (q.type === "noul") return [a.noul];
      if (q.type === "choice") return [a.choice, a.confidence];
      return [a.score, a.confidence];
    });
    lines.push([it.name, ...vals, it.tokens, it.server].map(esc).join(","));
  }
  downloadBlob(new Blob([`${lines.join("\n")}\n`], { type: "text/csv" }), "batch.csv");
}
