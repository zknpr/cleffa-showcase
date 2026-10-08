// Video mode: a clip read as video, not as a stack of photos. The browser decodes the file (anything
// it can play), cuts it into equal windows and sends each window as one SystemOne request with
// `videos: [{frames, fps}]`. The engine merges each pair of consecutive frames into one grid of
// tokens and writes the pair's "<t seconds>" timestamp before it, so a question about motion or
// change is answered from the frames together. This needs a cleffa build with video support; the
// engine itself never sees the container or the codec, only the JPEG frames.
//
// Each window is its own clip: its frames are sent with do_sample_frames=false (the page already
// sampled them) and their timestamps restart at zero. A window answers for all of its frames, so a
// change inside one (a subject turning around) blurs into one answer; with overlap on, a window
// starts every half window and each is drawn over its central half, which places a change twice as
// precisely for twice the requests. The page computes the engine's frame budget
// with the processor's own video smart_resize, so the token cost on screen is the one the engine
// charges.

import { $, $$, el, icon, fmtMs, fmtInt, fmtClock, quantile } from "./dom.js";
import { systemone, describeError, ApiError } from "./api.js";
import { buildRequest, tryQuestions } from "./schema.js";
import { DecisionPanel } from "./answers.js";
import { Score } from "./score.js";
import { drawTokenGrid } from "./media.js";
import { videoResize, roundHalfEven, FACTOR, VIDEO_MIN_PIXELS, PIXELS_PER_VIDEO_TOKEN } from "./resize.js";
import { bindRange, dropZone, setRadio, toast } from "./ui.js";
import { settings, on, emit } from "./store.js";
import { snapshotConnection } from "./connection.js";

const GRAB_SIDE = 640;   // frames go out at most this long a side; the engine does the final resize
const GRAB_QUALITY = 0.85;
const THUMB_SIDE = 160;  // kept per frame for the filmstrip and the timeline's tooltip
const MAX_FRAMES = 32;   // clef-server's default --max-video-frames
const MAX_WINDOWS = 300;
const MAX_CLIP = 600;    // seconds: the engine's limit for one frame array, so for "whole clip"
const IN_FLIGHT = 2;     // the browser seeks out the next window while the engine reads this one

const V = {
  url: null, name: null, duration: 0, w: 0, h: 0, ready: false,
  winSec: 4, fps: 2, budget: 512, overlap: true,
  windows: [], qkey: "", current: -1, gen: 0, running: false, halt: false, grid: false,
  panel: null, score: null, raf: 0,
  probe: document.createElement("video"), canvas: document.createElement("canvas"), thumb: document.createElement("canvas"),
};

export function initVideo() {
  V.panel = new DecisionPanel($("#video-decisions"));
  V.score = new Score($("#video-score"), { fixed: true, emptyText: "Each analyzed window adds a slice to every lane.", onSeek: seek });
  V.probe.muted = true;
  V.probe.preload = "auto";
  V.probe.playsInline = true;
  for (const id of ["video-file", "video-file-2"]) $(`#${id}`).addEventListener("change", (e) => { load(e.target.files[0]); e.target.value = ""; });
  dropZone($("#video-stage"), $("#video-stage"), (dt) => load(dt.files[0]));
  $("#video-run").addEventListener("click", () => (V.running ? stop() : analyze()));
  for (const b of $$("[data-win]", $("#video-win"))) b.addEventListener("click", () => { V.winSec = Number(b.dataset.win); setRadio($("#video-win"), "data-win", b.dataset.win); replan(); });
  $("#video-overlap").addEventListener("change", (e) => { V.overlap = e.target.checked; replan(); });
  bindRange($("#video-fps"), $("#video-fps-out"), (v) => `${v} fps`, (v) => { V.fps = v; replan(); });
  bindRange($("#video-budget"), $("#video-budget-out"), (v) => fmtInt(v), (v) => { V.budget = v; replan(); });
  $("#video-grid-toggle").addEventListener("click", (e) => {
    V.grid = !V.grid;
    e.currentTarget.setAttribute("aria-pressed", String(V.grid));
    paintGrid();
  });
  const vid = $("#vid");
  vid.addEventListener("play", () => { V.raf ||= requestAnimationFrame(tick); });
  vid.addEventListener("seeked", syncPlayhead);
  vid.addEventListener("timeupdate", syncPlayhead);
  new ResizeObserver(paintGrid).observe($("#video-stage"));
  on("schema", (d) => { if (d.mode === "video") questionsChanged(); });
  questionsChanged();
  replan();
}

