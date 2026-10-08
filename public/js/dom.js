// Small DOM and formatting helpers shared by the modes. No framework and no build step: the page is
// a handful of panels updated in place, and nothing should stand between a reader and the request.
// Every string from a request, a response or a file name goes in through textContent, never HTML.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "class") node.className = v;
    else if (k === "text") node.textContent = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of [].concat(children)) if (c !== null && c !== undefined && c !== false) node.append(c);
  return node;
}

const SVG_NS = "http://www.w3.org/2000/svg";
export function icon(name) {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("class", "i");
  svg.setAttribute("aria-hidden", "true");
  const use = document.createElementNS(SVG_NS, "use");
  use.setAttribute("href", `#i-${name}`);
  svg.append(use);
  return svg;
}

export const fmtMs = (ms) => (ms == null || !Number.isFinite(ms) ? "—" : ms < 10 ? `${ms.toFixed(1)} ms` : `${Math.round(ms)} ms`);
export const fmtInt = (n) => (n == null || !Number.isFinite(n) ? "—" : Math.round(n).toLocaleString("en-US"));
export const pct = (p) => `${(p * 100).toFixed(p < 0.095 || p > 0.995 ? 1 : 0)}%`;
export const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

export function quantile(xs, q) {
  const s = xs.filter((x) => x != null && Number.isFinite(x)).sort((a, b) => a - b);
  if (!s.length) return null;
  const i = (s.length - 1) * q, lo = Math.floor(i), hi = Math.ceil(i);
  return s[lo] + (s[hi] - s[lo]) * (i - lo);
}

export function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = el("a", { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Grows a textarea with its content (field-sizing is not in every browser yet).
export function autosize(ta) {
  ta.style.height = "auto";
  ta.style.height = `${ta.scrollHeight + 2}px`;
}

// A canvas sized to its CSS box at the device pixel ratio, with the context scaled to CSS pixels.
export function fitCanvas(canvas, w = canvas.clientWidth, h = canvas.clientHeight) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const cw = Math.max(1, Math.round(w * dpr)), ch = Math.max(1, Math.round(h * dpr));
  if (canvas.width !== cw) canvas.width = cw;
  if (canvas.height !== ch) canvas.height = ch;
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return ctx;
}

// A position in a clip: 1:05, or 1:05.5 with tenths.
export function fmtClock(t, tenths = false) {
  if (!Number.isFinite(t)) return "—";
  const d = Math.max(0, Math.round(t * 10)), m = Math.floor(d / 600), s = (d - m * 600) / 10;
  return `${m}:${tenths ? s.toFixed(1).padStart(4, "0") : String(Math.floor(s)).padStart(2, "0")}`;
}
