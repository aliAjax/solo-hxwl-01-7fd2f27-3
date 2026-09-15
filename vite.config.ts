import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "0.0.0.0",
    port: 5101,
    proxy: {
      "/api": "http://localhost:5102",
    },
  },
  preview: {
    host: "0.0.0.0",
    port: 5101,
  },
});
