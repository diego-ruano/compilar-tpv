// apps/reservas-web/vite.config.ts
//
// El widget de reservas web (docs/estudios/reservas-web.md §7). Lo sirve el worker `tpv-api` con
// Workers Static Assets, desde `dist/` (ver `assets` en su `wrangler.json`): por eso se compila en
// `dist/reservas-web/`, y las rutas que ve el navegador son `/reservas-web/assets/…` y
// `/reservas-web/v1/embed.js` (que sale tal cual de `public/v1/`). El HTML no se sirve como fichero:
// el worker lo lee y lo manda por `/reservas-web/v1/w/:clave` con su CSP.

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
	base: "/reservas-web/",
	plugins: [react(), tailwindcss()],
	build: {
		outDir: "dist/reservas-web",
		emptyOutDir: true,
		// Sin mapas: el widget es público y no tiene Sentry propio.
		sourcemap: false,
	},
	server: {
		// Para desarrollar contra un worker local (`wrangler dev`): mismo origen para la API.
		proxy: { "/v1": "http://localhost:8787" },
	},
});
