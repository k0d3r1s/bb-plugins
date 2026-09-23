import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "bb-plugin-devkit",
    include: ["**/*.test.{ts,tsx,mts,mjs}"],
    exclude: ["node_modules/**", "dist/**"],
    coverage: {
      provider: "v8",
      include: ["server.ts", "src/**"],
      reporter: ["text-summary", "lcov"],
      exclude: ["node_modules/**", "dist/**", "scripts/**", "**/*.test.{ts,tsx,mts,mjs}", "**/*.d.mts", "vitest.config.ts"],
    },
  },
});
