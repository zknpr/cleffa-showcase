// cleffa showcase: static page + a loopback proxy in front of clef-server.
//
// Why a proxy at all: clef-server deliberately has no CORS handling and is meant to sit behind
// whatever authenticates its callers, and the browser's camera API needs a secure context.
// Serving the page and its API from one localhost origin satisfies both without touching the
// engine, which is the point of keeping this client in its own repository. The optional hosted
// backend (Workers AI) is called from here so its token never reaches the browser.
//
//   bun run server.ts [--port 8790] [--bind 127.0.0.1] [--clef http://127.0.0.1:8080]
//   CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_API_TOKEN in the environment enable the hosted backend.

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { extname, join, normalize, resolve } from "node:path";
import { boundedBody, forwardToCloudflare, relayCloudflare, INFERENCE_TIMEOUT_MS } from "./relay";

const args = parseArgs(Bun.argv.slice(2));
const PORT = Number(args.port ?? process.env.PORT ?? 8790);
const BIND = String(args.bind ?? process.env.BIND ?? "127.0.0.1");
const CLEF_URL = String(args.clef ?? process.env.CLEF_URL ?? "http://127.0.0.1:8080").replace(/\/+$/, "");
const CF_ACCOUNT = process.env.CLOUDFLARE_ACCOUNT_ID ?? "";
const CF_TOKEN = process.env.CLOUDFLARE_API_TOKEN ?? "";
const HOSTED = CF_ACCOUNT.length > 0 && CF_TOKEN.length > 0;
const HOSTED_MODELS = new Set(["clef", "clef-flash"]);
const MAX_BODY = 10 * 1024 * 1024; // clef-server's own default is 8 MiB; it decides, this just bounds memory
const MAX_IMAGES = 4; // the hosted schema's maxItems and clef-server's default
const PUBLIC = resolve(import.meta.dir, "public");
const ALLOWED_ORIGIN = String(args["allow-origin"] ?? process.env.SHOWCASE_ORIGIN ?? "");
const SESSION_SECRET = randomBytes(32);
if (ALLOWED_ORIGIN && new URL(ALLOWED_ORIGIN).origin !== ALLOWED_ORIGIN) throw new Error("--allow-origin must be an exact origin, without a trailing slash or path");
const HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", BIND, String(args.host ?? "")]);

if (!Number.isInteger(PORT) || PORT <= 0 || PORT > 65535) {
  console.error(`invalid port: ${args.port ?? process.env.PORT}`);
  process.exit(2);
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

// Scripts and styles are same-origin. Media comes from the browser; inference may use a
// visitor-selected HTTPS endpoint or an explicitly connected loopback companion.
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  // CSP cannot express IPv6 host literals. The connection form permits HTTP only on loopback.
  "connect-src 'self' https: http:",
  "worker-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

function parseArgs(argv: string[]): Record<string, string | true> {
  const out: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      console.error(`unexpected argument: ${a}`);
      process.exit(2);
    }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      out[key] = next;
      i++;
    } else {
      out[key] = true;
    }
  }
  return out;
}

function securityHeaders(h = new Headers()): Headers {
  h.set("Content-Security-Policy", CSP);
  h.set("X-Content-Type-Options", "nosniff");
  h.set("Referrer-Policy", "no-referrer");
  h.set("Permissions-Policy", "camera=(self), microphone=(), geolocation=()");
  h.set("Cache-Control", "no-store");
  return h;
}

function json(status: number, body: unknown, extra?: Headers): Response {
  const h = securityHeaders(extra ?? new Headers());
  h.set("Content-Type", "application/json");
  return new Response(JSON.stringify(body), { status, headers: h });
}

// A browser session gets an opaque cookie; the engine's prefix-cache key is derived from it here.
// cleffa documents cache keys as client-visible identifiers that the authenticating layer must
// assign per isolation boundary, so the browser never chooses the key, it only asks for reuse
// (X-Showcase-Cache: 1). Hits are visible in latency, which is exactly what the demo shows.
function signSession(sid: string): string {
  return `${sid}.${createHmac("sha256", SESSION_SECRET).update(sid).digest("hex")}`;
}

function sessionOf(req: Request): { sid: string; fresh: boolean } {
  const supplied = req.headers.get("x-showcase-session");
  if (supplied) {
    if (!/^[a-f0-9]{32}\.[a-f0-9]{64}$/.test(supplied)) throw new Error("invalid session");
    const sid = supplied.slice(0, 32);
    if (!timingSafeEqual(Buffer.from(supplied), Buffer.from(signSession(sid)))) throw new Error("invalid session");
    return { sid, fresh: false };
  }
  const cookie = req.headers.get("cookie") ?? "";
  const m = /(?:^|;\s*)sid=([0-9a-f]{32})(?:;|$)/.exec(cookie);
  if (m) return { sid: m[1], fresh: false };
  return { sid: randomBytes(16).toString("hex"), fresh: true };
}

