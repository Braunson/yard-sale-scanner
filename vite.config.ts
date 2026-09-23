import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  server: {
    allowedHosts: ["local.wesbos.com"],
  },
  plugins: [
    react(),
    // `npm run dev:local` selects wrangler.local.jsonc, which keeps D1 and R2 on this machine.
    cloudflare({ configPath: process.env.WRANGLER_CONFIG ?? "./wrangler.jsonc" }),
    VitePWA({
      registerType: "autoUpdate",
      manifest: {
        name: "Yard Sale Gold",
        short_name: "Gold",
        description: "Spot valuable finds with GPT-5.6 Luna.",
        theme_color: "#11110f",
        background_color: "#f4f0e6",
        display: "standalone",
        start_url: "/scan",
        icons: [
          { src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any maskable" },
        ],
      },
      workbox: {
        navigateFallback: "/index.html",
        globPatterns: ["**/*.{js,css,html,svg,woff2}"],
      },
    }),
  ],
});
