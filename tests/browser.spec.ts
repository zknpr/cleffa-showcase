import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";

const fixture = JSON.parse(readFileSync(new URL("../fixtures/v001.json", import.meta.url), "utf8"));
const picture = { name: "frame.jpg", mimeType: "image/jpeg", buffer: Buffer.from(fixture.images[0].replace(/^data:[^,]*,/, ""), "base64") };

function response(req: any) {
  return {
    answers: Object.fromEntries(Object.entries(req.questions).map(([id, q]: [string, any]) => [id,
      q.type === "noul" ? { type: "noul", noul: 0.9 } : q.type === "choice"
        ? { type: "choice", choice: Object.keys(q.criteria)[0], confidence: 1, probabilities: Object.fromEntries(Object.keys(q.criteria).map((k, i) => [k, i === 0 ? 1 : 0])) }
        : { type: "score", score: 0, confidence: 1, probabilities: { "0": 1 } },
    ])),
    usage: { input_tokens: 373 },
  };
}

const clip = (name: string) => new URL(`../fixtures/${name}`, import.meta.url).pathname;

// The companion reports the GGUF's name; model-omni is what cleffa's converter writes for Omni.
async function useOmni(page: Page) {
  await page.route("**/api/health", route => route.fulfill({ json: {
    local: { ok: true, model: "model-omni", ms: 1 }, hosted: true, clef: "http://127.0.0.1:8080",
  } }));
  await page.reload();
  await expect(page.locator("#engine-name")).toContainText("clef-omni");
}

// A WAV data URL as cleffa reads it: the header it requires, the sample count and the RMS level.
function wav(url: string) {
  expect(url).toMatch(/^data:audio\/wav;base64,/);
  const b = Buffer.from(url.slice(url.indexOf(",") + 1), "base64");
  expect([b.toString("ascii", 0, 4), b.toString("ascii", 8, 12), b.readUInt32LE(4) + 8]).toEqual(["RIFF", "WAVE", b.length]);
  expect([b.readUInt16LE(20), b.readUInt16LE(22), b.readUInt32LE(24), b.readUInt16LE(34)]).toEqual([1, 1, 16000, 16]);
  const samples = b.readUInt32LE(40) / 2;
  let sum = 0;
  for (let i = 0; i < samples; i++) sum += (b.readInt16LE(44 + 2 * i) / 32768) ** 2;
  return { samples, rms: Math.sqrt(sum / samples) };
}

async function applySchema(page: Page, questions: any) {
  await page.locator('#pane-ask [data-action="edit"]').first().click();
  await page.locator("#editor-json-box summary").click();
  await page.locator("#editor-json").fill(JSON.stringify({ model: "clef-flash", state: "test", questions }));
  await page.locator("#editor-json-apply").click();
}

test.beforeEach(async ({ page }) => {
  await page.route("**/api/health", route => route.fulfill({ json: {
    local: { ok: true, model: "model-flash", ms: 1 }, hosted: true, clef: "http://127.0.0.1:8080",
  } }));
  await page.goto("/");
  await expect(page.locator("#engine-name")).toContainText("local");
});

test("all modes fit desktop and mobile and load without script errors", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  for (const width of [1440, 768, 390]) {
    await page.setViewportSize({ width, height: 900 });
    for (const mode of ["live", "video", "batch", "ask"]) {
      await page.locator(`#tab-${mode}`).click();
      await expect(page.locator(`#pane-${mode}`)).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    }
  }
  expect(errors).toEqual([]);
});

test("JSON editor preserves special question and option names", async ({ page }) => {
  await page.locator("#tab-ask").click();
  await applySchema(page, JSON.parse('{"__proto__":{"type":"noul"},"q":{"type":"choice","criteria":{"__proto__":null,"other":null}}}'));
  // Inspect the serialized request; the browser transport itself treats __proto__ specially.
  const req = JSON.parse(await page.evaluate(async () => JSON.stringify((await import("/js/schema.js")).buildRequest([], {}, "ask"))));
  expect(Object.keys(req.questions)).toEqual(["__proto__", "q"]);
  expect(Object.keys(req.questions.q.criteria)).toEqual(["__proto__", "other"]);
});

