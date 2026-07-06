import tailwindcss from "@tailwindcss/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The glass build (the @tailwindcss/vite pipeline apps/web uses). Dev runs HMR
// on :4191 and proxies /api to the daemon on :4190 — `bun run dev` raises both.
// Never :4173/:4180 (the live glass + bridge, packages/live).
export default defineConfig({
  plugins: [tailwindcss(), viteReact()],
  server: {
    host: "127.0.0.1",
    port: 4191,
    proxy: {
      "/api": "http://127.0.0.1:4190",
    },
    strictPort: true,
  },
});
