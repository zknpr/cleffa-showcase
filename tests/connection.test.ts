import { test, expect } from "bun:test";
const path = "../public/js/connection.js";

test("connection URLs reject credentials, fragments and insecure remote hosts", async () => {
  const mod = await import(path).catch(() => null);
  expect(mod?.normalizeEndpoint).toBeFunction();
  for (const url of ["javascript:alert(1)", "https://user:secret@example.com", "http://example.com", "https://example.com/#secret", "https://example.com/?token=secret"]) {
    expect(() => mod.normalizeEndpoint(url)).toThrow();
  }
  expect(mod.normalizeEndpoint("http://localhost:8790/")).toBe("http://localhost:8790");
  expect(mod.normalizeEndpoint("https://api.example.com/v1/systemone")).toBe("https://api.example.com/v1/systemone");
});
