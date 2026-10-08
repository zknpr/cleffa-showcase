// Live mode: the camera, one frame in flight at a time (closed loop), so the frame rate is whatever
// the engine sustains at the chosen size and the page never queues stale frames.

import { $, el, icon, fmtMs, fmtInt, quantile, fitCanvas } from "./dom.js";
import { systemone, describeError } from "./api.js";
import { buildRequest, tryQuestions } from "./schema.js";
import { DecisionPanel } from "./answers.js";
import { Score } from "./score.js";
import { frameGeometry, grabJpeg, drawTokenGrid } from "./media.js";
import { bindRange } from "./ui.js";
import { on, emit } from "./store.js";
import { snapshotConnection } from "./connection.js";

const WINDOW = 60;
const L = {
  stream: null, running: false, panel: null, score: null, canvas: document.createElement("canvas"),
  lat: [], samples: [], qkey: "", grid: false, frames: 0, winStart: 0, fps: null,
  camGen: 0, starting: false, loopGen: 0, inflight: null,
};

export function initLive() {
  L.panel = new DecisionPanel($("#live-decisions"));
  L.score = new Score($("#live-score"), { window: WINDOW, emptyText: "Each answered frame adds a slice to every lane." });
  L.score.setSamples(L.samples);
  bindRange($("#live-side"), $("#live-side-out"), (v) => `${v} px`, updateGeometry);
  bindRange($("#live-quality"), $("#live-q-out"), (v) => v.toFixed(2));
  for (const b of document.querySelectorAll('[data-action="cam-toggle"]')) b.addEventListener("click", () => { if (!L.starting) (L.stream ? stopCamera() : startCamera()); });
  $("#live-run").addEventListener("click", toggleRun);
  $("#live-once").addEventListener("click", async () => {
    try { await runOneFrame(); setError(""); } catch (e) { setError(describeError(e)); }
  });
  $("#live-grid-toggle").addEventListener("click", (e) => {
    L.grid = !L.grid;
    e.currentTarget.setAttribute("aria-pressed", String(L.grid));
    paintGrid();
  });
  $("#live-device").addEventListener("change", (e) => startCamera(e.target.value));
  $("#cam").addEventListener("resize", updateGeometry);
  new ResizeObserver(paintGrid).observe($("#live-stage"));
  new ResizeObserver(drawSpark).observe($("#live-spark"));
  on("schema", (d) => { if (d.mode === "live") refreshQuestions(); });
  on("connection", () => setRunning(false));
  updateGeometry();
}

export function enterLive() { refreshQuestions(); updateGeometry(); }
// The camera never stays on behind another mode, including one still opening (stopCamera cancels it).
export function leaveLive() { stopCamera(); }

export function liveKey(e) {
  if (e.key === " " && L.stream) { e.preventDefault(); toggleRun(); return true; }
  return false;
}

function setError(msg) { $("#live-error").textContent = msg; }

function refreshQuestions() {
  const { questions, error } = tryQuestions("live");
  let key;
  try { key = JSON.stringify([buildRequest([], {}, "live"), snapshotConnection().revision]); }
  catch { key = JSON.stringify(questions); }
  if (key !== L.qkey) {
    // The lanes belong to the questions; answers to other questions would be misdrawn.
    L.qkey = key;
    L.samples.length = 0;
    L.lat.length = 0;
  }
  L.panel.setQuestions(questions, error);
  L.panel.update(null);
  L.score.setQuestions(questions);
}

// ------------------------------------------------------------------------------------- camera

// getUserMedia can take seconds (a permission prompt), and the page can stop the camera or leave
// Live meanwhile. Each start takes a generation number; a stop or a later start bumps it, and a
// stream that arrives for a superseded generation is closed at once instead of left running.
async function startCamera(deviceId = null) {
  if (!navigator.mediaDevices?.getUserMedia) {
    setError("The camera needs a secure context: open this page on http://127.0.0.1 or https.");
    return;
  }
  setRunning(false); // switching cameras pauses the loop rather than leaving it without a stream
  for (const t of L.stream?.getTracks() ?? []) t.stop();
  L.stream = null;
  const gen = ++L.camGen;
  L.starting = true;
  setStarting(true);
  const video = deviceId
    ? { deviceId: { exact: deviceId }, width: { ideal: 1280 }, height: { ideal: 720 } }
    : { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: "user" };
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video, audio: false });
  } catch (e) {
    if (gen !== L.camGen) return;
    stopCamera(); // resets every control, then the reason stays on screen
    setError(`camera: ${e.message}`);
    return;
  }
  if (gen !== L.camGen) { for (const t of stream.getTracks()) t.stop(); return; }
  L.starting = false;
  setStarting(false);
  L.stream = stream;
  const v = $("#cam");
  v.srcObject = L.stream;
  if (v.readyState < 1) await new Promise((r) => v.addEventListener("loadedmetadata", r, { once: true }));
  if (gen !== L.camGen) return; // stopped while the first frame was on its way
  $("#live-empty").hidden = true;
  setCamButtons(true);
  setError("");
  await listCameras(L.stream.getVideoTracks()[0]?.getSettings?.().deviceId);
  updateGeometry();
}

