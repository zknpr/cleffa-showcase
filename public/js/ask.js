// Ask mode: one image, many schemas. With reuse on, the proxy sends a per-session
// X-Clef-Prefix-Cache key, and clef-server's keyed cache can resume after the image (its merged
// features included) when only the questions change. The page cannot see a hit, only the time;
// the history therefore labels what was sent and shows what was measured.

import { $, el, fmtMs, fmtInt, quantile } from "./dom.js";
import { systemone, describeError, ApiError } from "./api.js";
import { buildRequest } from "./schema.js";
import { DecisionPanel, answerChips } from "./answers.js";
import { prepareImage, drawTokenGrid, loadImage } from "./media.js";
import { smartResize, MIN_PIXELS } from "./resize.js";
import { dropZone } from "./ui.js";
import { on } from "./store.js";
import { snapshotConnection } from "./connection.js";

// `gen` numbers the image: an ask records its answers only if the image it was sent with is still
// the one on screen, so replacing the image mid-ask can never file one image's answers under another.
const A = { dataUrl: null, name: null, w: 0, h: 0, resized: null, bounds: null, asks: [], busy: false, loading: false, gen: 0, grid: false, panel: null, selected: null };

export function initAsk() {
  A.panel = new DecisionPanel($("#ask-decisions"));
  for (const id of ["ask-file", "ask-file-2"]) $(`#${id}`).addEventListener("change", (e) => { setImage(e.target.files[0]); e.target.value = ""; });
  dropZone($("#ask-stage"), $("#ask-stage"), (dt) => setImage(dt.files[0]));
  $("#ask-go").addEventListener("click", ask);
  $("#ask-grid-toggle").addEventListener("click", (e) => {
    A.grid = !A.grid;
    e.currentTarget.setAttribute("aria-pressed", String(A.grid));
    paintGrid();
  });
  new ResizeObserver(paintGrid).observe($("#ask-stage"));
  on("schema", (d) => { if (d.mode === "ask" && !A.selected) showPending(); });
  renderHistory();
}

export function enterAsk() { if (!A.asks.length) showPending(); }

export function askKey(e) {
  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); ask(); return true; }
  return false;
}

function setError(msg) { $("#ask-error").textContent = msg; }

function showPending() {
  try { A.panel.setQuestions(buildRequest(["<image>"], {}, "ask").questions); }
  catch (e) { A.panel.setQuestions(null, e.message); }
  $("#ask-which").textContent = "";
}

async function setImage(file) {
  if (!file) return;
  if (file.type !== "image/png" && file.type !== "image/jpeg") { setError(`${file.name}: PNG or JPEG only (the engine does not decode WebP)`); return; }
  const gen = ++A.gen;
  A.loading = true;
  $("#ask-go").disabled = true;
  let prep;
  try { prep = await prepareImage(file); } catch (e) { if (gen === A.gen) { A.loading = false; $("#ask-go").disabled = !A.dataUrl || A.busy; setError(`${file.name}: ${e.message}`); } return; }
  if (gen !== A.gen) return; // a newer image was chosen while this one decoded
  A.loading = false;
  Object.assign(A, { dataUrl: prep.dataUrl, name: file.name, bounds: null, asks: [], selected: null });
  const img = $("#ask-img");
  img.src = A.dataUrl;
  img.hidden = false;
  await img.decode().catch(() => {});
  if (gen !== A.gen) return;
  A.w = img.naturalWidth;
  A.h = img.naturalHeight;
  A.resized = smartResize(A.h, A.w);
  $("#ask-empty").hidden = true;
  $("#ask-go").disabled = A.busy;
  $("#ask-grid-toggle").disabled = !A.resized;
  const shrunk = prep.shrunk ? ` (shrunk from ${prep.w}×${prep.h})` : "";
  const geom = $("#ask-geom");
  geom.hidden = false;
  geom.textContent = A.resized
    ? `${A.w}×${A.h}${shrunk} → ${A.resized.w}×${A.resized.h}, ${fmtInt(A.resized.tokens)} image tokens`
    : `${A.w}×${A.h}: aspect ratio over 200, the processor rejects it`;
  setError("");
  showPending();
  renderHistory();
  paintGrid();
}

