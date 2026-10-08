import { test, expect } from "bun:test";

const modulePath = "../relay.ts";
const request = (headers: Record<string, string> = {}, body = '{"model":"clef-flash","questions":{"q":{"type":"noul"}}}') => new Request("https://cleffa.zknpr.xyz/api/cloudflare", {
  method: "POST", headers: { "Content-Type": "application/json", Origin: "https://cleffa.zknpr.xyz", Authorization: "Bearer visitor-token", "X-Cloudflare-Account": "a".repeat(32), ...headers }, body,
});

test("relay requires credentials, validates account and model, and refuses other origins before fetching", async () => {
  const mod = await import(modulePath).catch(() => null);
  expect(mod?.relayCloudflare).toBeFunction();
  let calls = 0;
  const upstream = async () => { calls++; return Response.json({}); };
  for (const [req, status] of [
    [request({ Authorization: "" }), 401],
    [request({ "X-Cloudflare-Account": "../elsewhere" }), 400],
    [request({ Origin: "https://evil.example" }), 403],
    [request({}, '{"model":"../secrets"}'), 400],
  ] as const) expect((await mod.relayCloudflare(req, upstream)).status).toBe(status);
  expect(calls).toBe(0);
});

test("relay refuses requests without a browser Origin before fetching", async () => {
  const mod = await import(modulePath).catch(() => null);
  expect(mod?.relayCloudflare).toBeFunction();
  let calls = 0;
  const upstream = async () => { calls++; return Response.json({ success: true, result: { answers: {} } }); };
  // curl and scripts omit Origin; every browser sends it on a POST, same-origin included.
  const bare = request();
  bare.headers.delete("origin");
  expect((await mod.relayCloudflare(bare, upstream)).status).toBe(403);
  expect((await mod.relayCloudflare(request({ "Sec-Fetch-Site": "cross-site" }), upstream)).status).toBe(403);
  expect(calls).toBe(0);
});

test("relay sends only the visitor credentials to a fixed Cloudflare endpoint and unwraps responses", async () => {
  const mod = await import(modulePath).catch(() => null);
  expect(mod?.relayCloudflare).toBeFunction();
  const req = request({ Cookie: "unrelated=private" });
  const original = await req.clone().text();
  const result = await mod.relayCloudflare(req, async (url: string, init: RequestInit) => {
    expect(url).toBe(`https://api.cloudflare.com/client/v4/accounts/${"a".repeat(32)}/ai/run/@cf/cloudflare/clef-flash`);
    const headers = new Headers(init.headers);
    expect(headers.get("authorization")).toBe("Bearer visitor-token");
    expect(headers.has("cookie")).toBe(false);
    expect(new TextDecoder().decode(init.body as ArrayBuffer)).toBe(original);
    expect(init.redirect).toBe("manual");
    return Response.json({ success: true, result: { answers: { q: { type: "noul", noul: 0.8 } } } });
  });
  expect(result.status).toBe(200);
  expect((await result.json()).answers.q.noul).toBe(0.8);
  expect(result.headers.get("Cache-Control")).toBe("no-store");
  expect([...result.headers.values()].join(" ")).not.toContain("visitor-token");
});

test("relay bounds streamed bodies and fails explicitly on upstream errors", async () => {
  const mod = await import(modulePath).catch(() => null);
  expect(mod?.relayCloudflare).toBeFunction();
  const big = request({}, "x".repeat(10 * 1024 * 1024 + 1));
  expect((await mod.relayCloudflare(big, async () => { throw new Error("must not fetch"); })).status).toBe(413);
  const failed = await mod.relayCloudflare(request(), async () => { throw new Error("private upstream detail visitor-token"); });
  expect(failed.status).toBe(502);
  expect(await failed.text()).not.toContain("visitor-token");
  const denied = await mod.relayCloudflare(request(), async () => Response.json({ success: false, errors: [{ message: "invalid API token" }] }, { status: 403 }));
  expect(denied.status).toBe(403);
  expect(await denied.text()).toContain("invalid API token");
  const redirected = await mod.relayCloudflare(request(), async () => new Response(null, { status: 307, headers: { Location: "https://elsewhere.example" } }));
  expect(redirected.status).toBe(502);
  expect(await redirected.text()).toContain("unexpected redirect");
});