test("JSON editor preserves null and false score levels", async ({ page }) => {
  await page.locator("#tab-ask").click();
  await applySchema(page, { q: { type: "score", criteria: [null, false, "high"] } });
  const req = await page.evaluate(async () => (await import("/js/schema.js")).buildRequest([], {}, "ask"));
  expect(req.questions.q.criteria).toEqual([null, false, "high"]);
});

test("batch keeps its starting backend when the selector changes", async ({ page }) => {
  const seen: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>(r => release = r);
  await page.route("**/api/systemone?**", async route => {
    seen.push(new URL(route.request().url()).searchParams.get("backend")!);
    if (seen.length === 1) await gate;
    await route.fulfill({ json: response(route.request().postDataJSON()) });
  });
  await page.locator("#tab-batch").click();
  await page.locator("#batch-files").setInputFiles([picture, { ...picture, name: "second.jpg" }]);
  await page.locator("#batch-conc").fill("1");
  await page.locator("#batch-run").click();
  await expect.poll(() => seen.length).toBe(1);
  await page.locator("#engine-pill").click();
  await page.locator('[data-backend="hosted"]').click();
  await page.locator("#connection-connect").click();
  await expect(page.locator("#engine-name")).toContainText("Cloudflare");
  release();
  await expect(page.locator("#batch-status")).toContainText("2 / 2");
  expect(seen).toEqual(["local", "local"]);
});

test("CSV quotes filenames and prevents spreadsheet formula execution", async ({ page }) => {
  await page.route("**/api/systemone?**", route => route.fulfill({ json: response(route.request().postDataJSON()) }));
  await page.locator("#tab-batch").click();
  await page.locator("#batch-files").setInputFiles({ ...picture, name: '=HYPERLINK("https://example.com").jpg' });
  await page.locator("#batch-run").click();
  await expect(page.locator("#batch-status")).toContainText("1 / 1");
  const download = page.waitForEvent("download");
  await page.locator("#batch-export-csv").click();
  const stream = await (await download).createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream!) chunks.push(chunk);
  expect(Buffer.concat(chunks).toString()).toContain('"\'=HYPERLINK(');
});

test("remote endpoint receives inference directly and tokens never enter storage or exports", async ({ page }) => {
  await page.locator("#engine-pill").click();
  await expect(page.locator('[data-backend="remote"]')).toBeVisible({ timeout: 1000 });
  await page.locator('[data-backend="remote"]').click();
  await page.locator("#connection-remote-url").fill("https://inference.example/v1/systemone");
  await page.locator("#connection-remote-token").fill("private-test-token");
  await page.locator('[data-model="clef"]').click();
  await page.locator("#connection-connect").click();
  await page.locator("#engine-pill").click();
  let authorization: string | undefined;
  let model: string | undefined;
  await page.route("https://inference.example/v1/systemone", route => {
    authorization = route.request().headers().authorization;
    model = route.request().postDataJSON().model;
    return route.fulfill({ json: response(route.request().postDataJSON()) });
  });
  await page.locator("#tab-ask").click();
  await page.locator("#ask-file").setInputFiles(picture);
  await page.locator("#ask-go").click();
  await expect(page.locator(".ask-item")).toHaveCount(1);
  expect(authorization).toBe("Bearer private-test-token");
  expect(model).toBe("clef");
  expect(await page.evaluate(() => JSON.stringify([localStorage, sessionStorage]))).not.toContain("private-test-token");
  await page.locator("#open-inspector").click();
  await expect(page.locator("#insp-code")).not.toContainText("private-test-token");
  await page.locator('[data-tab="curl"]').click();
  await expect(page.locator("#insp-code")).toContainText("https://inference.example/v1/systemone");
  await expect(page.locator("#insp-code")).toContainText("Bearer $API_TOKEN");
  await expect(page.locator("#insp-code")).not.toContainText("private-test-token");
  await expect(page.locator("#ask-history")).not.toContainText("cache key sent");
});

