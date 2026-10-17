// Ask mode: one image, one audio clip (clef-omni) or both, many schemas. With reuse on, the proxy
// sends a per-session X-Clef-Prefix-Cache key, and clef-server's keyed cache can resume after the
// image (its merged features included) when only the questions change. The page cannot see a hit,
// only the time; the history therefore labels what was sent and shows what was measured. cleffa
// has no prefix reuse for Omni, so its requests go without a key.

import { $, el, fmtMs, fmtInt, quantile } from "./dom.js";
import { systemone, describeError, ApiError } from "./api.js";
import { buildRequest } from "./schema.js";
import { DecisionPanel, answerChips } from "./answers.js";
import { prepareImage, drawTokenGrid, loadImage, fileToDataUrl } from "./media.js";
import { smartResize, MIN_PIXELS } from "./resize.js";
import { AUDIO_RATE, MAX_AUDIO_FILE, MAX_AUDIO_SAMPLES, audioTokens, decodeAudio, drawWaveform, encodeWav } from "./audio.js";
import { isOmni, imageMaxPixels } from "./models.js";
import { dropZone } from "./ui.js";
import { on, settings } from "./store.js";
import { snapshotConnection } from "./connection.js";

const MAX_BODY = 8 * 1024 * 1024; // clef-server's default --max-body

// `gen` numbers the media on screen: an ask records its answers only if the image and audio it was
// sent with are still the ones shown, so replacing either mid-ask never files one input's answers
// under another. `loads` numbers the decodes of each kind, so a newer file of one kind supersedes
// an older one still decoding without cancelling a decode of the other kind.
const A = {
  dataUrl: null, name: null, w: 0, h: 0, source: null, resized: null, bounds: null, audio: null,
  asks: [], busy: false, gen: 0, grid: false, panel: null, selected: null,
  loads: { image: 0, audio: 0 }, loading: { image: false, audio: false }, reuseTitle: "", model: null,
};

