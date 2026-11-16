import { defineConfig } from "vitest/config";

// Node by default; the few DOM tests opt into jsdom with a file comment.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
