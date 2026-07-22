import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import svgr from '@svgr/rollup'
import { sentryVitePlugin } from "@sentry/vite-plugin";
import { readFileSync } from "node:fs";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// Versión de la app (para nombrar el release de Sentry). Ver nota de coherencia más abajo.
const version = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8"),
).version;

// Source maps → Sentry (proyecto tpv-desktop). SÓLO se activa cuando hay auth token
// (build de release / CI). En dev o en un build local sin token es un no-op total: ni sube
// nada ni falla, así que es seguro dejarlo cableado siempre.
//
// ⚠️ El `release` DEBE coincidir con el que llevan los eventos, que es el CARGO_PKG_VERSION
// del crate `tpv` (lo fija main.rs). Si divergen, Sentry recibe la traza pero no sabe
// symbolicarla. CI puede forzarlo con SENTRY_RELEASE; por defecto usamos la versión del
// package.json (hoy 0.1.0, igual que Cargo).
const sentryPlugins = process.env.SENTRY_AUTH_TOKEN
  ? [
      sentryVitePlugin({
        org: process.env.SENTRY_ORG ?? "altarialights",
        project: process.env.SENTRY_PROJECT ?? "tpv-desktop",
        authToken: process.env.SENTRY_AUTH_TOKEN,
        release: { name: process.env.SENTRY_RELEASE ?? version },
        // Borra los .map del bundle tras subirlos, para no shippearlos en el instalador.
        sourcemaps: { filesToDeleteAfterUpload: ["./dist/**/*.map"] },
        telemetry: false,
      }),
    ]
  : [];

// https://vite.dev/config/
export default defineConfig(async () => ({
  // El plugin de Sentry debe ir el último de la lista.
  plugins: [svgr(), react(), tailwindcss(), ...sentryPlugins],

  build: {
    // Genera source maps sólo cuando vamos a subirlos (hay token); si no, build más ligero.
    sourcemap: !!process.env.SENTRY_AUTH_TOKEN,
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
        protocol: "ws",
        host,
        port: 1421,
      }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
