# cleffa showcase

A browser client for [cleffa](https://github.com/zknpr/cleffa), the C11 + Metal inference engine
for Cloudflare's Clef vision models on Apple Silicon. Point it at a camera, a video, a folder of
screenshots or one image, ask typed questions, and get a decision with a probability for every
option.

**Live: [cleffa.zknpr.xyz](https://cleffa.zknpr.xyz).** The site runs no inference of its own and
has no login. Connect your own engine: a local cleffa, any SystemOne API, or your Cloudflare
account.

| Mode | What it does |
|---|---|
| **Live** | The camera, one frame in flight at a time. Decisions update in place; a 60-second timeline draws one lane per question; engine time, round trip, frame rate and tokens per frame. |
| **Video** | Cuts a clip into windows (2, 4, 8 s or the whole clip, optionally overlapping) and sends each as one native video request, so motion questions are answered from the frames together. Decisions follow the playhead. |
| **Batch** | One set of questions over a folder of PNG or JPEG files, up to eight in flight. Filter by any answer, inspect in a lightbox, export JSON or CSV. |
| **Ask** | One image, many question sets. With the engine's prefix cache, later asks reuse the image and the history shows the time saved. |

Questions are edited per mode (yes/no, one of, scale) or as request JSON. The `</>` inspector
shows the last request, the response and a matching `curl` command.

## Run

You need an Apple Silicon Mac with cleffa built and a model converted (see its README),
[Bun](https://bun.sh) 1.3 or later, and a current browser (the test suite runs Chrome).

```sh
# in the cleffa checkout
./clef-server -m gguf/clef-flash.gguf --port 8080 --prefix-cache-mb 1024

# in this repository
bun run start      # http://127.0.0.1:8790, proxies to clef-server on 127.0.0.1:8080
bun run smoke      # optional: checks recorded image and video responses through the proxy
```

Open http://127.0.0.1:8790. The page finds its companion and the model clef-server loaded.
`--prefix-cache-mb` is only needed for Ask's reuse. The page stays inside the engine's default
limits: 4 images per request, 1,024 tokens per image, 16,777,216 source pixels, and 32 frames and
1,024 tokens per video. The pinned engine commit is in `package.json`.

Companion options: `--port`, `--bind`, `--clef URL`, `--allow-origin ORIGIN`, `--host NAME`
(or `PORT`, `BIND`, `CLEF_URL`, `SHOWCASE_ORIGIN`).

## Connect from the live site

The connection menu (top right) offers three services. Credentials stay in the tab's memory and
are cleared on Disconnect or when the tab closes.

**Local cleffa.** Start the companion with the site's origin, then choose Local cleffa and
Connect, leaving the URL at `http://127.0.0.1:8790`:

```sh
bun run start --allow-origin https://cleffa.zknpr.xyz
```

Allow local-network access if the browser asks. If it refuses, open http://127.0.0.1:8790
instead: the same page, served by the companion.

**SystemOne API.** Any HTTPS endpoint that speaks the SystemOne request format (normally
`/v1/systemone`), with an optional bearer token. Requests go straight from the browser, so the
server must allow the site's origin through CORS for `POST`, `Content-Type` and, if used,
`Authorization`. Expose `X-Showcase-Ms` for the engine-time readout. Put a public engine behind
authentication and rate limiting.

**Cloudflare.** Your account ID and an API token with Workers AI access. Requests are billed to
your account and pass through the site's relay, which forwards them to the two Clef endpoints and
stores nothing. The hosted models reject `videos` and `media_kwargs` (checked 2026-10-08), so
Video is unavailable there and the browser resizes images to the token budget before upload.

When you run the companion yourself, `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` in its
environment let it supply the credentials instead; leave the fields empty. The token never
reaches the page. Keep such a companion on loopback.

## Requests and costs

Every mode sends the same SystemOne shape:

```json
{
  "model": "clef-flash",
  "state": "A live webcam frame from a laptop.",
  "images": ["data:image/jpeg;base64,..."],
  "questions": {
    "person_present": {"type": "noul", "instructions": "Is at least one person visible?"},
    "mood": {"type": "choice", "criteria": {"happy": null, "neutral": null, "tired": null}},
    "lighting": {"type": "score", "criteria": ["dark", "dim", "good", "bright"]}
  }
}
```

A video window replaces `images` with frames the page sampled:

```json
{
  "videos": [{"frames": ["data:image/jpeg;base64,...", "..."], "fps": 2}],
  "media_kwargs": {"videos_kwargs": {"do_sample_frames": false,
                                     "size": {"shortest_edge": 4096, "longest_edge": 1048576}}}
}
```

`fps` is the window's frame count over its length, so the engine's timestamps restart at zero in
each window; `size.longest_edge` is the token budget times 2,048 pixels. Each answer is `noul`
(probability of yes), `choice` (the winner and every option's probability) or `score` (the
expected level and per-level probabilities).

**Images** cost one token per 32×32 pixels after the processor's `smart_resize`, which
`public/js/resize.js` reproduces so the page can show the cost before sending (a 336×252 webcam
frame is 80 tokens, a 1024×1024 photo 1,024). Sources over 16,777,216 pixels or 4 MiB are shrunk
in the browser to a JPEG of at most 4 megapixels; smaller files are sent byte for byte.
`tests/smart_resize_check.ts` matches the reference on 44,608 cases, 32,032 of them video.

**Video** frames are merged in pairs, and one pixel budget is spread over all frames: 8 frames of
a 640×360 clip at the default 512-token budget become 480×256, 4 pairs of 15×8 = 480 tokens.

**Batch throughput** is set by the token budget, not by requests in flight: the server packs
concurrent requests into one pass, so a card's engine time includes its batch-mates and the status
line's images per second is the throughput figure. Three synthetic 1280×800 screenshots,
clef-flash, warm, one M5 Max (2026-10-07):

| Budget | Per image | Batch of 3, per image | Against 1,024 tokens |
|---:|---:|---:|---|
| 1,024 | 826 ms | 890 ms | reference |
| 512 (default) | 455 ms | 514 ms | same decisions, probabilities within 0.04 |
| 256 | 330–387 ms | 367 ms | same page types; small text starts to fade |
| 128 | 253 ms | 299 ms | one page type wrong |

**Video windows** on a synthetic 12-second clip (a square moving right, then left), same machine:
an 8-frame window at 512 tokens took 372–386 ms. Reversing its frames flipped the answer from
right (0.86) to left (0.94), which no single frame can carry. Overlapping windows placed the turn
within 5–7 s; 2-second windows mostly read "not moving".

These are smoke checks of the trade-offs on a few synthetic inputs, not accuracy measurements.

## Develop and deploy

```sh
bun install --frozen-lockfile    # development tools only; nothing is imported at runtime
bun run typecheck
bun test tests/*.test.ts
bun run test:browser             # Playwright with Chrome: mocked services, fake camera
bun run dev:public               # the public build (static page + relay) on localhost:8787
```

The browser suite uses mocked responses, a synthetic camera and a generated clip; real inference
is checked by `bun run smoke` against a running engine. The clip comes from:

```sh
ffmpeg -f lavfi -i 'color=c=black:size=320x180:rate=4:duration=12' \
  -vf 'drawbox=x=30:y=50:w=60:h=60:color=orange:t=fill' \
  -c:v libvpx-vp9 -deadline realtime -cpu-used 8 fixtures/test-clip.webm
```

The live site is a Cloudflare Worker with static assets (`worker.ts`, `wrangler.jsonc`). To deploy
your own, change the Worker `name` and the custom-domain route, then run
`CLOUDFLARE_ACCOUNT_ID=<your account> bun run deploy`. The Worker holds no credentials, storage or
engine; only `public/` is uploaded. Logging and tracing stay off because the relay carries
visitor tokens.

## Security

- The companion listens on `127.0.0.1` with no authentication; keep it there. It rejects unknown
  Host names (DNS rebinding) and cross-origin requests, except the exact `--allow-origin`. Each
  tab gets a signed session, so prefix-cache reuse never crosses tabs.
- The relay requires a browser `Origin` matching the site, a hexadecimal account ID, a bearer
  token and a Clef model name. It forwards to two fixed endpoints only, drops cookies and other
  headers, refuses redirects, bounds bodies and redacts the token from errors. A client that
  forges `Origin` can still use it with its own token, gaining nothing the token does not already
  allow; the Worker limits each IP to 600 relay calls a minute.
- No third-party or inline scripts, no analytics, no browser storage of tokens, media or results.
  The CSP keeps scripts and styles to the site's origin; text from responses and files is rendered
  as text, and CSV exports neutralize formula-leading cells.

## Not measured

The preset questions in `public/presets.js` illustrate the request shape. How well the model
triages recon screenshots, spots phishing pages or reads receipts has not been measured against
labeled data, and this page claims nothing about it. The engine's parity, batch invariance and
latency are established in cleffa's own tests and reports.

## License

MIT. See [LICENSE](LICENSE).