test("Cloudflare connection uses the same-origin relay with the visitor account and token", async ({ page }) => {
  await page.locator("#engine-pill").click();
  await page.locator('[data-backend="hosted"]').click();
  await expect(page.locator("#connection-account")).toBeVisible({ timeout: 1000 });
  await page.locator("#connection-account").fill("a".repeat(32));
  await page.locator("#connection-cloudflare-token").fill("visitor-cloudflare-token");
  await page.locator("#connection-connect").click();
  await page.locator("#engine-pill").click();
  let headers: Record<string, string> = {};
  await page.route("**/api/cloudflare", route => {
    headers = route.request().headers();
    return route.fulfill({ json: response(route.request().postDataJSON()) });
  });
  await page.locator("#tab-ask").click();
  await page.locator("#ask-file").setInputFiles(picture);
  await page.locator("#ask-go").click();
  await expect(page.locator(".ask-item")).toHaveCount(1);
  expect(headers.authorization).toBe("Bearer visitor-cloudflare-token");
  expect(headers["x-cloudflare-account"]).toBe("a".repeat(32));
  expect(headers["x-showcase-cache"]).toBeUndefined();
  await page.locator("#open-inspector").click();
  await page.locator('[data-tab="curl"]').click();
  await expect(page.locator("#insp-code")).toContainText("/api/cloudflare");
  await expect(page.locator("#insp-code")).toContainText("$CLOUDFLARE_ACCOUNT_ID");
  await expect(page.locator("#insp-code")).not.toContainText("visitor-cloudflare-token");
});

test("live capture has one request in flight and leaving Live stops the camera", async ({ page }) => {
  let active = 0, maximum = 0, completed = 0;
  await page.route("**/api/systemone?**", async route => {
    active++;
    maximum = Math.max(maximum, active);
    const req = route.request().postDataJSON();
    expect(req.images[0]).toMatch(/^data:image\/jpeg;base64,/);
    await new Promise(r => setTimeout(r, 60));
    await route.fulfill({ json: response(req) });
    active--;
    completed++;
  });
  // The empty stage offers the camera; the dock's toggle appears once it is on.
  await expect(page.locator("#live-cam")).toBeHidden();
  await page.locator('#live-empty [data-action="cam-toggle"]').click();
  await expect(page.locator("#live-run")).toBeEnabled();
  await expect(page.locator("#live-cam")).toBeVisible();
  await page.locator("#live-run").click();
  await expect.poll(() => completed).toBeGreaterThanOrEqual(2);
  await page.locator("#live-once").click();
  await page.locator("#live-run").click();
  await page.locator("#live-run").click();
  await page.locator("#tab-ask").click();
  expect(await page.locator("#cam").evaluate((v: HTMLVideoElement) => v.srcObject)).toBeNull();
  expect(maximum).toBe(1);
});

test("video overlap and whole-clip plans send real frame arrays and navigate the timeline", async ({ page }) => {
  const requests: any[] = [];
  await page.route("**/api/systemone?**", route => {
    requests.push(route.request().postDataJSON());
    return route.fulfill({ json: response(route.request().postDataJSON()) });
  });
  await page.locator("#tab-video").click();
  await page.locator("#video-file").setInputFiles(new URL("../fixtures/test-clip.webm", import.meta.url).pathname);
  await page.locator("#video-run").click();
  await expect(page.locator("#video-status")).toContainText("5/5 windows");
  expect(requests).toHaveLength(5);
  for (const req of requests) {
    expect(req.videos[0].frames).toHaveLength(8);
    expect(req.videos[0].fps).toBe(2);
    expect(req.media_kwargs.videos_kwargs.do_sample_frames).toBe(false);
  }
  await page.locator("#video-run").focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.locator("#video-which")).toHaveText("0:02.0–0:06.0");
  await page.locator("#video-overlap").uncheck();
  await page.locator("#video-run").click();
  await expect(page.locator("#video-status")).toContainText("3/3 windows");
  await page.locator('[data-win="0"]').click();
  await page.locator("#video-run").click();
  await expect(page.locator("#video-status")).toContainText("1/1 windows");
  expect(requests.at(-1).videos[0].frames).toHaveLength(24);
});

test("changing only video state invalidates in-flight results", async ({ page }) => {
  let release!: () => void;
  const gate = new Promise<void>(r => release = r);
  let seen = 0;
  await page.route("**/api/systemone?**", async route => {
    seen++;
    await gate;
    await route.fulfill({ json: response(route.request().postDataJSON()) });
  });
  await page.locator("#tab-video").click();
  await page.locator("#video-file").setInputFiles(new URL("../fixtures/test-clip.webm", import.meta.url).pathname);
  await page.locator("#video-run").click();
  await expect.poll(() => seen).toBeGreaterThan(0);
  await page.locator('#pane-video [data-action="edit"]').click();
  await page.locator("#editor-state").fill("A different task about this clip.");
  release();
  await expect(page.locator("#video-run")).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator("#video-decisions .dcard:not(.pending)")).toHaveCount(0);
});

