import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/server.ts"],
  format: ["esm"],
  target: "node22",
  clean: true,
  // The shared package is TypeScript source, so bundle it into the output.
  noExternal: ["@sitemate/shared"],
});
