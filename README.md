# cleffa showcase

A browser client for [cleffa](https://github.com/zknpr/cleffa), the C11 + Metal inference engine
for Cloudflare's Clef models on Apple Silicon. Point it at a camera, a video, a folder of
screenshots, one image or, with Clef-Omni, a sound; ask typed questions, and get a decision with a
probability for every option.

**Live: [cleffa.zknpr.xyz](https://cleffa.zknpr.xyz).** The site runs no inference of its own and
has no login. Connect your own engine: a local cleffa, any SystemOne API, or your Cloudflare
account.

| Mode | What it does |
|---|---|
| **Live** | The camera, one frame in flight at a time. Decisions update in place; a 60-second timeline draws one lane per question; engine time, round trip, frame rate and tokens per frame. |
| **Video** | Cuts a clip into windows (2, 4, 8 s or the whole clip, optionally overlapping) and sends each as one native video request, so motion questions are answered from the frames together. On clef-omni each window also carries its stretch of the clip's sound. Decisions follow the playhead. |
| **Batch** | One set of questions over a folder of PNG or JPEG files, up to eight in flight. Filter by any answer, inspect in a lightbox, export JSON or CSV. |
| **Ask** | One image, one audio clip (clef-omni) or both, many question sets. With the engine's prefix cache, later asks reuse the image and the history shows the time saved. |

Questions are edited per mode (yes/no, one of, scale) or as request JSON. The `</>` inspector
shows the last request, the response and a matching `curl` command.

## Run

You need an Apple Silicon Mac with cleffa built and a model converted (see its README),
[Bun](https://bun.sh) 1.3 or later, and a current browser (the test suite runs Chrome).

```sh
# in the cleffa checkout
./clef-server -m gguf/clef-flash.gguf --port 8080 --prefix-cache-mb 1024
# or Clef-Omni, for audio and video with sound (./download_models.sh clef-omni)
./clef-server -m gguf/clef-omni.gguf --port 8080

# in this repository
bun run start      # http://127.0.0.1:8790, proxies to clef-server on 127.0.0.1:8080
bun run smoke      # optional: checks recorded image, video and Omni audio responses through the proxy
```

Open http://127.0.0.1:8790. The page finds its companion and the model clef-server loaded.
`--prefix-cache-mb` is only needed for Ask's reuse; cleffa has none for Omni, so Ask sends Omni
requests without a cache key. The page stays inside the engine's default limits: 4 images per
request, 1,024 tokens per image, 16,777,216 source pixels, 32 frames and 1,024 tokens per video,
and on Omni 4 audio clips and 300 seconds of audio. Ask says when a clip is over 300 s or the
request over clef-server's 8 MiB body, and the engine then refuses it. The pinned engine commit is
in `package.json`.

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
your account and pass through the site's relay, which forwards them to the three Clef endpoints
(clef, clef-flash, clef-omni) and stores nothing. The hosted models reject `videos` and
`media_kwargs` (checked 2026-10-08), so Video is unavailable there and the browser resizes images
to the token budget before upload. Omni audio goes as sent, as PCM16 WAV data URLs; cleffa's
hosted comparison sent float32 WAV, so hosted PCM16 is untested. Video stays off for
hosted clef-omni as well: cleffa's hosted comparison sent Omni video as MOV uploads, and hosted Omni
with this page's frame arrays is untested.

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

### Clef-Omni

Ask adds the clip as `audio`; a Video window carries its sound inside the video:

```json
{"audio": ["data:audio/wav;base64,..."]}
```

```json
{
  "videos": [{"frames": ["data:image/jpeg;base64,...", "..."], "fps": 2, "audio": "data:audio/wav;base64,..."}],
  "media_kwargs": {"videos_kwargs": {"fps": 2, "do_sample_frames": false, "use_audio_in_video": true,
                                     "size": {"shortest_edge": 4096, "longest_edge": 131072}}}
}
```

cleffa refuses Omni video at any rate but 2 frames a second, so Sampling is fixed on Omni: a
window holds two frames per whole second of its length, centred in it, and a whole clip covers at
most 16 s (32 frames). Omni sizes each frame on its own, so `size` is the budget's share per frame
pair: 131,072 pixels for 4 pairs at 512 tokens, which again makes 640×360 frames 480×256 and 480
tokens. That is also Omni's own per-frame minimum (128 tokens a pair): with a budget under 128
tokens per second of window the share falls below it, which cleffa accepts and the cost line points
out. At clef-server's default `--max-video-tokens 1024`, an 8 s window reaches the minimum only at
the full budget and a whole 16 s clip never does. Whether frames that small change Omni's answers
is not measured. Omni writes no `<t seconds>` text; time is in its positions. Images default to at most
1,048,576 pixels (1,024 tokens) instead of 16,777,216, and Ask shows that cost.

**Audio** is WAV, mono, 16 kHz, PCM16, the exact inverse of cleffa's `s / 32768`. The browser
decodes, resamples and mixes the file to mono, so it reads anything it can play, the soundtrack of
a video included; that resampling is the browser's, with no claim of parity with cleffa's
`tools/audio_request.py`. A window's sound covers exactly the span of its frames, silence past
the end of the track. Audio costs 13 tokens per 100 mel frames of 160 samples plus one per 8 of the
rest (rounded up), about 13 a second: 52 for a 4-second window, 26 for 2 seconds. `tests/omni.test.ts` holds
values checked with cleffa's encoder (`clef-tool encode`, cleffa 24fc91e), where 105 Omni window
shapes and 12 clip lengths matched the page's counts.

On one M5 Max (2026-10-17), the page's 4-second window with sound took 542 ms of engine time and 2
seconds of audio alone 254 ms (`bun run smoke`). Over a 12-second synthetic clip, silent for 6 s
and then a 440 Hz tone, the "Sound and picture" preset answered `loudest: silence` (0.83–0.84) for
the silent windows and for every window with Sound off, and `other` (0.49–0.50) for the two
windows inside the tone. These are smoke checks that the sound arrives where it should, not
accuracy measurements.

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

The browser suite uses mocked responses, a synthetic camera and generated clips; real inference
is checked by `bun run smoke` against a running engine. The clips come from:

```sh
ffmpeg -f lavfi -i 'color=c=black:size=320x180:rate=4:duration=12' \
  -vf 'drawbox=x=30:y=50:w=60:h=60:color=orange:t=fill' \
  -c:v libvpx-vp9 -deadline realtime -cpu-used 8 fixtures/test-clip.webm
# the same picture, silent for 6 s and then a 440 Hz tone, for Omni's soundtracks
ffmpeg -f lavfi -i 'color=c=black:size=320x180:rate=4:duration=12' \
  -f lavfi -i "aevalsrc='if(lt(t,6),0,0.25*sin(2*PI*440*t))':s=48000:d=12" \
  -vf 'drawbox=x=30:y=50:w=60:h=60:color=orange:t=fill' \
  -c:v libvpx-vp9 -deadline realtime -cpu-used 8 -c:a libopus -b:a 24k -shortest fixtures/test-clip-sound.webm
# 2 s of the tone in stereo, for Ask
ffmpeg -f lavfi -i "aevalsrc='0.25*sin(2*PI*440*t)|0.25*sin(2*PI*440*t)':s=48000:d=2" \
  -c:a libopus -b:a 24k fixtures/tone.ogg
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
  token and a Clef model name. It forwards to three fixed endpoints only, drops cookies and other
  headers, refuses redirects, bounds bodies and redacts the token from errors. A client that
  forges `Origin` can still use it with its own token, gaining nothing the token does not already
  allow; the Worker limits each IP to 600 relay calls a minute.
- Audio comes from files only. The page never asks for the microphone, and Permissions-Policy
  keeps it off (`microphone=()`).
- No third-party or inline scripts, no analytics, no browser storage of tokens, media or results.
  The CSP keeps scripts and styles to the site's origin; text from responses and files is rendered
  as text, and CSV exports neutralize formula-leading cells.

## Not measured

The preset questions in `public/presets.js` illustrate the request shape. How well the model
triages recon screenshots, spots phishing pages, reads receipts or tells speech, music and
languages apart has not been measured against labeled data, and this page claims nothing about it. The engine's parity, batch invariance and
latency are established in cleffa's own tests and reports.

## License

MIT. See [LICENSE](LICENSE).