function stopCamera() {
  L.camGen++; // cancels a start still waiting for its stream
  L.starting = false;
  setStarting(false);
  setRunning(false);
  for (const t of L.stream?.getTracks() ?? []) t.stop();
  L.stream = null;
  $("#cam").srcObject = null;
  $("#live-empty").hidden = false;
  setCamButtons(false);
  paintGrid();
}

function setStarting(on) {
  for (const b of document.querySelectorAll('[data-action="cam-toggle"]')) b.disabled = on;
  if (on) $("#live-hud-state").textContent = "opening camera…";
}

function setCamButtons(on) {
  const b = $("#live-cam");
  b.replaceChildren(icon("camera"), el("span", { text: on ? "Stop camera" : "Start camera" }));
  $("#live-run").disabled = !on;
  $("#live-once").disabled = !on;
  $("#live-hud-state").textContent = on ? "ready" : "idle";
}

async function listCameras(current) {
  const sel = $("#live-device");
  let cams = [];
  try { cams = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "videoinput"); } catch { /* keep the default camera */ }
  sel.replaceChildren(...cams.map((d, i) => el("option", { value: d.deviceId, text: d.label || `Camera ${i + 1}` })));
  sel.hidden = cams.length < 2;
  if (current) sel.value = current;
}

// ------------------------------------------------------------------------------------- loop

function toggleRun() { setRunning(!L.running); }

function setRunning(run) {
  if (run === L.running) return;
  L.running = run;
  const b = $("#live-run");
  b.setAttribute("aria-pressed", String(run));
  b.replaceChildren(icon(run ? "pause" : "play"), el("span", { text: run ? "Pause" : "Run" }));
  $("#live-stage").classList.toggle("live", run);
  $("#live-hud-state").textContent = run ? "live" : L.stream ? "paused" : "idle";
  emit("activity", { mode: "live", running: run });
  if (run) { L.score.start(); loop(); } else { L.score.stop(); $("#live-m-fps").textContent = "—"; }
}

// A pause and a resume within one frame's latency would otherwise leave the old loop running next
// to the new one; only the newest loop keeps going.
async function loop() {
  const gen = ++L.loopGen;
  L.frames = 0;
  L.winStart = performance.now();
  while (L.running && L.stream && gen === L.loopGen) {
    if (document.hidden) { await new Promise((r) => setTimeout(r, 250)); continue; }
    try {
      await runOneFrame();
      setError("");
    } catch (e) {
      setError(describeError(e));
      await new Promise((r) => setTimeout(r, 1000)); // back off on errors, don't spin
    }
    const secs = (performance.now() - L.winStart) / 1000;
    if (secs >= 1) {
      L.fps = L.frames / secs;
      $("#live-m-fps").textContent = L.fps.toFixed(1);
      L.frames = 0;
      L.winStart = performance.now();
    }
  }
}

// One frame in flight whoever asks (the loop, a resumed loop, the Frame button): a second caller
// waits for the frame already on its way. This keeps samples in time order for the score too.
function runOneFrame() {
  L.inflight ??= sendFrame().finally(() => { L.inflight = null; });
  return L.inflight;
}

async function sendFrame() {
  const v = $("#cam");
  if (!v.videoWidth) return;
  const shot = grabJpeg(v, v.videoWidth, v.videoHeight, Number($("#live-side").value), Number($("#live-quality").value), L.canvas);
  const req = buildRequest([shot.dataUrl], {}, "live");
  const connection = snapshotConnection();
  const key = JSON.stringify([{ ...req, images: undefined }, connection.revision]);
  const t = performance.now() / 1000;
  const stage = $("#live-stage");
  stage.classList.add("busy");
  let r;
  try { r = await systemone(req, { source: "live", connection }); } finally { stage.classList.remove("busy"); }
  L.frames++;
  L.lat.push({ total: r.total, server: r.server });
  if (L.lat.length > 120) L.lat.shift();
  // A response to questions edited while it was in flight updates the latency, not the answers.
  if (key === L.qkey) {
    L.panel.update(r.body.answers);
    L.samples.push({ t, answers: r.body.answers, thumb: shot.dataUrl, server: r.server });
    while (L.samples.length && L.samples[0].t < t - WINDOW - 5) L.samples.shift();
    const recent = L.samples.slice(-20);
    if (recent.length > 2) L.score.setSpacing(quantile(recent.slice(1).map((s, i) => s.t - recent[i].t), 0.5));
    L.score.setEmpty("");
    L.score.draw();
  }
  showMetrics(r);
}

