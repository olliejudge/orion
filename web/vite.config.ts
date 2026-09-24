/// <reference types="vitest/config" />
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import { svelteTesting } from "@testing-library/svelte/vite";
import { defineConfig, type Plugin } from "vite";

const outDir = resolve(import.meta.dirname, "../internal/webassets/static");

// emptyOutDir wipes static/ before every build, including the committed
// .gitkeep. This plugin writes it back once the bundle is on disk, so a
// build never shows up as a deleted file in `git status`.
function keepGitkeep(): Plugin {
  return {
    name: "orion-keep-gitkeep",
    apply: "build",
    closeBundle() {
      writeFileSync(resolve(outDir, ".gitkeep"), "");
    },
  };
}

export default defineConfig({
  plugins: [svelte(), svelteTesting(), keepGitkeep()],
  build: {
    outDir,
    emptyOutDir: true,
    target: "es2022",
    chunkSizeWarningLimit: 1500,
  },
  server: {
    proxy: {
      "/ws": { target: "ws://127.0.0.1:7070", ws: true, changeOrigin: true },
    },
  },
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.ts"],
    setupFiles: ["./src/test-setup.ts"],
  },
});
