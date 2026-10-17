import { test, expect } from "bun:test";
// Browser modules; nothing in them touches the DOM on import.
import { encodeWav, audioTokens } from "../public/js/audio.js";
import { omniVideoResize, videoSize } from "../public/js/resize.js";
import { modelFromHealth, imageMaxPixels } from "../public/js/models.js";

test("WAV is the PCM16 mono 16 kHz layout cleffa parses, encoded as the exact inverse of its s / 32768", () => {
  const wav: Uint8Array = encodeWav(Float32Array.of(0, 0.5, -1, 1, -1.5, 2, 1 / 32768));
  const v = new DataView(wav.buffer);
  const ascii = (at: number) => new TextDecoder().decode(wav.slice(at, at + 4));
  expect([ascii(0), ascii(8), ascii(12), ascii(36)]).toEqual(["RIFF", "WAVE", "fmt ", "data"]);
  expect(v.getUint32(4, true)).toBe(wav.length - 8);
  // fmt: size 16, PCM, mono, 16 kHz, byte rate, block align, bits
  expect([v.getUint32(16, true), v.getUint16(20, true), v.getUint16(22, true), v.getUint32(24, true), v.getUint32(28, true), v.getUint16(32, true), v.getUint16(34, true)])
    .toEqual([16, 1, 1, 16000, 32000, 2, 16]);
  expect(v.getUint32(40, true)).toBe(14);
  const samples = Array.from({ length: 7 }, (_, i) => v.getInt16(44 + 2 * i, true));
  expect(samples).toEqual([0, 16384, -32768, 32767, -32768, 32767, 1]);
  expect(samples.map(s => s / 32768)).toEqual([0, 0.5, -1, 32767 / 32768, -1, 32767 / 32768, 1 / 32768]);
});

test("a WAV span past the samples is silence", () => {
  const wav: Uint8Array = encodeWav(Float32Array.of(0.5, 0.5), 1, 4);
  const v = new DataView(wav.buffer);
  expect(Array.from({ length: 3 }, (_, i) => v.getInt16(44 + 2 * i, true))).toEqual([16384, 0, 0]);
});

test("audio token counts are cleffa's", () => {
  // From clef-tool encode on gguf/clef-omni.gguf at cleffa 24fc91e, one clip per request. The
  // engine refuses 200 samples and fewer (reflection padding).
  const engine: Record<number, number | null> = { 200: null, 201: 1, 320: 1, 1599: 2, 1600: 2, 15999: 13, 16000: 13, 16001: 13, 24000: 20, 64000: 52, 159999: 130, 160000: 130, 480123: 390 };
  for (const [n, tokens] of Object.entries(engine)) expect(audioTokens(Number(n))).toBe(tokens);
});

test("Omni video windows cost what cleffa counts for the size the page sends", () => {
  // [frames, width, height, budget, tokens]: the page's request shape through clef-tool encode
  // (cleffa 24fc91e, clef-omni); 105 such cases agreed, these are a sample.
  for (const [n, w, h, budget, tokens] of [[8, 640, 360, 512, 480], [16, 640, 360, 512, 480], [24, 640, 360, 128, 96],
    [8, 360, 640, 1024, 880], [2, 100, 40, 128, 8], [16, 637, 359, 1024, 960]]) {
    const size = videoSize(n, budget, true);
    expect(omniVideoResize(n, h, w, size.shortest_edge, size.longest_edge)?.tokens).toBe(tokens);
    expect(tokens).toBeLessThanOrEqual(budget);
  }
  // Dense models keep one budget for the whole window.
  expect(videoSize(8, 512, false)).toEqual({ shortest_edge: 4096, longest_edge: 512 * 2048 });
});

test("the companion's model name selects the model, and Omni's image bound is 1,024 tokens", () => {
  expect(["model-omni", "model-flash", "model", "clef-omni"].map(modelFromHealth)).toEqual(["clef-omni", "clef-flash", "clef", "clef-omni"]);
  expect(imageMaxPixels("clef-omni")).toBe(1048576);
  expect(imageMaxPixels("clef-flash")).toBe(16777216);
});
