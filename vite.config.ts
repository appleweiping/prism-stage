import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig(({ command }) => ({
  base: "./",
  plugins: [
    react(),
    {
      name: "production-csp",
      transformIndexHtml(html) {
        return command === "build"
          ? html.replace(
              '<meta charset="UTF-8" />',
              "<meta charset=\"UTF-8\" /><meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self' blob:; worker-src 'self' blob:; font-src 'self'; object-src 'none'; base-uri 'self'; form-action 'none'\" />",
            )
          : html;
      },
    },
  ],
  worker: { format: "es" },
  build: { chunkSizeWarningLimit: 1800 },
}));
