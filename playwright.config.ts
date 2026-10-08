import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  testMatch: "browser.spec.ts",
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:8791", channel: "chrome", headless: true,
    permissions: ["camera"],
    launchOptions: { args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] },
  },
  webServer: {
    command: "bun run server.ts --port 8791",
    url: "http://127.0.0.1:8791",
    reuseExistingServer: false,
  },
});