export function enterVideo() { questionsChanged(); }
// Playback stops behind another mode; an analysis keeps going, like a batch run, with the tab's badge on.
export function leaveVideo() { $("#vid").pause(); }

export function videoKey(e) {
  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); V.running ? stop() : analyze(); return true; }
  if (!V.ready || e.target === $("#vid")) return false; // the player's own controls handle their keys
  if (e.key === " ") { e.preventDefault(); const v = $("#vid"); v.paused ? v.play() : v.pause(); return true; }
  if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
    const k = windowAt($("#vid").currentTime) + (e.key === "ArrowRight" ? 1 : -1);
    if (V.windows[k]) { e.preventDefault(); seek(V.windows[k].s0 + 1e-3); return true; }
  }
  return false;
}

function setError(msg) { $("#video-error").textContent = msg; }

// ------------------------------------------------------------------------------------- the clip

async function load(file) {
  if (!file) return;
  if (file.type && !file.type.startsWith("video/")) { setError(`${file.name}: not a video file`); return; }
  stop();
  const generation = ++V.gen;
  if (V.url) URL.revokeObjectURL(V.url);
  Object.assign(V, { url: URL.createObjectURL(file), name: file.name, ready: false, duration: 0, w: 0, h: 0, windows: [], current: -1 });
  const vid = $("#vid");
  vid.src = V.url;
  V.probe.src = V.url;
  try {
    await Promise.all([loaded(vid), loaded(V.probe)]);
    if (generation !== V.gen) return;
    V.duration = await duration(V.probe);
  } catch (e) {
    if (generation !== V.gen) return;
    vid.removeAttribute("src");
    V.probe.removeAttribute("src");
    $("#video-empty").hidden = false;
    setError(`${file.name}: ${e.message}`);
    replan();
    return;
  }
  if (generation !== V.gen) return;
  V.w = V.probe.videoWidth;
  V.h = V.probe.videoHeight;
  V.ready = true;
  $("#video-empty").hidden = true;
  $("#video-grid-toggle").disabled = false;
  setError("");
  V.score.setRange(0, V.duration);
  replan();
  syncPlayhead();
}

function loaded(v) {
  if (v.readyState >= 1) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const ok = () => { off(); resolve(); };
    const bad = () => { off(); reject(new Error("the browser cannot decode this file (Chromium builds without proprietary codecs open WebM and VP9/AV1 MP4, not H.264)")); };
    const off = () => { v.removeEventListener("loadedmetadata", ok); v.removeEventListener("error", bad); };
    v.addEventListener("loadedmetadata", ok);
    v.addEventListener("error", bad);
  });
}

// A WebM written by MediaRecorder often has no duration in its header (Infinity) until the decoder
// has seen the end; a seek far past it makes the browser work it out.
async function duration(v) {
  if (!Number.isFinite(v.duration)) {
    await seekTo(v, 1e9).catch(() => {});
    await seekTo(v, 0).catch(() => {});
  }
  if (!(Number.isFinite(v.duration) && v.duration > 0)) throw new Error("the browser reports no duration for this file");
  return v.duration;
}

function seekTo(v, t) {
  if (Math.abs(v.currentTime - t) < 1e-6 && v.readyState >= 2) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const ok = () => { off(); resolve(); };
    const bad = () => { off(); reject(new Error("the browser could not seek in this video")); };
    const timer = setTimeout(bad, 8000);
    const off = () => { clearTimeout(timer); v.removeEventListener("seeked", ok); v.removeEventListener("error", bad); };
    v.addEventListener("seeked", ok);
    v.addEventListener("error", bad);
    v.currentTime = t;
  });
}

// The size frames are captured at: the clip's own size, or GRAB_SIDE on its longest side.
function grabSize(w = V.w || 1280, h = V.h || 720) {
  const s = Math.min(1, GRAB_SIDE / Math.max(w, h));
  return { w: Math.max(1, Math.round(w * s)), h: Math.max(1, Math.round(h * s)) };
}

// ------------------------------------------------------------------------------------- windows

