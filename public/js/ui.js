// Overlays (drawers, the lightbox), toasts, range sliders and drop targets.

import { $, $$, el } from "./dom.js";

let open = null, returnFocus = null;

// One overlay at a time. Drawers dim the page behind a scrim; the lightbox has its own backdrop.
export function openOverlay(node, { scrim = true } = {}) {
  if (open && open !== node) closeOverlay();
  if (open !== node) returnFocus = document.activeElement;
  open = node;
  node.classList.add("open");
  $("#scrim").classList.toggle("show", scrim);
  setTimeout(() => node.querySelector("[data-autofocus], input:not([type=hidden]), textarea, button")?.focus({ preventScroll: true }), 60);
}

export function closeOverlay() {
  if (!open) return;
  const node = open;
  open = null;
  node.classList.remove("open");
  $("#scrim").classList.remove("show");
  node.dispatchEvent(new Event("overlayclose"));
  if (returnFocus && document.contains(returnFocus)) returnFocus.focus({ preventScroll: true });
}

export const overlayOpen = () => open;

// The file pickers are <label class="btn"> around a hidden <input type=file>, which a keyboard
// cannot reach; make each label a focusable button that opens its input.
export function initFilePickers() {
  for (const label of $$("label.btn")) {
    const input = label.querySelector('input[type="file"]');
    if (!input) continue;
    label.tabIndex = 0;
    label.setAttribute("role", "button");
    label.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      e.preventDefault();
      input.click();
    });
  }
}

export function initOverlays() {
  $("#scrim").addEventListener("click", closeOverlay);
  for (const b of $$("[data-close]")) b.addEventListener("click", closeOverlay);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && open) { e.preventDefault(); closeOverlay(); }
    if (e.key === "Tab" && open) {
      const focusable = $$("button, a[href], input, textarea, select, summary, [tabindex]", open)
        .filter(n => !n.disabled && n.tabIndex >= 0 && n.getClientRects().length);
      const first = focusable[0], last = focusable.at(-1);
      if (e.shiftKey && (document.activeElement === first || !open.contains(document.activeElement))) {
        e.preventDefault(); last?.focus();
      } else if (!e.shiftKey && (document.activeElement === last || !open.contains(document.activeElement))) {
        e.preventDefault(); first?.focus();
      }
    }
  });
}

export function toast(message, kind = "") {
  const t = el("div", { class: `toast ${kind}`, role: kind === "bad" ? "alert" : "status", text: message });
  $("#toasts").append(t);
  setTimeout(() => { t.classList.add("out"); setTimeout(() => t.remove(), 320); }, 4200);
}

// Keeps a slider's filled track and its <output> in step with its value.
export function bindRange(input, output, format, onInput) {
  const sync = () => {
    const v = Number(input.value);
    input.style.setProperty("--fill", `${((v - Number(input.min)) / (Number(input.max) - Number(input.min))) * 100}%`);
    if (output) output.value = format ? format(v) : String(v);
    onInput?.(v);
  };
  input.addEventListener("input", sync);
  sync();
  return sync;
}

export function setRadio(group, attr, value) {
  for (const b of $$(`[${attr}]`, group)) b.setAttribute("aria-checked", String(b.getAttribute(attr) === value));
}

// Files from a drop, walking dropped folders. webkitGetAsEntry must be called during the drop
// event (the items are dead after it returns), so the entries are collected before any await.
export function droppedFiles(dt, limit) {
  const entries = [...(dt.items ?? [])].map((i) => i.webkitGetAsEntry?.()).filter(Boolean);
  if (!entries.length) return Promise.resolve([...dt.files].map((file) => ({ file, path: file.name })));
  const out = [];
  const walk = async (entry, prefix) => {
    if (out.length >= limit) return;
    if (entry.isFile) {
      const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
      out.push({ file, path: prefix + file.name });
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      for (;;) {
        const batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
        if (!batch.length) break;
        for (const e of batch) await walk(e, `${prefix}${entry.name}/`);
      }
    }
  };
  return (async () => { for (const e of entries) await walk(e, ""); return out; })();
}

// Highlights `target` while files are dragged over `zone` and hands the drop to `onDrop`.
export function dropZone(zone, target, onDrop) {
  let depth = 0;
  zone.addEventListener("dragenter", (e) => { if (!e.dataTransfer?.types?.includes("Files")) return; e.preventDefault(); depth++; target.classList.add("dropping"); });
  zone.addEventListener("dragover", (e) => { if (e.dataTransfer?.types?.includes("Files")) e.preventDefault(); });
  zone.addEventListener("dragleave", () => { depth = Math.max(0, depth - 1); if (!depth) target.classList.remove("dropping"); });
  zone.addEventListener("drop", (e) => { e.preventDefault(); depth = 0; target.classList.remove("dropping"); onDrop(e.dataTransfer); });
}