test("Ask ignores an answer for an image replaced while it was in flight", async ({ page }) => {
  let release!: () => void;
  const gate = new Promise<void>(r => release = r);
  let seen = false;
  await page.route("**/api/systemone?**", async route => { seen = true; await gate; await route.fulfill({ json: response(route.request().postDataJSON()) }); });
  await page.locator("#tab-ask").click();
  await page.locator("#ask-file").setInputFiles(picture);
  await page.locator("#ask-go").click();
  await expect.poll(() => seen).toBe(true);
  await page.locator("#ask-file-2").setInputFiles({ ...picture, name: "replacement.jpg" });
  release();
  await expect(page.locator("#ask-go")).toBeEnabled();
  await expect(page.locator(".ask-item")).toHaveCount(0);
});

test("question drawer traps keyboard focus", async ({ page }) => {
  await page.locator('#pane-live [data-action="edit"]').click();
  await page.locator("#editor [data-close]").first().focus();
  await page.keyboard.press("Shift+Tab");
  expect(await page.evaluate(() => !!document.activeElement?.closest("#editor"))).toBe(true);
});

test("concurrent video limit errors both retry at the fitted budget", async ({ page }) => {
  let oversized = 0, release!: () => void;
  const both = new Promise<void>(r => release = r);
  await page.route("**/api/systemone?**", async route => {
    const req = route.request().postDataJSON();
    if (req.media_kwargs.videos_kwargs.size.longest_edge > 128 * 2048) {
      if (++oversized === 2) release();
      await both;
      await route.fulfill({ status: 400, json: { error: "video resizes to 240 tokens, above the limit of 128 per video" } });
    } else await route.fulfill({ json: response(req) });
  });
  await page.locator("#tab-video").click();
  await page.locator("#video-file").setInputFiles(new URL("../fixtures/test-clip.webm", import.meta.url).pathname);
  await page.locator("#video-run").click();
  await expect(page.locator("#video-status")).toContainText("5/5 windows");
  await expect(page.locator("#video-error")).toHaveText("");
});

test("Cloudflare image budgets resize in the browser without unsupported request fields", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const mod = await import("/js/hosted.js").catch(() => null);
    if (!mod) return null;
    const canvas = document.createElement("canvas");
    canvas.width = 2000; canvas.height = 1500;
    const req = await mod.prepareHostedRequest({ model: "clef-flash", state: "photo", images: [canvas.toDataURL("image/png")],
      media_kwargs: { min_pixels: 65536, max_pixels: 524288 }, questions: { q: { type: "noul" } } });
    const img = new Image(); img.src = req.images[0]; await img.decode();
    return { hasBounds: Object.hasOwn(req, "media_kwargs"), width: img.naturalWidth, height: img.naturalHeight, questions: req.questions };
  });
  expect(result).not.toBeNull();
  expect(result).toEqual({ hasBounds: false, width: 832, height: 608, questions: { q: { type: "noul" } } });
});

test("Cloudflare video is refused before uploading frames", async ({ page }) => {
  await page.locator("#engine-pill").click();
  await page.locator('[data-backend="hosted"]').click();
  await page.locator("#connection-connect").click();
  await page.locator("#engine-pill").click();
  await page.locator("#tab-video").click();
  await page.locator("#video-file").setInputFiles(new URL("../fixtures/test-clip.webm", import.meta.url).pathname);
  await expect(page.locator("#video-run")).toBeDisabled();
  await expect(page.locator("#video-cost")).toContainText("Cloudflare");
});

test("public startup makes no local-network probes and disconnect clears credentials", async ({ page }) => {
  const requests: string[] = [];
  page.on("request", req => requests.push(req.url()));
  await page.route("**/api/health", route => route.fulfill({ json: { mode: "public", hosted: true } }));
  await page.reload();
  await expect(page.locator("#engine-name")).toHaveText("Connect your engine");
  expect(requests.every(url => new URL(url).origin === new URL(page.url()).origin)).toBe(true);
  await page.locator("#engine-pill").click();
  await page.locator('[data-backend="hosted"]').click();
  await page.locator("#connection-account").fill("a".repeat(32));
  await page.locator("#connection-cloudflare-token").fill("temporary-token");
  await page.locator("#connection-connect").click();
  await expect(page.locator("#engine-name")).toContainText("Cloudflare");
  await page.locator("#connection-disconnect").click();
  await expect(page.locator("#connection-cloudflare-token")).toHaveValue("");
  const connection = await page.evaluate(async () => (await import("/js/connection.js")).snapshotConnection());
  expect(connection).toMatchObject({ enabled: false, token: "", session: "" });
});

