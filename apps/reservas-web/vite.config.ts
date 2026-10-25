// apps/reservas-web/vite.config.ts
//
// El widget de reservas web (docs/estudios/reservas-web.md §7). Lo sirve el worker `tpv-api` con
// Workers Static Assets, desde `dist/` (ver `assets` en su `wrangler.json`): por eso se compila en
// `dist/reservas-web/`, y las rutas que ve el navegador son `/reservas-web/assets/…` y
// `/reservas-web/v1/embed.js` (que sale tal cual de `public/v1/`). Los HTML no se sirven como fichero:
// el worker los lee y los manda con su CSP, el widget por `/reservas-web/v1/w/:clave` y la casilla de
// Turnstile del SDK (`verificar.html`) por `…/verificar`.
//
// Además deja en `v1/sdk.js` el SDK (`packages/reservas-web-sdk`) en un solo fichero, para las webs
// que no compilan nada: el mismo código que el paquete de npm, compilado desde las mismas fuentes.

import { fileURLToPath } from "node:url";
import { build, defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const SALIDA = "dist/reservas-web";

/** El SDK servido por el worker (`/reservas-web/v1/sdk.js`), al acabar el build del widget. */
function sdkServido(): Plugin {
	return {
		name: "sdk-servido",
		apply: "build",
		async closeBundle() {
			await build({
				configFile: false,
				logLevel: "warn",
				// Sin `public/`: `embed.js` ya lo copia el build del widget.
				publicDir: false,
				build: {
					lib: {
						entry: fileURLToPath(new URL("../../packages/reservas-web-sdk/src/index.ts", import.meta.url)),
						formats: ["es"],
						fileName: () => "sdk.js",
					},
					outDir: `${SALIDA}/v1`,
					emptyOutDir: false,
					sourcemap: false,
					target: "es2020",
				},
			});
		},
	};
}

export default defineConfig({
	base: "/reservas-web/",
	plugins: [react(), tailwindcss(), sdkServido()],
	build: {
		outDir: SALIDA,
		emptyOutDir: true,
		// Sin mapas: el widget es público y no tiene Sentry propio.
		sourcemap: false,
		rollupOptions: {
			input: {
				index: fileURLToPath(new URL("index.html", import.meta.url)),
				verificar: fileURLToPath(new URL("verificar.html", import.meta.url)),
			},
		},
	},
	server: {
		// Para desarrollar contra un worker local (`wrangler dev`): mismo origen para la API.
		proxy: { "/v1": "http://localhost:8787" },
	},
});
