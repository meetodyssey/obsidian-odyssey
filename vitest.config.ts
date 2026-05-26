import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      obsidian: fileURLToPath(new URL("./tests/mocks/obsidian.ts", import.meta.url))
    }
  },
  test: {
    environment: "node",
    exclude: [...configDefaults.exclude, "**/.claude/**"]
  }
});
