import { defineConfig } from "vitest/config";

// Unit tests cover the pure logic modules (format, settings, update) only: no
// Solid components and no DOM, so a plain Node environment is enough and the
// Solid plugin is skipped. Tauri IPC is mocked per test with vi.mock("./ipc").
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
