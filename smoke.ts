// Smoke test for the showcase proxy against a running clef-server.
//
//   bun run smoke.ts [http://127.0.0.1:8790]
//
// Checks: the proxy is up and sees a healthy engine; two requests answer through the proxy with
// the expected shape and token count, twice byte-identically, and, when a recorded response for
// the engine's model exists under fixtures/expected/, byte for byte as recorded. The recorded
// bodies come from `./clef` at the cleffa commit pinned in package.json, so this doubles as the
// drift check between this client and the engine.
//
//   v001      the vision corpus's v001: a 336x252 webcam frame, three question types
//   video001  a Video window as the page sends it: 8 frames of a 4-second synthetic clip (an
//             orange square moving right) at 2 fps, do_sample_frames false, the 512-token budget.
//             Made with ffmpeg: a 640x360 clip from lavfi `color` sources (the square overlaid at
//             x = 40 + 80t), one frame at each (k + 0.5) / 2 s, scaled to 320x180, JPEG -q:v 4.

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const base = (process.argv[2] ?? "http://127.0.0.1:8790").replace(/\/+$/, "");
let failures = 0;
const pass = (msg: string) => console.log(`PASS ${msg}`);
const fail = (msg: string) => { failures++; console.log(`FAIL ${msg}`); };

// One fixture through the proxy: answer types, token count, a byte-identical repeat, and the
// recorded body for this model when there is one.
async function fixture(model: string, name: string, want: Record<string, string>, tokens: number, tokenNote: string) {
  const request = readFileSync(join(import.meta.dir, "fixtures", `${name}.json`), "utf8");
  const post = async () => {
    const res = await fetch(`${base}/api/systemone?backend=local`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: request,
    });
    return { status: res.status, body: await res.text(), ms: res.headers.get("X-Showcase-Ms"), backend: res.headers.get("X-Showcase-Backend") };
  };
  const a = await post();
  if (a.status !== 200) { fail(`${name} returned HTTP ${a.status}: ${a.body.slice(0, 300)}`); return; }
  if (a.backend !== "local" || !a.ms) fail(`${name}: missing X-Showcase-Backend/X-Showcase-Ms headers`); else pass(`${name} answered in ${a.ms} ms (engine side)`);

  let parsed: any;
  try { parsed = JSON.parse(a.body); } catch { fail(`${name}: response is not JSON`); return; }
  const answers = parsed.answers ?? {};
  for (const [id, type] of Object.entries(want)) {
    if (answers[id]?.type === type) pass(`${name}: answer ${id} is a ${type}`); else fail(`${name}: answer ${id}: ${JSON.stringify(answers[id])}`);
  }
  if (parsed.usage?.input_tokens === tokens) pass(`${name}: usage.input_tokens = ${tokens} (${tokenNote})`);
  else fail(`${name}: usage.input_tokens = ${parsed.usage?.input_tokens}, expected ${tokens}`);

  const b = await post();
  if (b.status === 200 && b.body === a.body) pass(`${name}: repeated request is byte-identical`); else fail(`${name}: repeated request differs`);

  const expectedPath = join(import.meta.dir, "fixtures", "expected", `${name}.${model.replace(/[^A-Za-z0-9_.-]/g, "_")}.json`);
  if (existsSync(expectedPath)) {
    const expected = readFileSync(expectedPath, "utf8").replace(/\n$/, "");
    if (expected === a.body) pass(`${name}: body matches recorded ${expectedPath.split("/").slice(-2).join("/")}`);
    else fail(`${name}: body differs from recorded ${expectedPath}\n  got:      ${a.body.slice(0, 200)}\n  expected: ${expected.slice(0, 200)}`);
  } else {
    console.log(`SKIP no recorded ${name} response for model "${model}" (${expectedPath})`);
  }
}

async function main() {
  const health = await (await fetch(`${base}/api/health`)).json();
  if (!health?.local?.ok) {
    fail(`clef-server is not healthy through the proxy: ${JSON.stringify(health?.local)}`);
    return;
  }
  const model: string = health.local.model ?? "unknown";
  pass(`proxy up, engine healthy (model ${model}, ${health.local.ms} ms)`);

  await fixture(model, "v001", { wearing_glasses: "noul", mood: "choice", energy: "score" },
    373, "80 of them image: 336x252 resizes to 320x256");
  await fixture(model, "video001", { motion: "choice", square_visible: "noul", speed: "score" },
    580, "240 of them video: 4 pairs of frames at 320x192, 6x10 tokens each");

  // Cross-origin posts must be refused by the proxy (same-origin page only).
  const xo = await fetch(`${base}/api/systemone`, { method: "POST", headers: { "Content-Type": "application/json", Origin: "http://evil.example", "Sec-Fetch-Site": "cross-site" }, body: "{}" });
  if (xo.status === 403) pass("cross-origin POST refused (403)"); else fail(`cross-origin POST returned ${xo.status}`);
  const big = await fetch(`${base}/api/systemone`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model: "clef", state: "x", images: [1, 2, 3, 4, 5], questions: { q: { type: "noul" } } }) });
  if (big.status === 400) pass("five images refused by the proxy (400)"); else fail(`five images returned ${big.status}`);
  const trav = await fetch(`${base}/..%2fserver.ts`);
  if (trav.status === 400 || trav.status === 404) pass("path traversal refused"); else fail(`traversal returned ${trav.status}`);
}

main()
  .catch((e) => fail(`exception: ${e?.message ?? e}`))
  .finally(() => {
    console.log(failures ? `${failures} FAILED` : "ALL PASS");
    process.exit(failures ? 1 : 0);
  });