export function initAsk() {
  A.panel = new DecisionPanel($("#ask-decisions"));
  A.reuseTitle = $("#ask-cache").parentElement.title;
  for (const id of ["ask-file", "ask-file-2"]) $(`#${id}`).addEventListener("change", (e) => { setImage(e.target.files[0]); e.target.value = ""; });
  for (const id of ["ask-audio", "ask-audio-2"]) $(`#${id}`).addEventListener("change", (e) => { setAudio(e.target.files[0]); e.target.value = ""; });
  dropZone($("#ask-stage"), $("#ask-stage"), (dt) => { const f = dt.files[0]; (/^(audio|video)\//.test(f?.type) ? setAudio : setImage)(f); }); // a video gives its sound
  $("#ask-audio-remove").addEventListener("click", removeAudio);
  $("#ask-go").addEventListener("click", ask);
  $("#ask-grid-toggle").addEventListener("click", (e) => {
    A.grid = !A.grid;
    e.currentTarget.setAttribute("aria-pressed", String(A.grid));
    paintGrid();
  });
  new ResizeObserver(() => { paintGrid(); paintWave(); }).observe($("#ask-stage"));
  // A model change is announced as a schema change for every mode, as is every edit.
  on("schema", (d) => { if (d.mode === "ask") { if (!A.selected) showPending(); if (settings.model !== A.model) modelChanged(); } });
  modelChanged();
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

const loadingAny = () => A.loading.image || A.loading.audio;
function refreshGo() { $("#ask-go").disabled = A.busy || loadingAny() || (!A.dataUrl && !A.audio); }

// The model sets what an image costs by default, whether audio can go at all, and whether reuse exists.
function modelChanged() {
  A.model = settings.model;
  const omni = isOmni(settings.model), reuse = $("#ask-cache");
  reuse.disabled = omni;
  reuse.parentElement.title = omni ? "cleffa has no prefix reuse for clef-omni; every ask runs in full." : A.reuseTitle;
  if (A.dataUrl && !A.bounds) showGeometry();
  showAudio();
}

// New media on screen: earlier answers belong to the earlier input.
function mediaChanged() {
  A.gen++;
  Object.assign(A, { asks: [], selected: null });
  $("#ask-empty").hidden = !!(A.dataUrl || A.audio);
  showAudio();
  refreshGo();
  setError("");
  showPending();
  renderHistory();
}

async function setImage(file) {
  if (!file) return;
  if (file.type !== "image/png" && file.type !== "image/jpeg") { setError(`${file.name}: PNG or JPEG only (the engine does not decode WebP)`); return; }
  const load = ++A.loads.image;
  A.loading.image = true;
  refreshGo();
  let prep;
  try { prep = await prepareImage(file); } catch (e) { if (load === A.loads.image) { A.loading.image = false; refreshGo(); setError(`${file.name}: ${e.message}`); } return; }
  if (load !== A.loads.image) return; // a newer image was chosen while this one decoded
  const img = $("#ask-img");
  img.src = prep.dataUrl;
  img.hidden = false;
  await img.decode().catch(() => {});
  if (load !== A.loads.image) return;
  A.loading.image = false;
  Object.assign(A, { dataUrl: prep.dataUrl, name: file.name, w: img.naturalWidth, h: img.naturalHeight, bounds: null, source: prep.shrunk ? { w: prep.w, h: prep.h } : null });
  showGeometry();
  mediaChanged();
}

function showGeometry() {
  A.resized = smartResize(A.h, A.w, MIN_PIXELS, imageMaxPixels(settings.model));
  const shrunk = A.source ? ` (shrunk from ${A.source.w}×${A.source.h})` : "";
  const geom = $("#ask-geom");
  geom.hidden = false;
  geom.textContent = A.resized
    ? `${A.w}×${A.h}${shrunk} → ${A.resized.w}×${A.resized.h}, ${fmtInt(A.resized.tokens)} image tokens`
    : `${A.w}×${A.h}: aspect ratio over 200, the processor rejects it`;
  $("#ask-grid-toggle").disabled = !A.resized;
  paintGrid();
}

// The clip is decoded, resampled and encoded once; the player plays the WAV the requests carry.
async function setAudio(file) {
  if (!file) return;
  if (file.size > MAX_AUDIO_FILE) { setError(`${file.name}: over ${MAX_AUDIO_FILE / 1048576} MiB; the browser decodes audio in one piece`); return; }
  const load = ++A.loads.audio;
  A.loading.audio = true;
  refreshGo();
  const done = (msg) => { if (load === A.loads.audio) { A.loading.audio = false; refreshGo(); if (msg) setError(`${file.name}: ${msg}`); } };
  let samples, wav, dataUrl;
  try {
    samples = await decodeAudio(await file.arrayBuffer());
    if (load !== A.loads.audio) return;
    if (!audioTokens(samples.length)) { done("too short: the model needs more than 200 samples (12.5 ms)"); return; }
    wav = encodeWav(samples);
    dataUrl = await fileToDataUrl(new Blob([wav], { type: "audio/wav" }));
  } catch (e) { done(`the browser could not decode this audio (${e.message})`); return; }
  if (load !== A.loads.audio) return;
  done();
  if (A.audio) URL.revokeObjectURL(A.audio.url);
  A.audio = { name: file.name, samples, dataUrl, bytes: wav.length, tokens: audioTokens(samples.length), url: URL.createObjectURL(new Blob([wav], { type: "audio/wav" })) };
  $("#ask-player").src = A.audio.url;
  mediaChanged();
}

function removeAudio() {
  if (!A.audio) return;
  A.loads.audio++; // a clip still decoding is dropped as well
  A.loading.audio = false;
  URL.revokeObjectURL(A.audio.url);
  $("#ask-player").removeAttribute("src");
  A.audio = null;
  mediaChanged();
}

function showAudio() {
  const a = A.audio;
  $("#ask-audio-box").hidden = !a;
  if (!a) return;
  const over = [];
  if (a.samples.length > MAX_AUDIO_SAMPLES) over.push(`${MAX_AUDIO_SAMPLES / AUDIO_RATE} s of audio`);
  if (a.dataUrl.length + (A.dataUrl?.length ?? 0) > MAX_BODY) over.push("8 MiB per request");
  const parts = [`${(a.samples.length / AUDIO_RATE).toFixed(1)} s`, "16 kHz mono", `${fmtInt(a.tokens)} audio tokens`];
  if (!isOmni(settings.model)) parts.push("needs clef-omni");
  else if (over.length) parts.push(`over clef-server's default ${over.join(" and ")}`);
  const geom = $("#ask-audio-geom");
  geom.textContent = parts.join(", ");
  geom.title = `${a.name}: ${fmtInt(a.samples.length)} samples, ${(a.bytes / 1048576).toFixed(2)} MiB as PCM16 WAV`;
  paintWave();
}

async function ask() {
  if ((!A.dataUrl && !A.audio) || A.busy || loadingAny()) return;
  const gen = A.gen, dataUrl = A.dataUrl;
  const extra = {};
  if (A.audio) extra.audio = [A.audio.dataUrl];
  if (A.bounds) extra.media_kwargs = A.bounds;
  let req;
  try { req = buildRequest(dataUrl ? [dataUrl] : [], extra, "ask"); } catch (e) { setError(`Questions: ${e.message}`); return; }
  if (req.audio && !isOmni(req.model)) {
    setError(`${req.model} takes no audio. Choose clef-omni in the connection menu (for local cleffa, start clef-server with gguf/clef-omni.gguf), or remove the audio.`);
    return;
  }
  const cache = $("#ask-cache").checked && !isOmni(req.model);
  const connection = snapshotConnection();
  A.busy = true;
  refreshGo();
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
    if (gen !== A.gen) return; // answered for media that has since been replaced
    if (retried) {
      A.bounds = retried;
      const rs = smartResize(A.h, A.w, MIN_PIXELS, retried.max_pixels);
      if (rs) { A.resized = rs; $("#ask-geom").textContent = `${A.w}×${A.h} → ${rs.w}×${rs.h} by the engine, ${fmtInt(rs.tokens)} image tokens`; paintGrid(); }
    }
    req = r.request;
    if (r.backend === "hosted" && dataUrl && req.images[0] !== dataUrl) {
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
    refreshGo();
    $("#ask-stage").classList.remove("busy");
    $("#ask-decisions").classList.remove("busy-panel");
  }
}

function renderHistory() {
  const list = $("#ask-history");
  const media = !!(A.dataUrl || A.audio);
  $("#ask-history-panel").hidden = !media;
  if (!A.asks.length) {
    list.replaceChildren(el("li", { class: "history-empty", text: media ? "Ask, then edit the questions and ask again to compare." : "Choose an image or a sound to start." }));
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

function paintWave() {
  if (A.audio && !$("#ask-audio-box").hidden) drawWaveform($("#ask-wave"), A.audio.samples);
}