test("clef-omni video windows send 2 fps frames with their stretch of the soundtrack", async ({ page }) => {
  await useOmni(page);
  const requests: any[] = [];
  await page.route("**/api/systemone?**", route => {
    requests.push(route.request().postDataJSON());
    return route.fulfill({ json: response(route.request().postDataJSON()) });
  });
  await page.locator("#tab-video").click();
  // 12 s: silence, then a 440 Hz tone at 0.25 from 6 s.
  await page.locator("#video-file").setInputFiles(clip("test-clip-sound.webm"));
  await expect(page.locator("#video-fps")).toBeDisabled();
  await expect(page.locator("#video-fps-out")).toHaveText("2 fps");
  await expect(page.locator("#video-cost")).toContainText("8 frames, 2 a second at 320×192, 240 tokens per window, with its sound: 52 more tokens");
  // 4 s at 512 tokens bounds each frame at exactly Omni's own 131,072-pixel minimum: no warning.
  await expect(page.locator("#video-cost")).not.toContainText("minimum");
  await page.locator("#video-run").click();
  await expect(page.locator("#video-status")).toContainText("5/5 windows");
  expect(requests).toHaveLength(5);
  const levels = requests.map(req => {
    expect(req.model).toBe("clef-omni");
    expect(req.videos[0].frames).toHaveLength(8);
    expect(req.videos[0].fps).toBe(2);
    expect(req.media_kwargs.videos_kwargs).toEqual({ fps: 2, do_sample_frames: false, use_audio_in_video: true, size: { shortest_edge: 4096, longest_edge: 131072 } });
    const audio = wav(req.videos[0].audio);
    expect(audio.samples).toBe(4 * 16000);
    return audio.rms;
  });
  // Windows start every 2 s: 0-4 and 2-6 are silent, 6-10 and 8-12 carry the tone (RMS 0.177).
  expect(levels[0]).toBeLessThan(0.01);
  expect(levels[1]).toBeLessThan(0.01);
  expect(levels[3]).toBeGreaterThan(0.15);
  expect(levels[4]).toBeGreaterThan(0.15);
  await expect(page.locator("#video-strip code")).toHaveCount(0); // Omni writes no "<t seconds>" text
  await page.locator("#video-sound").uncheck();
  await expect(page.locator("#video-cost")).toContainText("no sound");
  await page.locator("#video-run").click();
  await expect.poll(() => requests.length).toBe(10);
  await expect(page.locator("#video-run")).toHaveAttribute("aria-pressed", "false");
  for (const req of requests.slice(5)) {
    expect(req.videos[0]).not.toHaveProperty("audio");
    expect(req.media_kwargs.videos_kwargs).toEqual({ fps: 2, do_sample_frames: false, size: { shortest_edge: 4096, longest_edge: 131072 } });
  }
});

test("clef-omni video of a clip without sound sends frames only, and a whole 12 s clip is one 24-frame request", async ({ page }) => {
  await useOmni(page);
  const requests: any[] = [];
  await page.route("**/api/systemone?**", route => {
    requests.push(route.request().postDataJSON());
    return route.fulfill({ json: response(route.request().postDataJSON()) });
  });
  await page.locator("#tab-video").click();
  await page.locator("#video-file").setInputFiles(clip("test-clip.webm"));
  await expect(page.locator("#video-cost")).toContainText("no sound: the clip has no sound the browser can decode");
  await expect(page.locator("#video-sound")).toBeDisabled();
  await page.locator("#video-run").click();
  await expect(page.locator("#video-status")).toContainText("5/5 windows");
  for (const req of requests) {
    expect(req.videos[0]).toEqual({ frames: expect.any(Array), fps: 2 });
    expect(req.media_kwargs.videos_kwargs).not.toHaveProperty("use_audio_in_video");
  }
  await expect(page.locator('[data-win="0"]')).toHaveAttribute("title", /at most 16 s/);
  await page.locator('[data-win="0"]').click();
  // 512 tokens over 12 frame pairs bounds each frame at 43,008 pixels, under Omni's own minimum.
  await expect(page.locator("#video-cost")).toContainText("under clef-omni's own minimum of 131,072 pixels");
  await page.locator("#video-run").click();
  await expect(page.locator("#video-status")).toContainText("1/1 windows");
  expect(requests.at(-1).videos[0].frames).toHaveLength(24);
  expect(requests.at(-1).media_kwargs.videos_kwargs.size.longest_edge).toBe(Math.floor(512 / 12) * 1024);
});

