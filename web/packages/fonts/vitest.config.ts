import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // Regenerating ~1000 faces into a temp dir takes a moment.
    testTimeout: 30_000,
  },
});
