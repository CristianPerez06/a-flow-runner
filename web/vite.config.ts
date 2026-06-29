import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const SERVER_PORT = process.env.SERVER_PORT ?? "4319";

// In dev, Vite serves the UI and proxies the WebSocket to the Node service.
// In prod, the Node service serves the built bundle and there is no proxy.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5319,
    proxy: {
      "/ws": {
        target: `ws://localhost:${SERVER_PORT}`,
        ws: true,
      },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
