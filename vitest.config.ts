import { defineConfig } from "vitest/config";

// Unit tests are pure; keep them away from the Cloudflare plugin and its remote bindings.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "worker/**/*.test.ts"],
  },
});