function cacheKeyOf(sid: string): string {
  return createHash("sha256").update(`cleffa-showcase:${sid}`).digest("hex").slice(0, 32);
}

function sameOrigin(req: Request): boolean {
  // Browsers send both headers on fetch(); a non-browser client (the smoke test) sends neither.
  // This keeps another page in the same browser from driving the GPU through this proxy.
  const origin = req.headers.get("origin");
  if (origin && ALLOWED_ORIGIN && origin === ALLOWED_ORIGIN) return true;
  const site = req.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") return false;
  if (origin) {
    try {
      if (new URL(origin).origin !== new URL(req.url).origin) return false;
    } catch {
      return false;
    }
  }
  return true;
}

async function serveStatic(pathname: string): Promise<Response> {
  let rel: string;
  try {
    rel = normalize(decodeURIComponent(pathname === "/" ? "/index.html" : pathname));
  } catch {
    return json(400, { error: "bad path" });
  }
  if (rel.includes("\0") || rel.split("/").includes("..")) return json(400, { error: "bad path" });
  const abs = join(PUBLIC, rel);
  if (!abs.startsWith(PUBLIC + "/")) return json(404, { error: "not found" });
  const file = Bun.file(abs);
  if (!(await file.exists())) return json(404, { error: "not found" });
  const h = securityHeaders(new Headers({ "Content-Type": MIME[extname(abs)] ?? "application/octet-stream" }));
  return new Response(file, { headers: h });
}

async function readBody(req: Request): Promise<ArrayBuffer | Response> {
  const declared = Number(req.headers.get("content-length") ?? NaN);
  if (Number.isFinite(declared) && declared > MAX_BODY) return json(413, { error: `body above ${MAX_BODY} bytes` });
  try { return await boundedBody(req, MAX_BODY); }
  catch (e) { return json(e instanceof RangeError ? 413 : 400, { error: e instanceof RangeError ? `body above ${MAX_BODY} bytes` : "could not read request body" }); }
}

// Shape checks only. The engine validates the request for real and its error text is what the
// page shows; the bytes are forwarded untouched so the response stays byte-identical to the CLI's.
function validate(buf: ArrayBuffer): { body: Record<string, unknown> } | Response {
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(buf));
  } catch {
    return json(400, { error: "body is not JSON" });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return json(400, { error: "body must be a JSON object" });
  const rec = body as Record<string, unknown>;
  if (typeof rec.model !== "string") return json(400, { error: "model must be a string" });
  if (rec.images !== undefined) {
    if (!Array.isArray(rec.images)) return json(400, { error: "images must be a list" });
    if (rec.images.length > MAX_IMAGES) return json(400, { error: `at most ${MAX_IMAGES} images per request` });
  }
  return { body: rec };
}

async function proxyLocal(buf: ArrayBuffer, cacheKey: string | null): Promise<Response> {
  const headers = new Headers({ "Content-Type": "application/json" });
  if (cacheKey) headers.set("X-Clef-Prefix-Cache", cacheKey);
  const t0 = performance.now();
  let up: Response, body: ArrayBuffer;
  const signal = AbortSignal.timeout(INFERENCE_TIMEOUT_MS);
  try {
    up = await fetch(`${CLEF_URL}/v1/systemone`, { method: "POST", headers, body: buf, signal, redirect: "error" });
    body = await boundedBody(up);
  } catch (e) {
    return json(signal.aborted ? 504 : 502, { error: signal.aborted ? "clef-server request timed out" : "clef-server unavailable or returned an invalid response" });
  }
  const ms = performance.now() - t0;
  const h = securityHeaders(
    new Headers({
      "Content-Type": up.headers.get("content-type") ?? "application/json",
      "X-Showcase-Backend": "local",
      "X-Showcase-Ms": ms.toFixed(1),
    }),
  );
  if (cacheKey) h.set("X-Showcase-Cache", "1");
  return new Response(body, { status: up.status, headers: h });
}

async function proxyHosted(buf: ArrayBuffer): Promise<Response> {
  if (!HOSTED) return json(503, { error: "hosted backend not configured (CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN)" });
  // The optional local environment credentials use the same bounded, fixed-destination forwarder;
  // the browser already passed this server's own origin check.
  return forwardToCloudflare(new Request(`http://127.0.0.1:${PORT}/api/cloudflare`, {
    method: "POST", headers: { Authorization: `Bearer ${CF_TOKEN}`, "X-Cloudflare-Account": CF_ACCOUNT }, body: buf,
  }));
}

