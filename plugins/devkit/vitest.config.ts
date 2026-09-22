import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "bb-plugin-devkit",
    include: ["**/*.test.{ts,tsx,mts,mjs}"],
    exclude: ["node_modules/**", "dist/**"],
  },
});
