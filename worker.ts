import { jsonResponse, relayCloudflare } from "./relay";

const CSP = [
  "default-src 'self'", "script-src 'self'", "style-src 'self'", "img-src 'self' data: blob:",
  // Endpoint validation allows HTTP only on loopback; CSP cannot express IPv6 host literals.
  "media-src 'self' blob:", "connect-src 'self' https: http:",
  "worker-src 'none'", "object-src 'none'", "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'",
].join("; ");

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    let response: Response;
    try {
      if (url.pathname === "/api/health") {
        response = request.method === "GET" ? jsonResponse(200, { mode: "public", hosted: true }) : jsonResponse(405, { error: "use GET" });
      } else if (url.pathname === "/api/cloudflare") {
        const limit = await env.RELAY_LIMITER.limit({ key: request.headers.get("CF-Connecting-IP") ?? "unknown" });
        response = limit.success ? await relayCloudflare(request)
          : jsonResponse(429, { error: "Too many relay requests. Try again in a minute." }, { "Retry-After": "60" });
      } else if (url.pathname.startsWith("/api/")) {
        response = jsonResponse(404, { error: "Connect your own inference service. This website does not host a Cleffa engine." });
      } else if (request.method === "GET" || request.method === "HEAD") {
        response = await env.ASSETS.fetch(request);
      } else response = jsonResponse(405, { error: "use GET" });
    } catch {
      // No exception text or request logging: either can contain a visitor's credentials.
      response = jsonResponse(502, { error: "The request could not be completed. Try again." });
    }
    const headers = new Headers(response.headers);
    headers.set("Content-Security-Policy", CSP);
    headers.set("X-Content-Type-Options", "nosniff");
    headers.set("Referrer-Policy", "no-referrer");
    headers.set("Permissions-Policy", "camera=(self), microphone=(), geolocation=()");
    headers.set("Cache-Control", "no-store");
    return new Response(response.body, { status: response.status, headers });
  },
};
