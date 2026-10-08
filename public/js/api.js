// All modes send through the selected connection: local companion, remote SystemOne, or the
// same-origin Cloudflare relay. A run keeps its connection snapshot until it finishes.

import { emit } from "./store.js";
import { snapshotConnection, connectionHealth } from "./connection.js";
import { prepareHostedRequest } from "./hosted.js";

export class ApiError extends Error {
  constructor(message, status, body) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

export function describeError(e) {
  if (e instanceof ApiError) return e.status ? `HTTP ${e.status}: ${e.message}` : e.message;
  return e?.message ?? String(e);
}

// `cache` asks the companion for prefix-cache reuse with its signed session identifier.
// `source` labels the request for the inspector, which never receives authentication headers.
export async function systemone(req, { cache = false, source = "", connection = snapshotConnection() } = {}) {
  if (!connection.enabled) throw new ApiError("Choose your inference service in the connection menu and press Connect.", 0, null);
  const backend = connection.backend;
  if (backend === "hosted") req = await prepareHostedRequest(req);
  const headers = { "Content-Type": "application/json" };
  if (cache && backend === "local") headers["X-Showcase-Cache"] = "1";
  if (backend === "local" && connection.session) headers["X-Showcase-Session"] = connection.session;
  if (connection.token) headers.Authorization = `Bearer ${connection.token}`;
  if (backend === "hosted" && !connection.proxy) headers["X-Cloudflare-Account"] = connection.account;
  const endpoint = backend === "remote" ? connection.url : backend === "hosted" && !connection.proxy
    ? `${connection.url}/api/cloudflare` : `${connection.url}/api/systemone?backend=${backend}`;
  const t0 = performance.now();
  const connectionInfo = { backend, endpoint, authorized: !!connection.token, relay: backend === "hosted" && !connection.proxy };
  let res;
  try {
    res = await fetch(endpoint, { method: "POST", headers, body: JSON.stringify(req), credentials: "omit", redirect: "error", signal: AbortSignal.timeout(125000) });
  } catch (e) {
    const err = new ApiError(`Connection failed: ${e.message}. Check the endpoint, its CORS policy, and browser local-network permission.`, 0, null);
    emit("exchange", { req, status: 0, body: null, text: err.message, total: performance.now() - t0, server: null, ...connectionInfo, source, at: Date.now() });
    throw err;
  }
  const text = await res.text();
  const total = performance.now() - t0;
  const server = Number(res.headers.get("X-Showcase-Ms")) || null;
  let body = null;
  try { body = JSON.parse(text); } catch { /* the error path below shows the raw text */ }
  emit("exchange", { req, status: res.status, body, text, total, server, ...connectionInfo, source, at: Date.now() });
  if (!res.ok) throw new ApiError(body?.error ?? (text || `HTTP ${res.status}`), res.status, body);
  if (!body || typeof body.answers !== "object" || body.answers === null) throw new ApiError("the response has no answers object", res.status, body);
  return { body, total, server, backend, request: req, cache: cache && backend === "local", tokens: body.usage?.input_tokens ?? null };
}

export const health = connectionHealth;
