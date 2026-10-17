// What each Clef model accepts, as far as the page needs to know. Clef and Clef-Flash share one
// processor. Clef-Omni (cleffa's qwen3_omni_moe family) also takes audio, reads video at exactly
// 2 frames a second with each frame sized on its own and no timestamp text, and bounds an image
// at 1,048,576 pixels (1,024 tokens) by default instead of 16,777,216.

import { MAX_PIXELS } from "./resize.js";

export const MODELS = ["clef-flash", "clef", "clef-omni"];
export const isOmni = (model) => model === "clef-omni";
export const imageMaxPixels = (model) => (isOmni(model) ? 1048576 : MAX_PIXELS);

// clef-server's /health reports the GGUF's general.name, the converted directory's name
// (model-flash, model-omni, model).
export function modelFromHealth(name) {
  return /omni/i.test(name) ? "clef-omni" : /flash/i.test(name) ? "clef-flash" : "clef";
}
