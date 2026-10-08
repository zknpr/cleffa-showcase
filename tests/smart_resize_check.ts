// The page shows an image's or a video window's token cost before sending it, using ports of the
// processors' smart_resize. This compares those ports with the reference over cases generated from
// cleffa's Python environment (transformers pinned there), so the number on the screen is the
// engine's. Cases with `t` (a frame count) are video cases.
//
//   # in the cleffa checkout:
//   .venv/bin/python -B - > cases.json <<'PY'
//   import json, random
//   from transformers.models.qwen2_vl.image_processing_qwen2_vl import smart_resize
//   from transformers.models.qwen3_vl.video_processing_qwen3_vl import smart_resize as video_resize
//   rng = random.Random(7); out = []
//   sizes = [(h, w) for h in (16, 31, 32, 33, 48, 64, 100, 252, 336, 480, 720, 1080, 1536, 2048, 3000, 4000)
//                   for w in (16, 32, 100, 336, 640, 1024, 1920, 2048, 4000)]
//   sizes += [(rng.randint(1, 4096), rng.randint(1, 4096)) for _ in range(3000)]
//   for h, w in sizes:
//       for mn, mx in [(65536, 16777216), (65536, 1048576), (65536, 262144), (3136, 12845056)]:
//           try: hb, wb = smart_resize(h, w, 32, mn, mx)
//           except ValueError: hb = wb = None
//           out.append({"h": h, "w": w, "min": mn, "max": mx, "hb": hb, "wb": wb})
//   for h, w in sizes[:1144]:
//       for t in (1, 2, 3, 7, 8, 31, 32):
//           for mn, mx in [(4096, 25165824), (4096, 1048576), (4096, 262144), (4096, 2097152)]:
//               try: hb, wb = video_resize(t, h, w, 2, 32, mn, mx)
//               except ValueError: hb = wb = None
//               out.append({"t": t, "h": h, "w": w, "min": mn, "max": mx, "hb": hb, "wb": wb})
//   print(json.dumps(out))
//   PY
//   bun run tests/smart_resize_check.ts cases.json

import { readFileSync } from "node:fs";
// @ts-ignore: a browser module without type declarations; it has no DOM dependencies.
import { smartResize as pageSmartResize, videoResize as pageVideoResize } from "../public/js/resize.js";

type Size = { h: number; w: number } | null;
const smartResize: (h: number, w: number, mn: number, mx: number) => Size = pageSmartResize;
const videoResize: (t: number, h: number, w: number, mn: number, mx: number) => Size = pageVideoResize;

const path = process.argv[2];
if (!path) { console.error("usage: bun run tests/smart_resize_check.ts cases.json"); process.exit(2); }
const cases: { t?: number; h: number; w: number; min: number; max: number; hb: number | null; wb: number | null }[] = JSON.parse(readFileSync(path, "utf8"));
let bad = 0, video = 0;
for (const c of cases) {
  if (c.t !== undefined) video++;
  const r = c.t !== undefined ? videoResize(c.t, c.h, c.w, c.min, c.max) : smartResize(c.h, c.w, c.min, c.max);
  const got = r ? [r.h, r.w] : [null, null];
  if (got[0] !== c.hb || got[1] !== c.wb) { bad++; if (bad <= 5) console.log("MISMATCH", c, got); }
}
console.log(`${cases.length - bad}/${cases.length} smart_resize cases (${video} video) identical to the reference${bad ? "" : " (PASS)"}`);
process.exit(bad ? 1 : 0);
