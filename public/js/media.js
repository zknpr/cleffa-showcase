// Turning pixels into what a request carries, and showing what the model will read.

import { smartResize, FACTOR } from "./resize.js";
import { fitCanvas } from "./dom.js";

// Sources the engine refuses by default (--max-image-pixels 16,777,216) or that the hosted API
// refuses (16 megapixels, 4 MiB encoded) are shrunk here to at most 4 megapixels as JPEG, and the
// engine then does its final antialiased resize from media_kwargs as usual. A 24-megapixel phone
// photo would otherwise fail on both backends, and its base64 exceeds the engine's 8 MiB default
// body. Smaller files are sent byte for byte, so the engine sees exactly what the reference would.
// The browser applies EXIF orientation when it draws, so a shrunk photo arrives upright; an
// unshrunk file goes as stored, and the engine, like the reference, ignores EXIF orientation.
export const SOURCE_MAX_PIXELS = 16777216, SOURCE_MAX_BYTES = 4 * 1024 * 1024, SHRINK_TO_PIXELS = 4194304;

export function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error ?? new Error("read failed"));
    r.readAsDataURL(file);
  });
}

export function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("the browser could not decode this image"));
    img.src = src;
  });
}

export async function prepareImage(file) {
  const dataUrl = await fileToDataUrl(file);
  const img = await loadImage(dataUrl);
  const w = img.naturalWidth, h = img.naturalHeight;
  if (w * h <= SOURCE_MAX_PIXELS && file.size <= SOURCE_MAX_BYTES) return { dataUrl, w, h, shrunk: null };
  const scale = Math.min(1, Math.sqrt(SHRINK_TO_PIXELS / (w * h)));
  const cw = Math.max(1, Math.floor(w * scale)), ch = Math.max(1, Math.floor(h * scale));
  const c = document.createElement("canvas");
  c.width = cw;
  c.height = ch;
  const ctx = c.getContext("2d");
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, 0, 0, cw, ch);
  return { dataUrl: c.toDataURL("image/jpeg", 0.92), w, h, shrunk: { w: cw, h: ch } };
}

// A camera frame scaled so its longest side is `side`, and what smart_resize makes of it.
export function frameGeometry(srcW, srcH, side) {
  const scale = side / Math.max(srcW, srcH);
  const w = Math.max(1, Math.round(srcW * scale)), h = Math.max(1, Math.round(srcH * scale));
  return { w, h, resized: smartResize(h, w) };
}

export function grabJpeg(source, srcW, srcH, side, quality, canvas) {
  const g = frameGeometry(srcW, srcH, side);
  canvas.width = g.w;
  canvas.height = g.h;
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(source, 0, 0, g.w, g.h);
  // A data URL is one of the hosted API's two image forms; the proxy forwards it untouched.
  return { ...g, dataUrl: canvas.toDataURL("image/jpeg", quality) };
}

// Where an object-fit: contain element draws a w x h source inside a W x H box.
export function containRect(W, H, w, h) {
  const s = Math.min(W / w, H / h);
  return { x: (W - w * s) / 2, y: (H - h * s) / 2, w: w * s, h: h * s };
}

// One cell per image token: after the processor's resize, each token is a 2x2 merge of 16-pixel
// patches, a 32x32 block of the resized image. The resize stretches the whole source to the grid,
// so cell i spans fraction i/cols of the source whatever its aspect.
export function drawTokenGrid(canvas, srcW, srcH, resized) {
  const ctx = fitCanvas(canvas);
  if (!resized || !srcW || !srcH) return;
  const r = containRect(canvas.clientWidth, canvas.clientHeight, srcW, srcH);
  const cols = resized.w / FACTOR, rows = resized.h / FACTOR;
  ctx.fillStyle = "rgba(3, 4, 6, 0.18)";
  ctx.fillRect(r.x, r.y, r.w, r.h);
  ctx.strokeStyle = "rgba(246, 130, 31, 0.42)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let i = 0; i <= cols; i++) { const x = Math.round(r.x + (r.w * i) / cols) + 0.5; ctx.moveTo(x, r.y); ctx.lineTo(x, r.y + r.h); }
  for (let j = 0; j <= rows; j++) { const y = Math.round(r.y + (r.h * j) / rows) + 0.5; ctx.moveTo(r.x, y); ctx.lineTo(r.x + r.w, y); }
  ctx.stroke();
}
