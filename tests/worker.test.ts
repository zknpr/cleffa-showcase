import { test, expect } from "bun:test";
const path = "../worker.ts";

test("public deployment has no local inference service and serves static assets with security headers", async () => {
  const mod = await import(path).catch(() => null);
  expect(mod?.default?.fetch).toBeFunction();
  const env = { ASSETS: { fetch: async () => new Response("static page") }, RELAY_LIMITER: { limit: async () => ({ success: true }) } };
  const health = await mod.default.fetch(new Request("https://cleffa.zknpr.xyz/api/health"), env);
  expect((await health.json()).mode).toBe("public");
  const local = await mod.default.fetch(new Request("https://cleffa.zknpr.xyz/api/systemone", { method: "POST" }), env);
  expect(local.status).toBe(404);
  const page = await mod.default.fetch(new Request("https://cleffa.zknpr.xyz/"), env);
  expect(await page.text()).toBe("static page");
  expect(page.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
  expect(page.headers.get("content-security-policy")).toContain("https:");
});

test("relay rate limit returns an explicit retry response before contacting Cloudflare", async () => {
  const mod = await import(path).catch(() => null);
  expect(mod?.default?.fetch).toBeFunction();
  const res = await mod.default.fetch(new Request("https://cleffa.zknpr.xyz/api/cloudflare", { method: "POST" }), {
    RELAY_LIMITER: { limit: async () => ({ success: false }) },
  });
  expect(res.status).toBe(429);
  expect(res.headers.get("retry-after")).toBeTruthy();
});
