import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "bb-plugin-agent-hooks",
    include: ["**/*.test.{ts,tsx}"],
    exclude: ["node_modules/**"],
    coverage: {
      provider: "v8",
      reporter: ["text-summary", "lcov"],
      exclude: ["node_modules/**", "tests/**", "**/*.test.{ts,tsx}", "vitest.config.ts"],
    },
  },
});