// Equal windows close to the chosen length (a 10 s clip in 4 s windows is three of 3.3 s), each
// with an even number of frames centred in its slots: an odd count makes the engine repeat the
// last frame and can resize above the budget, since the scale factor uses the unpadded count.
// With overlap, windows start every half window (five 4 s windows over 12 s, not three), and each
// shows [s0, s1), its central half, extended to the clip's ends for the first and the last.
function plan(D = V.duration) {
  const g = grabSize();
  const whole = V.winSec === 0;
  const dur = D > 0 ? D : whole ? 12 : V.winSec; // before a clip: one window, to show its cost
  const cuts = whole ? 1 : Math.max(1, Math.round(dur / V.winSec));
  const len = dur / cuts;
  const overlap = V.overlap && cuts > 1;
  const step = overlap ? len / 2 : len;
  const count = overlap ? 2 * cuts - 1 : cuts;
  const n = Math.min(MAX_FRAMES, Math.max(2, 2 * Math.round((len * V.fps) / 2)));
  const resized = videoResize(n, g.h, g.w, VIDEO_MIN_PIXELS, V.budget * PIXELS_PER_VIDEO_TOKEN);
  let error = null;
  if (Math.min(g.w, g.h) < FACTOR) error = "the video is under 32 pixels on a side; the engine needs at least 32";
  else if (!resized) error = "the video's aspect ratio is over 200; the processor rejects it";
  else if (whole && len > MAX_CLIP) error = `a whole clip can be at most ${MAX_CLIP / 60} minutes (the engine's limit for one video); choose a window`;
  else if (count > MAX_WINDOWS) error = `${count} windows; choose a longer window (at most ${MAX_WINDOWS})`;
  const windows = Array.from({ length: error ? 0 : count }, (_, i) => {
    const t0 = i * step, t1 = i === count - 1 ? dur : t0 + len;
    const s0 = i === 0 ? 0 : overlap ? t0 + step / 2 : t0;
    const s1 = i === count - 1 ? dur : overlap ? t1 - step / 2 : t1;
    return {
      i, t0, t1, s0, s1, n, fps: n / (t1 - t0), state: "idle",
      times: Array.from({ length: n }, (_, k) => t0 + ((k + 0.5) * (t1 - t0)) / n),
      thumbs: null, frames: null, answers: null, error: null, server: null, total: null, tokens: null, resized,
    };
  });
  return { windows, count, len, step, overlap, n, resized, grab: g, error, whole, assumed: !(D > 0) };
}

// The clip, the window, the sampling or the budget changed: old results belong to the old cut. (A
// change during a run is the budget fitted to the server's limit; that run's windows stay.)
function replan() {
  if (!V.running) {
    V.windows = V.ready ? plan().windows : [];
    V.current = -1;
    refreshScore();
    syncPlayhead();
    status();
  }
  refreshCost();
}

function refreshCost() {
  const p = plan();
  const r = p.resized;
  const unsupported = settings.backend === "hosted" ? "Cloudflare does not accept video. Connect local cleffa or a SystemOne API that does." : null;
  const eff = p.n / p.len;
  const sampling = Math.abs(eff - V.fps) > 0.05 ? `${p.n} frames (${eff.toFixed(2)} fps)` : `${p.n} frames`;
  const shape = p.whole ? (p.assumed ? "Whole clip" : `Whole clip, ${p.len.toFixed(1)} s`)
    : p.count > 1 ? `${p.count} windows of ${p.len.toFixed(1)} s${p.overlap ? `, one every ${p.step.toFixed(1)} s` : ""}` : `One ${p.len.toFixed(1)} s window`;
  const cost = $("#video-cost");
  $("#video-strip-panel").hidden = !V.ready;
  // The plan is shown once there is a clip to plan for; an unsupported service is said at once.
  cost.textContent = unsupported ?? (!V.ready ? "" : p.error)
    ?? (p.whole && p.assumed ? `Whole clip, up to ${MAX_FRAMES} frames.`
      : `${shape}. ${sampling} at ${r.w}×${r.h}, ${fmtInt(r.tokens)} tokens per window${p.assumed ? " for a 16:9 clip" : ""}.`);
  cost.title = unsupported || p.error || (p.whole && p.assumed) ? "" : `${r.pairs} frame pairs, each a ${r.w / FACTOR}×${r.h / FACTOR} token grid`;
  $("#video-budget-ctl").title = `Image tokens per window, shared by its frames (videos_kwargs.size ≤ ${fmtInt(V.budget * PIXELS_PER_VIDEO_TOKEN)} px)`;
  $("#video-run").disabled = !!unsupported || !V.ready || (!!p.error && !V.running);
  $("#video-overlap").disabled = V.running || p.whole;
  const chip = $("#video-hud-geom");
  chip.hidden = !V.ready;
  if (V.ready) chip.textContent = `${V.w}×${V.h}, ${fmtClock(V.duration, true)}`;
  paintGrid();
}

