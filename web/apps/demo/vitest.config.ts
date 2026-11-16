import { defineConfig } from "vitest/config";

/**
 * Pure frame logic runs in node; component tests (`*.test.tsx`) opt into
 * jsdom with a `// @vitest-environment jsdom` comment at the top.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.{ts,tsx}"],
    setupFiles: ["./src/test-setup.ts"],
  },
});
