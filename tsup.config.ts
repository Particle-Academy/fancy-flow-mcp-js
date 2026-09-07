import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    authoring: "src/authoring.ts",
    server: "src/server.ts",
    stdio: "src/stdio.ts",
  },
  format: ["esm", "cjs"],
  dts: { entry: ["src/index.ts", "src/authoring.ts", "src/server.ts"] },
  clean: true,
  treeshake: true,
  // fancy-flow is a peer: a host already has it, and bundling a copy would give
  // the MCP a different registry from the one the host registered its kinds in.
  external: ["@particle-academy/fancy-flow"],
});
