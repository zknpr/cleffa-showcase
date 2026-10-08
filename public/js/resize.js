// smart_resize, as Qwen2VLImageProcessor computes it (and clef_smart_resize in the engine), so the
// page can show what an image costs before sending it. Python's round() is half-to-even.
// tests/smart_resize_check.ts compares this module with the reference.

export const FACTOR = 32, MIN_PIXELS = 65536, MAX_PIXELS = 16777216;

export function roundHalfEven(x) {
  const f = Math.floor(x), d = x - f;
  if (d > 0.5) return f + 1;
  if (d < 0.5) return f;
  return f % 2 === 0 ? f : f + 1;
}

export function smartResize(h, w, minPixels = MIN_PIXELS, maxPixels = MAX_PIXELS) {
  if (!(h > 0 && w > 0) || Math.max(h, w) / Math.min(h, w) > 200) return null;
  // No clamp to `factor` here: transformers 5.x rounds first and lets a dimension under half a
  // factor round to zero, which sends the image through the min_pixels branch (the engine's
  // clef_smart_resize does the same; checked against the reference over 12,576 cases).
  let hb = roundHalfEven(h / FACTOR) * FACTOR;
  let wb = roundHalfEven(w / FACTOR) * FACTOR;
  if (hb * wb > maxPixels) {
    const beta = Math.sqrt((h * w) / maxPixels);
    hb = Math.max(FACTOR, Math.floor(h / beta / FACTOR) * FACTOR);
    wb = Math.max(FACTOR, Math.floor(w / beta / FACTOR) * FACTOR);
  } else if (hb * wb < minPixels) {
    const beta = Math.sqrt(minPixels / (h * w));
    hb = Math.ceil((h * beta) / FACTOR) * FACTOR;
    wb = Math.ceil((w * beta) / FACTOR) * FACTOR;
  }
  return { h: hb, w: wb, tokens: (hb / FACTOR) * (wb / FACTOR) };
}

// The video processor's smart_resize (Qwen3VLVideoProcessor; clef_video_resize in the engine). One
// budget covers every frame, counted in whole temporal pairs, but the scale factor uses the frame
// count itself, so an odd count can land above the budget. A token is a 32x32 block over a pair
// of frames, 2048 pixels of budget.
export const VIDEO_MIN_PIXELS = 4096, VIDEO_MAX_PIXELS = 25165824, PIXELS_PER_VIDEO_TOKEN = 2 * FACTOR * FACTOR;

export function videoResize(frames, h, w, minPixels = VIDEO_MIN_PIXELS, maxPixels = VIDEO_MAX_PIXELS) {
  if (!(frames >= 1) || !(h >= FACTOR && w >= FACTOR) || Math.max(h, w) / Math.min(h, w) > 200) return null;
  let hb = roundHalfEven(h / FACTOR) * FACTOR;
  let wb = roundHalfEven(w / FACTOR) * FACTOR;
  const padded = Math.ceil(frames / 2) * 2;
  if (padded * hb * wb > maxPixels) {
    const beta = Math.sqrt((frames * h * w) / maxPixels);
    hb = Math.max(FACTOR, Math.floor(h / beta / FACTOR) * FACTOR);
    wb = Math.max(FACTOR, Math.floor(w / beta / FACTOR) * FACTOR);
  } else if (padded * hb * wb < minPixels) {
    const beta = Math.sqrt(minPixels / (frames * h * w));
    hb = Math.ceil((h * beta) / FACTOR) * FACTOR;
    wb = Math.ceil((w * beta) / FACTOR) * FACTOR;
  }
  const pairs = padded / 2, perPair = (hb / FACTOR) * (wb / FACTOR);
  return { h: hb, w: wb, pairs, perPair, tokens: pairs * perPair };
}