function windowAt(t) {
  if (!V.windows.length) return -1;
  const k = V.windows.findIndex((w) => t < w.s1);
  return k < 0 ? V.windows.length - 1 : k;
}

// ------------------------------------------------------------------------------------- analysis

// Questions or model changed (a model change is announced as a schema change too).
function questionsChanged() {
  const { questions, error } = tryQuestions("video");
  let key;
  try { key = JSON.stringify([buildRequest([], {}, "video"), snapshotConnection().revision]); }
  catch { key = JSON.stringify([questions, settings.model]); }
  if (key !== V.qkey && V.windows.some((w) => w.state !== "idle")) {
    // The lanes and cards belong to the questions; answers to other questions would be misdrawn.
    stop();
    for (const w of V.windows) Object.assign(w, { state: "idle", answers: null, error: null, server: null, total: null, tokens: null });
    setError("");
    $("#video-status").textContent = "Questions changed; Analyze again.";
    $("#video-progress i").style.width = "0%";
  }
  V.qkey = key;
  V.panel.setQuestions(questions, error);
  V.score.setQuestions(questions);
  refreshScore();
  showWindow(V.current);
  refreshCost();
}

function windowRequest(win, budget, base) {
  return { ...base,
    videos: [{ frames: win.frames, fps: win.fps }],
    media_kwargs: { videos_kwargs: { do_sample_frames: false, size: { shortest_edge: VIDEO_MIN_PIXELS, longest_edge: budget * PIXELS_PER_VIDEO_TOKEN } } },
  };
}

async function analyze() {
  if (V.running || !V.ready) return;
  if (settings.backend === "hosted") { setError("Cloudflare Workers AI does not accept video input."); return; }
  let base;
  try { base = buildRequest([], {}, "video"); } catch (e) { setError(`Questions: ${e.message}`); return; }
  const connection = snapshotConnection();
  const p = plan();
  if (p.error) { setError(p.error); return; }
  const gen = ++V.gen;
  V.windows = p.windows;
  V.halt = false;
  V.current = -1;
  setRunning(true);
  setError("");
  refreshScore();
  syncPlayhead();
  const started = performance.now();
  const inflight = new Set();
  for (const win of V.windows) {
    if (gen !== V.gen || V.halt) break;
    win.state = "grabbing";
    showWindow(V.current);
    try {
      Object.assign(win, await grab(win, gen));
    } catch (e) {
      if (gen !== V.gen) break;
      fail(win, e.message);
      break;
    }
    if (gen !== V.gen) break;
    const job = send(win, gen, base, connection).finally(() => inflight.delete(job));
    inflight.add(job);
    if (inflight.size >= IN_FLIGHT) await Promise.race(inflight);
  }
  await Promise.allSettled(inflight);
  if (gen !== V.gen) return; // stopped, or replaced by a newer run
  setRunning(false);
  const done = V.windows.filter((w) => w.state === "done");
  if (done.length === V.windows.length) {
    toast(`${done.length} window${done.length === 1 ? "" : "s"} in ${((performance.now() - started) / 1000).toFixed(1)} s.`);
  }
  status();
}

function stop() {
  if (!V.running) return;
  V.gen++; // the loop and every response still on its way see a newer generation and drop out
  for (const w of V.windows) if (w.state === "grabbing" || w.state === "running") { w.state = "idle"; w.frames = null; }
  setRunning(false);
  refreshScore();
  showWindow(V.current);
  status();
}

function setRunning(run) {
  V.running = run;
  const b = $("#video-run");
  b.setAttribute("aria-pressed", String(run));
  b.replaceChildren(icon(run ? "stop" : "bolt"), el("span", { text: run ? "Stop" : "Analyze" }));
  for (const c of [...$$("[data-win]", $("#video-win")), $("#video-fps"), $("#video-budget")]) c.disabled = run;
  $("#video-stage").classList.toggle("busy", run);
  emit("activity", { mode: "video", running: run });
  refreshCost();
}

