import { loadImage } from "./media.js";
import { smartResize, MIN_PIXELS } from "./resize.js";

// Workers AI currently accepts images but rejects videos and media_kwargs. Apply the requested
// image budget before uploading, and expose these actual bytes in the inspector. Browser JPEG
// resampling is not a claim of byte parity with Cleffa's reference preprocessing.
export async function prepareHostedRequest(req) {
  if (req.videos?.length) throw new Error("Cloudflare Workers AI does not accept video input. Connect local Cleffa or a video-capable SystemOne API.");
  const maxPixels = Math.max(128 * 1024, req.media_kwargs?.max_pixels ?? 1024 * 1024);
  const result = { ...req };
  delete result.media_kwargs;
  if (!req.images?.length) return result;
  result.images = [];
  for (const source of req.images) {
    const url = typeof source === "string" ? (source.startsWith("data:") ? source : `data:image/jpeg;base64,${source}`)
      : `data:${source.content_type};base64,${source.base64}`;
    const img = await loadImage(url);
    const ordinary = smartResize(img.naturalHeight, img.naturalWidth);
    if (!ordinary) throw new Error("Image aspect ratio exceeds the processor's limit.");
    if (ordinary.w * ordinary.h <= maxPixels) { result.images.push(source); continue; }
    const size = smartResize(img.naturalHeight, img.naturalWidth, MIN_PIXELS, maxPixels);
    const canvas = document.createElement("canvas");
    canvas.width = size.w; canvas.height = size.h;
    const ctx = canvas.getContext("2d");
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(img, 0, 0, size.w, size.h);
    result.images.push(canvas.toDataURL("image/jpeg", 0.92));
  }
  return result;
}
