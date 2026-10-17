// Audio for Clef-Omni: what a request carries and what it costs. cleffa takes WAV that is mono,
// 16 kHz, PCM16 or float32, and nothing else (no codecs, no other rates). The browser decodes the
// file (anything it can play, including a video's soundtrack), resamples it to 16 kHz and mixes
// it to mono; that resampling is the browser's, not a claim of parity with cleffa's
// tools/audio_request.py. Samples go out as PCM16: cleffa reads s / 32768, so the encoding below
// is its exact inverse, and the body is half the size of float32, which matters against
// clef-server's 8 MiB default body (300 s of PCM16 is already 12.8 MB as base64).

import { fitCanvas } from "./dom.js";

export const AUDIO_RATE = 16000;
export const MAX_AUDIO_SAMPLES = 4800000; // clef-server's default --max-audio-samples, 300 s
export const MAX_AUDIO_FILE = 512 * 1024 * 1024; // decodeAudioData needs the whole file in memory

export async function decodeAudio(bytes) {
  // decodeAudioData resamples to its context's rate; the context's own length and channel count
  // play no part in decoding.
  const decoded = await new OfflineAudioContext(1, 1, AUDIO_RATE).decodeAudioData(bytes);
  const k = decoded.numberOfChannels, mono = new Float32Array(decoded.length);
  for (let c = 0; c < k; c++) {
    const d = decoded.getChannelData(c);
    for (let i = 0; i < d.length; i++) mono[i] += d[i] / k;
  }
  return mono;
}

// A canonical 44-byte RIFF header: one 16-byte PCM fmt chunk and one data chunk, the plainest
// layout cleffa's WAV parser accepts. Positions outside `samples` are silence, so a video window past
// the end of its soundtrack still carries sound for its whole span.
export function encodeWav(samples, start = 0, end = samples.length) {
  const n = Math.max(0, end - start);
  const out = new Uint8Array(44 + 2 * n), v = new DataView(out.buffer);
  const ascii = (at, s) => { for (let i = 0; i < s.length; i++) out[at + i] = s.charCodeAt(i); };
  ascii(0, "RIFF"); v.setUint32(4, 36 + 2 * n, true); ascii(8, "WAVE");
  ascii(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, AUDIO_RATE, true); v.setUint32(28, 2 * AUDIO_RATE, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  ascii(36, "data"); v.setUint32(40, 2 * n, true);
  for (let i = 0; i < n; i++) v.setInt16(44 + 2 * i, Math.max(-32768, Math.min(32767, Math.round((samples[start + i] ?? 0) * 32768))), true);
  return out;
}

// Tokens for one clip alone in its request, as cleffa counts them (clef_omni_encode_audio): one
// mel frame per 160 samples, 13 tokens per full 100 frames and one per 8 of the rest, about 13 a
// second. With several clips in one request, padding to the longest changes the frame counts.
// null below the 201 samples the reference's reflection padding needs.
export function audioTokens(samples) {
  if (!(samples > 200)) return null;
  const frames = Math.floor(samples / 160);
  return 13 * Math.floor(frames / 100) + Math.floor(((frames % 100) + 7) / 8);
}

// The clip's envelope, one column of min..max per CSS pixel.
export function drawWaveform(canvas, samples) {
  const ctx = fitCanvas(canvas), w = canvas.clientWidth, h = canvas.clientHeight;
  if (!samples?.length || !w || !h) return;
  const per = samples.length / w, mid = h / 2;
  ctx.fillStyle = "rgba(246, 130, 31, 0.75)";
  for (let x = 0; x < w; x++) {
    let lo = 0, hi = 0;
    for (let i = Math.floor(x * per), e = Math.min(samples.length, Math.max(i + 1, Math.floor((x + 1) * per))); i < e; i++) {
      if (samples[i] < lo) lo = samples[i];
      else if (samples[i] > hi) hi = samples[i];
    }
    ctx.fillRect(x, mid - hi * mid, 1, Math.max(1, (hi - lo) * mid));
  }
}