// Seeks the hidden copy of the clip to each sample time and keeps the frames as the request will
// carry them (JPEG data URLs) plus a small thumbnail for the filmstrip.
async function grab(win, gen) {
  const g = grabSize(), v = V.probe;
  const tw = Math.max(1, Math.round((g.w * THUMB_SIDE) / Math.max(g.w, g.h))), th = Math.max(1, Math.round((g.h * THUMB_SIDE) / Math.max(g.w, g.h)));
  V.canvas.width = g.w;
  V.canvas.height = g.h;
  V.thumb.width = tw;
  V.thumb.height = th;
  const ctx = V.canvas.getContext("2d"), tctx = V.thumb.getContext("2d");
  ctx.imageSmoothingQuality = "high";
  tctx.imageSmoothingQuality = "high";
  const frames = [], thumbs = [];
  for (const t of win.times) {
    await seekTo(v, t);
    if (gen !== V.gen) return { frames: null, thumbs: null };
    ctx.drawImage(v, 0, 0, g.w, g.h);
    tctx.drawImage(V.canvas, 0, 0, tw, th);
    frames.push(V.canvas.toDataURL("image/jpeg", GRAB_QUALITY));
    thumbs.push(V.thumb.toDataURL("image/jpeg", 0.7));
  }
  return { frames, thumbs };
}

async function send(win, gen, base, connection) {
  win.state = "running";
  refreshScore();
  showWindow(V.current);
  const source = `video · window ${win.i + 1}/${V.windows.length}`;
  let budget = V.budget;
  try {
    let r;
    try {
      r = await systemone(windowRequest(win, budget, base), { source, connection });
    } catch (e) {
      // "video resizes to N tokens, above the limit of L per video": the server was started with a
      // lower --max-video-tokens than the slider allows. Lower the budget to fit, once, and go on.
      const m = e instanceof ApiError && /above the limit of (\d+) per video/.exec(e.message);
      const fitted = m ? Math.floor(Number(m[1]) / 64) * 64 : 0;
      // Another window may already have lowered the shared slider. Compare against this
      // request's budget so both rejected windows get their one retry.
      if (fitted < Number($("#video-budget").min) || fitted >= budget || gen !== V.gen) throw e;
      budget = fitted;
      V.budget = Math.min(V.budget, fitted);
      $("#video-budget").value = String(fitted);
      $("#video-budget").dispatchEvent(new Event("input"));
      toast(`The server allows ${m[1]} tokens per video; the budget is now ${fitted}.`);
      r = await systemone(windowRequest(win, budget, base), { source, connection });
    }
    if (gen !== V.gen) return;
    const g = grabSize();
    Object.assign(win, {
      state: "done", answers: r.body.answers, server: r.server, total: r.total, tokens: r.tokens,
      resized: videoResize(win.n, g.h, g.w, VIDEO_MIN_PIXELS, budget * PIXELS_PER_VIDEO_TOKEN),
    });
  } catch (e) {
    if (gen !== V.gen) return;
    const hint = /sampled frames, above the limit/.test(e.message ?? "") ? " (here: lower the sampling rate or the window)" : "";
    fail(win, describeError(e) + hint);
  } finally {
    win.frames = null; // sent: only the thumbnails stay
  }
  refreshScore();
  showWindow(V.current);
  status();
}

// The first failure stops the run: the same request shape would fail the same way for every window.
// A window already in flight may fail the same way; the message on screen stays the first one.
function fail(win, message) {
  win.state = "error";
  win.error = message;
  if (!V.halt) setError(`Window ${win.i + 1} (${fmtClock(win.t0, true)}–${fmtClock(win.t1, true)}): ${message}`);
  V.halt = true;
  refreshScore();
}

function status() {
  const all = V.windows, done = all.filter((w) => w.state === "done");
  $("#video-progress i").style.width = `${all.length ? (done.length / all.length) * 100 : 0}%`;
  if (!done.length) { $("#video-status").textContent = V.running ? `0/${all.length} windows` : ""; return; }
  const med = quantile(done.map((w) => w.server), 0.5);
  const tok = quantile(done.map((w) => w.tokens), 0.5);
  $("#video-status").textContent = `${done.length}/${all.length} windows, median ${fmtMs(med)}`;
  $("#video-status").title = `Median engine time per window; ${fmtInt(tok)} input tokens each`;
}

// ------------------------------------------------------------------------------------- display

