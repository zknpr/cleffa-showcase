import { afterAll, beforeAll, test, expect } from "bun:test";

let upstream: ReturnType<typeof Bun.serve>;
let child: ReturnType<typeof Bun.spawn>;
let base: string;
const origin = "https://cleffa.zknpr.xyz";
const post = (headers: Record<string, string> = {}, state = "test") => fetch(`${base}/api/systemone`, {
  method: "POST", headers: { "Content-Type": "application/json", ...headers },
  body: JSON.stringify({ model: "clef-flash", state, questions: { q: { type: "noul" } } }),
});

beforeAll(async () => {
  upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 30, async fetch(req) {
    if (new URL(req.url).pathname === "/health") return Response.json({ status: "ok", model: "model-flash" });
    const body = await req.json();
    if (body.state === "slow") await Bun.sleep(11_000);
    return Response.json({ answers: { q: { type: "noul", noul: 0.9 } }, key: req.headers.get("x-clef-prefix-cache") });
  } });
  const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  base = `http://127.0.0.1:${reservation.port}`;
  reservation.stop(true);
  child = Bun.spawn(["bun", "run", "server.ts", "--port", new URL(base).port, "--clef", upstream.url.toString(), "--allow-origin", origin], {
    cwd: new URL("..", import.meta.url).pathname,
    env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: "", CLOUDFLARE_API_TOKEN: "" }, stdout: "ignore", stderr: "pipe",
  });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(base)).ok) return; } catch { /* startup is not ready yet */ }
    await Bun.sleep(20);
  }
  throw new Error("companion did not start");
});

afterAll(async () => { child?.kill(); await child?.exited; upstream?.stop(true); });

test("companion refuses rebinding hosts and disallowed origins", async () => {
  expect((await fetch(`${base}/api/health`, { headers: { Host: "rebind.example" } })).status).toBe(403);
  expect((await post({ Origin: "https://evil.example", "Sec-Fetch-Site": "cross-site" })).status).toBe(403);
  expect((await post({ Origin: base.replace("http:", "https:") })).status).toBe(403);
});

test("explicitly allowed site can preflight, connect, and reuse its own signed cache session", async () => {
  const preflight = await fetch(`${base}/api/systemone`, { method: "OPTIONS", headers: {
    Origin: origin, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type,x-showcase-session,x-showcase-cache", "Access-Control-Request-Private-Network": "true",
  } });
  expect(preflight.status).toBe(204);
  expect(preflight.headers.get("access-control-allow-origin")).toBe(origin);
  const health = await fetch(`${base}/api/health`, { headers: { Origin: origin, "Sec-Fetch-Site": "cross-site" } });
  const session = health.headers.get("x-showcase-session");
  expect(session).toBeTruthy();
  const headers = { Origin: origin, "Sec-Fetch-Site": "cross-site", "X-Showcase-Session": session!, "X-Showcase-Cache": "1" };
  const first = await post(headers), second = await post(headers);
  expect(first.status).toBe(200);
  expect(first.headers.get("access-control-allow-origin")).toBe(origin);
  expect((await first.json()).key).toBe((await second.json()).key);
  expect((await post({ ...headers, "X-Showcase-Session": "0".repeat(32) })).status).toBe(403);
});

test("inference slower than Bun's default idle timeout still returns a response", async () => {
  const res = await post({}, "slow");
  expect(res.status).toBe(200);
  expect((await res.json()).answers.q.noul).toBe(0.9);
}, 20_000);
