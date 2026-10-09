import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import svgr from '@svgr/rollup'
import { sentryVitePlugin } from "@sentry/vite-plugin";
import { readFileSync } from "node:fs";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// Versión del paquete frontend, usada como release de los source maps si no hay SENTRY_RELEASE.
const version = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8"),
).version;

// Source maps → Sentry (proyecto tpv-desktop). SÓLO se activa cuando hay auth token
// (build de release / CI). En dev o en un build local sin token es un no-op total: ni sube
// nada ni falla, así que es seguro dejarlo cableado siempre.
//
// RI-24: los eventos usan CARGO_PKG_VERSION de `tpv`, fijado en `src-tauri/src/lib.rs`.
// La subida de mapas usa SENTRY_RELEASE o la versión de este package.json; esa variable
// no cambia la release de los eventos nativos. Ambas deben coincidir para simbolizar.
// El workflow actual sólo valida tag/tauri.conf.json/Cargo.toml y no configura la subida
// de mapas: no pasa SENTRY_AUTH_TOKEN ni SENTRY_RELEASE.
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
