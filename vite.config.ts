import { defineConfig } from "vite";

export default defineConfig({
  base: "./",
  server: {
    host: true,
    port: 5173,
  },
  build: {
    target: "es2022",
    chunkSizeWarningLimit: 2000,
  },
  // Hand tracking runs in a module worker (MediaPipe loads its ES-module WASM glue there).
  worker: {
    format: "es",
  },
});
