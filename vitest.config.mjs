import { defineConfig } from "vitest/config";
import { fileURLToPath } from "url";

export default defineConfig({
  resolve: {
    // The real "obsidian" package has no runtime code; tests use a small mock.
    alias: { obsidian: fileURLToPath(new URL("./tests/mocks/obsidian.ts", import.meta.url)) },
  },
  test: {
    globals: true,
    setupFiles: ["tests/setup.ts"],
    include: ["tests/**/*.test.ts"],
    exclude: ["node_modules/**", ".claude/**"],
    // Tests with real git repositories get slow on Windows when the machine is busy.
    testTimeout: 30000,
  },
});
