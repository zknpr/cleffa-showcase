// Credentials and connection sessions live only in this page's memory. A run takes a copy so
// changing the menu cannot redirect later images or retries to a different service.
import { settings, emit } from "./store.js";

let current = { backend: "local", url: "", token: "", account: "", session: "", enabled: false, revision: 0, proxy: false };
let proxyHosted = false;

export function normalizeEndpoint(value) {
  let url;
  try { url = new URL(value.trim()); } catch { throw new Error("Enter a complete http:// or https:// URL."); }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) throw new Error("Use HTTPS for a remote server, or HTTP on localhost.");
  if (url.username || url.password || url.search || url.hash) throw new Error("Keep credentials, query parameters and fragments out of the URL. Use the token field.");
  return url.href.replace(/\/+$/, "");
}

export const snapshotConnection = () => ({ ...current });
export const proxyCredentialsAvailable = () => proxyHosted;

export function configureConnection(backend, values = {}) {
  if (!["local", "remote", "hosted"].includes(backend)) throw new Error("Choose a supported backend.");
  const next = { backend, url: "", token: String(values.token ?? "").trim(), account: String(values.account ?? "").trim(), session: "", enabled: true, revision: current.revision + 1, proxy: false };
  if (/[\r\n]/.test(next.token) || next.token.length > 4096) throw new Error("Invalid API token.");
  if (backend === "hosted") {
    next.proxy = proxyHosted && !next.account && !next.token;
    if (!next.proxy && (!/^[a-f0-9]{32}$/i.test(next.account) || !/^[A-Za-z0-9._~-]{1,512}$/.test(next.token))) throw new Error("Enter a 32-character Cloudflare account ID and your API token.");
    next.url = location.origin;
  } else {
    next.url = normalizeEndpoint(values.url ?? "");
    if (backend === "remote" && new URL(next.url).pathname === "/") next.url += "/v1/systemone";
  }
  current = next;
  settings.backend = backend;
  announce();
  return snapshotConnection();
}

function announce() {
  emit("connection", { backend: current.backend, enabled: current.enabled });
  for (const mode of ["live", "video", "ask", "batch"]) emit("schema", { mode });
}

export function disconnect() {
  current = { ...current, enabled: false, token: "", account: "", session: "", revision: current.revision + 1 };
  announce();
}

export async function connectionHealth(connection = snapshotConnection()) {
  if (!connection.enabled) return { configured: false };
  if (connection.backend !== "local") return { configured: true, verified: false, backend: connection.backend };
  const headers = connection.session ? { "X-Showcase-Session": connection.session } : {};
  const res = await fetch(`${connection.url}/api/health`, { headers, credentials: "omit", signal: AbortSignal.timeout(5000), redirect: "error" });
  if (!res.ok) throw new Error(`Companion returned HTTP ${res.status}. Check --allow-origin and reconnect.`);
  const h = await res.json();
  if (h.mode === "public" || !h.local) throw new Error("This URL is the public website. Enter the URL of your local companion, usually http://127.0.0.1:8790.");
  if (current.revision === connection.revision) current.session = res.headers.get("X-Showcase-Session") ?? current.session;
  return { ...h, configured: true };
}

export async function discoverCompanion() {
  // Only probe our own origin on load. A public page must not trigger a local-network prompt
  // until its visitor explicitly chooses Connect.
  const res = await fetch("/api/health", { signal: AbortSignal.timeout(5000) });
  if (!res.ok) return;
  const h = await res.json();
  if (h.mode === "public" || !h.local || current.revision !== 0) return;
  proxyHosted = !!h.hosted;
  configureConnection("local", { url: location.origin });
  current.session = res.headers.get("X-Showcase-Session") ?? "";
  return h;
}
