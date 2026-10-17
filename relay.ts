// Shared by the Bun companion and the public Worker. All inference credentials are supplied
// per request; this module has no visitor state and never chooses an arbitrary upstream URL.
export const MAX_BODY = 10 * 1024 * 1024;
export const INFERENCE_TIMEOUT_MS = 120_000;
const MODELS = new Set(["clef", "clef-flash", "clef-omni"]);

export function jsonResponse(status: number, body: unknown, headers?: HeadersInit): Response {
  const h = new Headers(headers);
  h.set("Content-Type", "application/json");
  h.set("Cache-Control", "no-store");
  h.set("X-Content-Type-Options", "nosniff");
  return new Response(JSON.stringify(body), { status, headers: h });
}

export async function boundedBody(message: Request | Response, limit = MAX_BODY): Promise<ArrayBuffer> {
  if (Number(message.headers.get("content-length")) > limit) throw new RangeError("body too large");
  const reader = message.body?.getReader();
  if (!reader) return new ArrayBuffer(0);
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new RangeError("body too large");
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes.buffer;
}

type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

// The browser-facing relay. Every browser sends Origin on a POST, same-origin included, so
// requiring it turns away cross-site pages and clients that simply omit it (curl, scripts). A
// client that forges Origin still gets through with its own token: the per-IP rate limit in front
// of the public relay is the real bound, and the destination is fixed either way.
export async function relayCloudflare(req: Request, upstream: Fetcher = fetch): Promise<Response> {
  if (req.method !== "POST") return jsonResponse(405, { error: "use POST" });
  const origin = req.headers.get("origin");
  const site = req.headers.get("sec-fetch-site");
  if (!origin || origin !== new URL(req.url).origin || (site && site !== "same-origin")) {
    return jsonResponse(403, { error: "cross-origin requests are not accepted" });
  }
  return forwardToCloudflare(req, upstream);
}

// Forwards a SystemOne request to one of the three fixed Clef endpoints with the credentials it
// carries. Callers decide who may send it: the relay above, or the companion's own environment
// credentials, which never come from a browser.
export async function forwardToCloudflare(req: Request, upstream: Fetcher = fetch): Promise<Response> {
  if (req.method !== "POST") return jsonResponse(405, { error: "use POST" });
  const authorization = req.headers.get("authorization") ?? "";
  if (!/^Bearer [A-Za-z0-9._~-]{1,512}$/.test(authorization)) return jsonResponse(401, { error: "enter your Cloudflare API token" });
  const account = req.headers.get("x-cloudflare-account") ?? "";
  if (!/^[a-f0-9]{32}$/i.test(account)) return jsonResponse(400, { error: "Cloudflare account ID must be 32 hexadecimal characters" });
  let body: ArrayBuffer, model: unknown;
  try {
    body = await boundedBody(req);
    const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(body));
    model = parsed?.model;
  } catch (e) {
    return jsonResponse(e instanceof RangeError ? 413 : 400, { error: e instanceof RangeError ? "request exceeds 10 MiB" : "body must be JSON" });
  }
  if (typeof model !== "string" || !MODELS.has(model)) return jsonResponse(400, { error: "model must be clef, clef-flash or clef-omni" });
  const t0 = performance.now();
  const signal = AbortSignal.any([req.signal, AbortSignal.timeout(INFERENCE_TIMEOUT_MS)]);
  try {
    const response = await upstream(`https://api.cloudflare.com/client/v4/accounts/${account}/ai/run/@cf/cloudflare/${model}`, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: authorization }, body,
      // workerd supports manual/follow only. Inspect redirects ourselves so visitor tokens
      // cannot follow an upstream Location to a different endpoint.
      signal, redirect: "manual",
    });
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      return jsonResponse(502, { error: "Workers AI returned an unexpected redirect" });
    }
    const bytes = await boundedBody(response, 2 * 1024 * 1024);
    let parsed;
    try { parsed = JSON.parse(new TextDecoder().decode(bytes)); }
    catch { return jsonResponse(502, { error: `Workers AI returned non-JSON (HTTP ${response.status})` }); }
    const headers = { "X-Showcase-Backend": "hosted", "X-Showcase-Ms": (performance.now() - t0).toFixed(1) };
    if (!response.ok || parsed?.success === false || parsed?.errors?.length) {
      const detail = Array.isArray(parsed?.errors) ? parsed.errors.map((e: { message?: string }) => e?.message ?? "request failed").join("; ") : `HTTP ${response.status}`;
      // Upstream error bodies are untrusted; never echo the supplied credential back to the page.
      return jsonResponse(response.ok ? 502 : response.status, { error: `Workers AI: ${detail.replaceAll(authorization.slice(7), "[redacted]")}` }, headers);
    }
    if (!parsed?.result?.answers || typeof parsed.result.answers !== "object") return jsonResponse(502, { error: "Workers AI returned no answers" }, headers);
    return jsonResponse(200, parsed.result, headers);
  } catch {
    return jsonResponse(signal.aborted ? 504 : 502, { error: signal.aborted ? "Workers AI request timed out or was cancelled" : "Workers AI request failed" });
  }
}