// ------------------------------------------------------------------------------------- readouts

function showMetrics(r) {
  $("#live-telemetry").hidden = false;
  const unit = (ms) => (ms == null ? "—" : `${Math.round(ms)}`);
  $("#live-m-engine").replaceChildren(unit(r.server), el("small", { text: "ms" }));
  $("#live-m-rt").replaceChildren(unit(r.total), el("small", { text: "ms" }));
  $("#live-m-tok").textContent = fmtInt(r.tokens);
  const engine = L.lat.map((x) => x.server);
  const med = quantile(engine, 0.5), p90 = quantile(engine, 0.9);
  $("#live-m-med").replaceChildren(`${unit(med)} / ${unit(p90)}`, el("small", { text: "ms" }));
  const hud = $("#live-hud-ms");
  hud.hidden = false;
  hud.textContent = `${fmtMs(r.server)} engine`;
  drawSpark();
}

function drawSpark() {
  const c = $("#live-spark");
  const W = c.clientWidth, H = c.clientHeight;
  if (!W) return;
  const ctx = fitCanvas(c, W, H);
  const s = L.lat;
  if (s.length < 2) return;
  const max = Math.max(50, ...s.map((x) => x.total)) * 1.12;
  const n = Math.max(s.length, 60);
  const X = (i) => (i / (n - 1)) * W;
  const Y = (v) => H - 2 - (v / max) * (H - 6);
  ctx.strokeStyle = "rgba(255, 255, 255, 0.06)";
  ctx.beginPath();
  for (const g of [0.25, 0.5, 0.75]) { const y = Math.round(Y(max * g)) + 0.5; ctx.moveTo(0, y); ctx.lineTo(W, y); }
  ctx.stroke();
  const pts = s.map((p, i) => [X(i), p.server]).filter(([, v]) => v != null);
  if (pts.length > 1) {
    const grad = ctx.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0, "rgba(246, 130, 31, 0.35)");
    grad.addColorStop(1, "rgba(246, 130, 31, 0)");
    ctx.beginPath();
    ctx.moveTo(pts[0][0], H);
    for (const [x, v] of pts) ctx.lineTo(x, Y(v));
    ctx.lineTo(pts[pts.length - 1][0], H);
    ctx.fillStyle = grad;
    ctx.fill();
    ctx.beginPath();
    pts.forEach(([x, v], i) => (i ? ctx.lineTo(x, Y(v)) : ctx.moveTo(x, Y(v))));
    ctx.strokeStyle = "#f6821f";
    ctx.lineWidth = 1.6;
    ctx.stroke();
  }
  ctx.beginPath();
  s.forEach((p, i) => (i ? ctx.lineTo(X(i), Y(p.total)) : ctx.moveTo(X(i), Y(p.total))));
  ctx.strokeStyle = "rgba(171, 171, 171, 0.75)";
  ctx.lineWidth = 1.2;
  ctx.stroke();
  ctx.fillStyle = "#6e6e6e";
  ctx.font = "11px -apple-system, BlinkMacSystemFont, system-ui, sans-serif";
  ctx.textBaseline = "top";
  ctx.fillText(`${Math.round(max)} ms`, 2, 2);
}

// The token cost of the next frame, shown before it is sent: one image token per 32x32 pixels of
// the resized frame. Before the camera starts, a 1280x720 camera is assumed and labelled so.
function updateGeometry() {
  const v = $("#cam");
  const side = Number($("#live-side").value);
  const assumed = !v.videoWidth;
  const g = frameGeometry(assumed ? 1280 : v.videoWidth, assumed ? 720 : v.videoHeight, side);
  const r = g.resized;
  const cost = $("#live-cost");
  cost.textContent = r ? `→ ${r.tokens} tokens` : "aspect ratio over 200";
  cost.title = r ? `${g.w}×${g.h} resizes to ${r.w}×${r.h}${assumed ? ", assuming a 1280×720 camera" : ""}` : "";
  const chip = $("#live-hud-geom");
  chip.hidden = assumed;
  if (r) chip.textContent = `${r.w / 32}×${r.h / 32} = ${r.tokens} image tokens`;
  paintGrid();
}

function paintGrid() {
  const c = $("#live-grid"), v = $("#cam");
  const show = L.grid && !!L.stream && !!v.videoWidth;
  c.hidden = !show;
  if (!show) return;
  const g = frameGeometry(v.videoWidth, v.videoHeight, Number($("#live-side").value));
  drawTokenGrid(c, v.videoWidth, v.videoHeight, g.resized);
}
