// cleffa showcase, browser side. Four modes over one SystemOne request shape:
//   live   the camera, one frame in flight, closed loop, answers and a rolling score
//   video  a clip in windows, each one request with `videos`, answers along the clip's timeline
//   batch  many images, up to eight in flight (the server micro-batches), filters and export
//   ask    one image, many schemas, keyed prefix-cache reuse through the proxy
// Connections are selected explicitly; see js/connection.js and js/api.js.

import { $, $$ } from "./js/dom.js";
import { initEngineMenu } from "./js/engine.js";
import { on } from "./js/store.js";
import { initOverlays, initFilePickers, overlayOpen, closeOverlay } from "./js/ui.js";
import { initEditor, openEditor, setSchemaMode } from "./js/schema.js";
import { initInspector } from "./js/inspector.js";
import { initLive, enterLive, leaveLive, liveKey } from "./js/live.js";
import { initVideo, enterVideo, leaveVideo, videoKey } from "./js/video.js";
import { initBatch, enterBatch } from "./js/batch.js";
import { initAsk, enterAsk, askKey } from "./js/ask.js";

const MODES = {
  live: { enter: enterLive, leave: leaveLive, key: liveKey },
  video: { enter: enterVideo, leave: leaveVideo, key: videoKey },
  batch: { enter: enterBatch },
  ask: { enter: enterAsk, key: askKey },
};
let mode = null;

function setMode(next) {
  if (!MODES[next]) next = "live";
  if (next === mode) return;
  if (mode) MODES[mode].leave?.();
  mode = next;
  for (const t of $$(".tab")) t.setAttribute("aria-selected", String(t.dataset.mode === mode));
  for (const m of Object.keys(MODES)) $(`#pane-${m}`).hidden = m !== mode;
  setSchemaMode(mode);
  MODES[mode].enter?.();
  moveInk();
  if (location.hash.slice(1) !== mode) history.replaceState(null, "", `#${mode}`);
}

function moveInk() {
  const t = $(`.tab[data-mode="${mode}"]`), ink = $(".tab-ink");
  if (!t) return;
  ink.style.width = `${t.offsetWidth}px`;
  ink.style.transform = `translateX(${t.offsetLeft}px)`;
}

// ------------------------------------------------------------------------------------- wiring

function initKeys() {
  document.addEventListener("keydown", (e) => {
    if (overlayOpen() || e.altKey) return;
    const t = e.target;
    if ((e.metaKey || e.ctrlKey) && e.key !== "Enter") return;
    const typing = t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
    if (typing && !(e.metaKey || e.ctrlKey)) return;
    if (e.key === " " && t instanceof HTMLElement && /^(BUTTON|A|SUMMARY|LABEL)$/.test(t.tagName)) return;
    MODES[mode].key?.(e);
  });
}

function init() {
  initOverlays();
  initFilePickers();
  initEditor();
  initInspector();
  initEngineMenu();
  initLive();
  initVideo();
  initBatch();
  initAsk();
  initKeys();
  for (const b of $$(".tab")) b.addEventListener("click", () => setMode(b.dataset.mode));
  for (const b of $$('[data-action="edit"]')) b.addEventListener("click", openEditor);
  on("activity", ({ mode: m, running }) => { const badge = $(`.tab[data-mode="${m}"] .badge`); if (badge) badge.hidden = !running; });
  window.addEventListener("hashchange", () => { if (overlayOpen()) closeOverlay(); setMode(location.hash.slice(1)); });
  window.addEventListener("resize", moveInk);
  // A file dropped outside a drop zone would otherwise replace the page with the file.
  window.addEventListener("dragover", (e) => e.preventDefault());
  window.addEventListener("drop", (e) => e.preventDefault());
  setMode(location.hash.slice(1) || "live");
  // The ink needs final tab widths, which depend on the system font having loaded.
  document.fonts?.ready.then(moveInk);
}

init();