async function health(req: Request): Promise<Response> {
  const t0 = performance.now();
  let local: Record<string, unknown>;
  try {
    const up = await fetch(`${CLEF_URL}/health`, { signal: AbortSignal.timeout(3000) });
    const body: any = await up.json().catch(() => null);
    local = { ok: up.ok && body?.status === "ok", model: body?.model ?? null, ms: Math.round(performance.now() - t0), status: up.status };
  } catch (e) {
    local = { ok: false, error: (e as Error).message };
  }
  const session = sessionOf(req);
  return json(200, { mode: "companion", local, hosted: HOSTED, hostedModels: [...HOSTED_MODELS], clef: CLEF_URL },
    new Headers({ "X-Showcase-Session": signSession(session.sid) }));
}

const server = Bun.serve({
  hostname: BIND,
  port: PORT,
  maxRequestBodySize: MAX_BODY + 4096,
  // Inference can legitimately exceed Bun's 10-second default. Upstream fetches have a
  // separate finite deadline so a failed engine cannot leave the controls busy forever.
  idleTimeout: 150,
  async fetch(req: Request) {
    const url = new URL(req.url);
    if (!HOSTS.has(url.hostname) || Number(url.port || (url.protocol === "https:" ? 443 : 80)) !== PORT) return json(403, { error: "unrecognized Host" });
    if (url.pathname.startsWith("/api/") && !sameOrigin(req)) return json(403, { error: "cross-origin requests are not accepted" });
    const t0 = performance.now();
    let res: Response;
    try {
      if (req.method === "OPTIONS" && ["/api/health", "/api/systemone"].includes(url.pathname)) {
        const requested = (req.headers.get("access-control-request-headers") ?? "").toLowerCase().split(",").map(h => h.trim()).filter(Boolean);
        res = requested.every(h => ["content-type", "x-showcase-session", "x-showcase-cache"].includes(h))
          ? new Response(null, { status: 204, headers: securityHeaders() }) : json(403, { error: "unsupported request headers" });
      } else if (url.pathname === "/api/health") {
        res = req.method === "GET" ? await health(req) : json(405, { error: "use GET" });
      } else if (url.pathname === "/api/systemone") {
        res = await systemone(req, url);
      } else if (url.pathname === "/api/cloudflare") {
        res = await relayCloudflare(req);
      } else if (req.method === "GET" || req.method === "HEAD") {
        res = await serveStatic(url.pathname);
      } else {
        res = json(405, { error: "use GET" });
      }
    } catch (e) {
      res = json((e as Error).message === "invalid session" ? 403 : 500, { error: (e as Error).message === "invalid session" ? "session expired; reconnect to the companion" : "request failed" });
    }
    if (req.headers.get("origin") === ALLOWED_ORIGIN && ALLOWED_ORIGIN) {
      res.headers.set("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
      res.headers.set("Vary", "Origin");
      res.headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.headers.set("Access-Control-Allow-Headers", "Content-Type, X-Showcase-Session, X-Showcase-Cache");
      res.headers.set("Access-Control-Expose-Headers", "X-Showcase-Session, X-Showcase-Ms, X-Showcase-Backend, X-Showcase-Cache");
      res.headers.set("Access-Control-Allow-Private-Network", "true");
    }
    // Access log without bodies: the bodies carry camera frames and the user's files.
    console.log(`${new Date().toISOString()} ${req.method} ${url.pathname} ${res.status} ${(performance.now() - t0).toFixed(1)}ms`);
    return res;
  },
});

async function systemone(req: Request, url: URL): Promise<Response> {
  if (req.method !== "POST") return json(405, { error: "use POST" });
  if (!sameOrigin(req)) return json(403, { error: "cross-origin requests are not accepted" });
  const session = sessionOf(req);
  const buf = await readBody(req);
  if (buf instanceof Response) return buf;
  const checked = validate(buf);
  if (checked instanceof Response) return checked;
  const backend = url.searchParams.get("backend") ?? "local";
  let res: Response;
  if (backend === "hosted") {
    res = await proxyHosted(buf);
  } else if (backend === "local") {
    const wantCache = req.headers.get("x-showcase-cache") === "1";
    res = await proxyLocal(buf, wantCache ? cacheKeyOf(session.sid) : null);
  } else {
    return json(400, { error: "backend must be local or hosted" });
  }
  if (session.fresh) {
    // Not Secure: the page is plain http on localhost by design.
    res.headers.append("Set-Cookie", `sid=${session.sid}; Path=/; HttpOnly; SameSite=Strict`);
  }
  return res;
}

const loopback = BIND === "127.0.0.1" || BIND === "localhost" || BIND === "::1";
console.log(`cleffa showcase on http://${BIND}:${server.port}  ->  clef-server at ${CLEF_URL}`);
console.log(`hosted backend (Workers AI): ${HOSTED ? "configured" : "off"}`);
if (!loopback) {
  console.warn("warning: bound off loopback. Browsers only allow the camera on https or localhost, and this page has no authentication.");
}