function refreshScore() {
  const finished = V.windows.filter((w) => w.state === "done" || w.state === "error");
  V.score.setSamples(finished.map((w) => ({
    t: w.s0, end: w.s1, span: [w.t0, w.t1], answers: w.answers, server: w.server, error: w.error,
    thumb: w.thumbs?.[Math.floor(w.n / 2)] ?? null,
  })));
  V.score.setMarks(V.windows.filter((w) => w.state === "running" || w.state === "error").map((w) => ({ t: w.s0, end: w.s1, kind: w.state })));
  V.score.setEmpty(finished.length || V.running ? "" : "Each analyzed window adds a slice to every lane.");
}

function tick() {
  syncPlayhead();
  const v = $("#vid");
  V.raf = !v.paused && !v.ended ? requestAnimationFrame(tick) : 0;
}

function seek(t) {
  const v = $("#vid");
  if (!V.ready) return;
  v.currentTime = Math.min(Math.max(0, t), V.duration);
  syncPlayhead();
}

function syncPlayhead() {
  const t = V.ready ? $("#vid").currentTime : null;
  V.score.setPlayhead(t);
  const k = t == null ? -1 : windowAt(t);
  if (k !== V.current) { V.current = k; showWindow(k); }
}

// The cards, the filmstrip and the HUD follow the window under the playhead.
function showWindow(k) {
  const win = V.windows[k] ?? null;
  const busy = win && (win.state === "grabbing" || win.state === "running");
  $("#video-decisions").classList.toggle("busy-panel", !!busy);
  if (win?.state === "done") V.panel.update(win.answers);
  else V.panel.update(null);
  const hw = $("#video-hud-win"), hm = $("#video-hud-ms");
  hw.hidden = !win;
  hm.hidden = !(win?.state === "done");
  $("#video-which").textContent = win ? `${fmtClock(win.t0, true)}–${fmtClock(win.t1, true)}` : "";
  if (win) {
    hw.textContent = `Window ${win.i + 1}/${V.windows.length}`;
    if (win.state === "done") hm.textContent = `${fmtMs(win.server)} engine`;
  }
  renderStrip(win);
}

// The engine writes each pair's mean source time with C's "%.1f", which rounds an exact tie (an
// odd multiple of 0.25 s, common at 2 fps) to even, where toFixed rounds it up.
function stamp(x) {
  const q = x * 4;
  return Number.isInteger(q) && q % 2 !== 0 ? (roundHalfEven(x * 10) / 10).toFixed(1) : x.toFixed(1);
}

function renderStrip(win) {
  const strip = $("#video-strip");
  if (!win) {
    strip.replaceChildren(el("p", { class: "strip-empty", text: V.ready ? "Move the playhead over the clip." : "The frames of the window under the playhead, in the pairs the engine reads." }));
    $("#video-strip-note").textContent = "";
    return;
  }
  const g = grabSize(), r = win.resized;
  strip.style.setProperty("--ar", `${g.w} / ${g.h}`);
  const tile = (k) => {
    const t = win.times[k];
    const img = win.thumbs?.[k];
    return el("div", { class: "frame", title: `frame ${k} at ${fmtClock(t, true)} of the clip` }, [
      img ? el("img", { src: img, alt: "" }) : el("i", { class: "ph" }),
      el("span", { class: "frame-t", text: fmtClock(t, true) }),
    ]);
  };
  const pairs = [];
  for (let a = 0; a < win.n; a += 2) {
    const b = Math.min(a + 1, win.n - 1);
    pairs.push(el("figure", { class: "pair" }, [
      el("div", { class: "pair-frames" }, [tile(a), b !== a ? tile(b) : ""]),
      el("figcaption", {}, [el("code", { text: `<${stamp((a / win.fps + b / win.fps) / 2)} seconds>` }), el("span", { text: r ? `${r.w / FACTOR}×${r.h / FACTOR}` : "" })]),
    ]));
  }
  strip.replaceChildren(...pairs);
  const state = { idle: "not analyzed", grabbing: "capturing", running: "in the engine", done: `${fmtInt(win.tokens)} tokens, ${fmtMs(win.server)}`, error: "failed" }[win.state];
  $("#video-strip-note").textContent = `Window ${win.i + 1}: ${state}`;
  $("#video-strip-note").title = `${win.n} frames at ${win.fps.toFixed(2)} fps, ${r?.pairs ?? "?"} pairs of ${r ? `${r.w}×${r.h}` : "?"} px`;
}

function paintGrid() {
  const c = $("#video-grid");
  const p = V.ready && V.grid ? plan() : null;
  const show = !!p?.resized && !p.error;
  c.hidden = !show;
  if (show) drawTokenGrid(c, V.w, V.h, p.resized);
}
