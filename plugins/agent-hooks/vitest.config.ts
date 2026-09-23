import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "bb-plugin-agent-hooks",
    include: ["**/*.test.{ts,tsx}"],
    exclude: ["node_modules/**"],
  },
});