test("clef-omni: editing the questions while the soundtrack decodes stops the run before it sends", async ({ page }) => {
  // Every decode waits until the test releases it: the run sits in "Reading the soundtrack…".
  await page.addInitScript(() => {
    const decode = BaseAudioContext.prototype.decodeAudioData;
    const gate = new Promise(r => (window as any).releaseDecode = r);
    BaseAudioContext.prototype.decodeAudioData = async function (this: BaseAudioContext, data: ArrayBuffer) { await gate; return decode.call(this, data); };
  });
  await useOmni(page);
  let seen = 0;
  await page.route("**/api/systemone?**", route => { seen++; return route.fulfill({ json: response(route.request().postDataJSON()) }); });
  await page.locator("#tab-video").click();
  await page.locator("#video-file").setInputFiles(clip("test-clip-sound.webm"));
  await page.locator("#video-run").click();
  await expect(page.locator("#video-status")).toContainText("Reading the soundtrack");
  await page.locator('#pane-video [data-action="edit"]').click();
  await page.locator("#editor-state").fill("A different task about this clip.");
  await expect(page.locator("#video-run")).toHaveAttribute("aria-pressed", "false");
  await page.evaluate(() => (window as any).releaseDecode());
  await expect(page.locator("#video-cost")).toContainText("with its sound");
  await page.waitForTimeout(500);
  expect(seen).toBe(0);
  await expect(page.locator("#video-decisions .dcard:not(.pending)")).toHaveCount(0);
});

test("switching to clef-omni re-plans the idle filmstrip", async ({ page }) => {
  await page.locator("#tab-video").click();
  await page.locator("#video-file").setInputFiles(clip("test-clip-sound.webm"));
  await expect(page.locator("#video-strip code").first()).toBeVisible(); // dense: "<t seconds>" captions
  // clef-server restarted with the Omni GGUF; the page's next health check (every 5 s) sees it.
  await page.route("**/api/health", route => route.fulfill({ json: {
    local: { ok: true, model: "model-omni", ms: 1 }, hosted: true, clef: "http://127.0.0.1:8080",
  } }));
  await expect(page.locator("#engine-name")).toContainText("clef-omni", { timeout: 10_000 });
  await expect(page.locator("#video-strip code")).toHaveCount(0);
});

test("a frame-limit error on clef-omni points at the window, not the locked sampling", async ({ page }) => {
  await useOmni(page);
  await page.route("**/api/systemone?**", route => route.fulfill({ status: 400, json: {
    error: "video has 8 sampled frames, above the limit of 4 or its source count; lower videos_kwargs.fps/num_frames",
  } }));
  await page.locator("#tab-video").click();
  await page.locator("#video-file").setInputFiles(clip("test-clip-sound.webm"));
  await page.locator("#video-run").click();
  await expect(page.locator("#video-error")).toContainText("(here: choose a shorter window)");
});

test("Ask takes a dropped video file's sound as audio, not as an image", async ({ page }) => {
  await useOmni(page);
  await page.locator("#tab-ask").click();
  // Chromium types .webm as video/webm, audio-only recordings included.
  const bytes = readFileSync(clip("test-clip-sound.webm")).toString("base64");
  await page.evaluate((b64) => {
    const file = new File([Uint8Array.from(atob(b64), c => c.charCodeAt(0))], "voice.webm", { type: "video/webm" });
    const dt = new DataTransfer();
    dt.items.add(file);
    document.querySelector("#ask-stage")!.dispatchEvent(new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }));
  }, bytes);
  await expect(page.locator("#ask-audio-geom")).toContainText("16 kHz mono");
  await expect(page.locator("#ask-error")).toHaveText("");
});

