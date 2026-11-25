import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { sentryVitePlugin } from "@sentry/vite-plugin";
import { sentryBuildConfig } from "../../scripts/release/sentry-config.mjs";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// RI-24: una release necesita configuración completa y la misma versión que los eventos de Rust.
// En desarrollo, sin token, no se generan ni se suben mapas.
const sentry = sentryBuildConfig();
const sentryPlugins = sentry.enabled
  ? [
      sentryVitePlugin({
        org: sentry.org,
        project: sentry.project,
        authToken: sentry.authToken,
        release: {
          name: sentry.release,
          inject: false,
          setCommits: false,
          // El puente de tauri-plugin-sentry 0.5 deserializa con sentry-rust 0.42, que no
          // acepta debug_meta.images de tipo sourcemap. Asociar por release/ruta evita que
          // esos eventos se descarten antes de llegar a Sentry.
          uploadLegacySourcemaps: [{ paths: ["./dist/assets"], urlPrefix: "~/assets", validate: true }],
        },
        sourcemaps: { disable: true, filesToDeleteAfterUpload: ["./dist/**/*.map"] },
        telemetry: false,
      }),
    ]
  : [];

// https://vite.dev/config/
export default defineConfig(async () => ({
  // El plugin de Sentry debe ir el último de la lista.
  plugins: [react(), tailwindcss(), ...sentryPlugins],

  // `TAURI_ENV_*` las pone Tauri al compilar el frontend; `TAURI_ENV_PLATFORM` dice si es Android
  // (`shared/lib/plataforma.ts`).
  envPrefix: ["VITE_", "TAURI_ENV_"],

  build: {
    // Genera source maps sólo cuando vamos a subirlos (hay token); si no, build más ligero.
    sourcemap: sentry.enabled ? "hidden" : false,
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
