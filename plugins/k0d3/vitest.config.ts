import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "bb-plugin-k0d3",
    include: ["**/*.test.{ts,tsx,mts,mjs}"],
    exclude: ["node_modules/**", "dist/**"],
  },
});