test("Ask refuses audio for a model that takes none, before sending", async ({ page }) => {
  let sent = 0;
  await page.route("**/api/systemone?**", route => { sent++; return route.fulfill({ json: response(route.request().postDataJSON()) }); });
  await page.locator("#tab-ask").click();
  await page.locator("#ask-audio").setInputFiles(clip("tone.ogg"));
  await expect(page.locator("#ask-audio-geom")).toContainText("needs clef-omni");
  await page.locator("#ask-go").click();
  await expect(page.locator("#ask-error")).toContainText("clef-flash takes no audio");
  expect(sent).toBe(0);
});

test("Ask sends audio to clef-omni alone or beside an image, without a cache key", async ({ page }) => {
  await useOmni(page);
  const requests: any[] = [], headers: Record<string, string>[] = [];
  await page.route("**/api/systemone?**", route => {
    requests.push(route.request().postDataJSON());
    headers.push(route.request().headers());
    return route.fulfill({ json: response(route.request().postDataJSON()) });
  });
  await page.locator("#tab-ask").click();
  await expect(page.locator("#ask-cache")).toBeDisabled();
  // 2 s of a 440 Hz tone at 0.25 on both channels: mixed to mono it keeps its level.
  await page.locator("#ask-audio").setInputFiles(clip("tone.ogg"));
  await expect(page.locator("#ask-audio-geom")).toContainText("16 kHz mono, 26 audio tokens");
  await expect(page.locator("#ask-empty")).toBeHidden();
  await page.locator("#ask-go").click();
  await expect(page.locator(".ask-item")).toHaveCount(1);
  expect(requests[0]).not.toHaveProperty("images");
  const audio = wav(requests[0].audio[0]);
  expect(Math.abs(audio.samples - 32000)).toBeLessThan(400);
  expect(Math.abs(audio.rms - 0.25 / Math.SQRT2)).toBeLessThan(0.02);
  expect(headers[0]["x-showcase-cache"]).toBeUndefined();

  // A 2048x1536 photo is 3,072 tokens on the dense models; Omni bounds it at 1,048,576 pixels.
  const big = await page.evaluate(() => {
    const c = document.createElement("canvas");
    c.width = 2048; c.height = 1536;
    const ctx = c.getContext("2d")!;
    ctx.fillStyle = "#468"; ctx.fillRect(0, 0, 2048, 1536);
    return c.toDataURL("image/jpeg", 0.8).split(",")[1];
  });
  await page.locator("#ask-file-2").setInputFiles({ name: "big.jpg", mimeType: "image/jpeg", buffer: Buffer.from(big, "base64") });
  await expect(page.locator("#ask-geom")).toContainText("2048×1536 → 1152×864, 972 image tokens");
  await expect(page.locator(".ask-item")).toHaveCount(0);
  await expect(page.locator("#ask-empty")).toBeHidden();
  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  await page.locator("#ask-go").click();
  await expect(page.locator(".ask-item")).toHaveCount(1);
  expect(requests[1].images).toHaveLength(1);
  expect(requests[1].audio).toEqual(requests[0].audio);

  await page.locator("#ask-audio-remove").click();
  await expect(page.locator("#ask-audio-box")).toBeHidden();
  await page.locator("#ask-go").click();
  await expect(page.locator(".ask-item")).toHaveCount(1);
  expect(requests[2]).not.toHaveProperty("audio");
  expect(requests[2].images).toEqual(requests[1].images);
});

test("Cloudflare clef-omni takes audio through the relay unchanged", async ({ page }) => {
  await page.locator("#engine-pill").click();
  await page.locator('[data-backend="hosted"]').click();
  await page.locator("#connection-account").fill("a".repeat(32));
  await page.locator("#connection-cloudflare-token").fill("visitor-cloudflare-token");
  await page.locator('[data-model="clef-omni"]').click();
  await page.locator("#connection-connect").click();
  await page.locator("#engine-pill").click();
  await expect(page.locator("#engine-name")).toContainText("clef-omni · Cloudflare");
  let req: any = null;
  await page.route("**/api/cloudflare", route => { req = route.request().postDataJSON(); return route.fulfill({ json: response(req) }); });
  await page.locator("#tab-ask").click();
  await page.locator("#ask-audio").setInputFiles(clip("tone.ogg"));
  await page.locator("#ask-go").click();
  await expect(page.locator(".ask-item")).toHaveCount(1);
  expect(req.model).toBe("clef-omni");
  expect(wav(req.audio[0]).samples).toBeGreaterThan(31000);
});
