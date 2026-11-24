import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, fileURLToPath(new URL("../../", import.meta.url)), "");
  const api = `http://127.0.0.1:${env.PORT || 8787}`;
  return {
    plugins: [react(), tailwindcss()],
    server: {
      host: "127.0.0.1",
      port: Number(env.WEB_PORT || 5173),
      strictPort: true,
      proxy: { "/v1": api, "/docs": api, "/openapi.json": api, "/health": api },
    },
  };
});
