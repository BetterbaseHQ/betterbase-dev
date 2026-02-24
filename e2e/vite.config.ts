import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import wasm from "vite-plugin-wasm";
const syncUrl = "http://localhost:25379";
const accountsUrl = "http://localhost:25377";

export default defineConfig({
  plugins: [wasm(), react()],
  worker: {
    format: "es",
    plugins: () => [wasm()],
  },
  server: {
    port: 25390,
    strictPort: true,
    fs: {
      allow: [".", "../betterbase"],
    },
    proxy: {
      // Accounts service — user key lookups for invitations
      "/v1/users": {
        target: accountsUrl,
        changeOrigin: true,
      },
      // Sync service — WebSocket
      "/api/v1/ws": {
        target: syncUrl,
        changeOrigin: true,
        ws: true,
      },
      // Sync service — REST
      "/api/v1": {
        target: syncUrl,
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: "dist",
    target: "es2022",
  },
});
