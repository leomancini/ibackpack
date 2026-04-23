import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": "http://localhost:3132",
      "/admin": "http://localhost:3132",
      "/gallery": "http://localhost:3132",
      "/map": "http://localhost:3132",
      "/ws": { target: "ws://localhost:3132", ws: true },
    },
  },
});