async function ask() {
  if (!A.dataUrl || A.busy || A.loading) return;
  const gen = A.gen, dataUrl = A.dataUrl;
  let req;
  try { req = buildRequest([dataUrl], A.bounds ? { media_kwargs: A.bounds } : {}, "ask"); } catch (e) { setError(`Questions: ${e.message}`); return; }
  const cache = $("#ask-cache").checked;
  const connection = snapshotConnection();
  A.busy = true;
  $("#ask-go").disabled = true;
  $("#ask-stage").classList.add("busy");
  $("#ask-decisions").classList.add("busy-panel");
  A.panel.setQuestions(req.questions);
  A.panel.update(null);
  try {
    let r, retried = false;
    try {
      r = await systemone(req, { cache, source: "ask", connection });
    } catch (e) {
      // "images[0]: WxH resizes to N tokens, above the limit of L per image; downscale it or pass
      // media_kwargs.max_pixels <= P": take the engine's own suggestion once, if allowed.
      const m = e instanceof ApiError && $("#ask-bounds").checked && /max_pixels <= (\d+)/.exec(e.message);
      if (!m || gen !== A.gen) throw e;
      const bounds = { min_pixels: MIN_PIXELS, max_pixels: Number(m[1]) };
      req = { ...req, media_kwargs: bounds };
      r = await systemone(req, { cache, source: "ask", connection });
      retried = bounds;
    }
    if (gen !== A.gen) return; // answered for an image that has since been replaced
    if (retried) {
      A.bounds = retried;
      const rs = smartResize(A.h, A.w, MIN_PIXELS, retried.max_pixels);
      if (rs) { A.resized = rs; $("#ask-geom").textContent = `${A.w}×${A.h} → ${rs.w}×${rs.h} by the engine, ${fmtInt(rs.tokens)} image tokens`; paintGrid(); }
    }
    req = r.request;
    if (r.backend === "hosted" && req.images[0] !== dataUrl) {
      const sent = await loadImage(req.images[0]);
      if (gen !== A.gen) return;
      A.resized = smartResize(sent.naturalHeight, sent.naturalWidth);
      $("#ask-geom").textContent = `${A.w}×${A.h} → ${sent.naturalWidth}×${sent.naturalHeight} uploaded, about ${fmtInt(A.resized.tokens)} image tokens`;
      paintGrid();
    }
    const entry = { n: A.asks.length + 1, req, answers: r.body.answers, server: r.server, total: r.total, tokens: r.tokens, cache: r.cache, backend: r.backend, retried: !!retried };
    A.asks.push(entry);
    A.selected = entry;
    A.panel.show(req.questions, r.body.answers);
    $("#ask-which").textContent = `ask #${entry.n}`;
    setError("");
    renderHistory();
  } catch (e) {
    if (gen !== A.gen) return;
    setError(describeError(e));
    if (A.selected) A.panel.show(A.selected.req.questions, A.selected.answers);
    else showPending();
  } finally {
    A.busy = false;
    $("#ask-go").disabled = A.loading || !A.dataUrl;
    $("#ask-stage").classList.remove("busy");
    $("#ask-decisions").classList.remove("busy-panel");
  }
}

function renderHistory() {
  const list = $("#ask-history");
  $("#ask-history-panel").hidden = !A.dataUrl;
  if (!A.asks.length) {
    list.replaceChildren(el("li", { class: "history-empty", text: A.dataUrl ? "Ask, then edit the questions and ask again to compare." : "Choose an image to start." }));
    $("#ask-summary").textContent = "";
    return;
  }
  const first = A.asks[0];
  const max = Math.max(...A.asks.map((x) => x.server ?? x.total));
  list.replaceChildren(...[...A.asks].reverse().map((x) => {
    const isFirst = x === first;
    // A cache key only makes reuse possible; the page cannot see a hit, so the tag says what was sent.
    const tag = isFirst ? el("span", { class: "tag first", text: "first" })
      : x.cache ? el("span", { class: "tag reuse", text: "cache key sent", title: "Sent with the same cache key as the first ask" })
      : "";
    const bar = el("i");
    const ms = x.server ?? x.total;
    const meta = [];
    if (!isFirst && first.server && x.server) meta.push(`${(x.server / first.server).toFixed(2)}× the first`);
    meta.push(`${fmtInt(x.tokens)} tokens`, `${Object.keys(x.req.questions).length} questions`);
    if (x.retried) meta.push("resent within the engine's bounds");
    const li = el("li", { class: `ask-item${isFirst ? " first" : ""}`, tabindex: "0", "aria-current": String(x === A.selected) }, [
      el("div", { class: "ask-top" }, [el("span", { class: "ask-n", text: `#${x.n}` }), tag, el("span", { class: "spacer" }), el("span", { class: "ask-ms", text: fmtMs(ms) })]),
      el("div", { class: "ask-bar" }, [bar]),
      el("div", { class: "ask-meta", text: meta.join(", "), title: `${x.backend}, round trip ${fmtMs(x.total)}` }),
      el("div", { class: "chips" }, answerChips(x.req.questions, x.answers)),
    ]);
    requestAnimationFrame(() => { bar.style.width = `${(ms / max) * 100}%`; });
    const pick = () => { A.selected = x; A.panel.show(x.req.questions, x.answers); $("#ask-which").textContent = `ask #${x.n}`; renderHistory(); };
    li.addEventListener("click", pick);
    li.addEventListener("keydown", (e) => { if (e.key === "Enter") pick(); });
    return li;
  }));
  const later = A.asks.slice(1).map((x) => x.server);
  $("#ask-summary").textContent = later.length
    ? `first ${fmtMs(first.server)}, then ${fmtMs(quantile(later, 0.5))} median`
    : `first ${fmtMs(first.server)}`;
}

function paintGrid() {
  const c = $("#ask-grid");
  const show = A.grid && !!A.dataUrl && !!A.resized;
  c.hidden = !show;
  if (show) drawTokenGrid(c, A.w, A.h, A.resized);
}
