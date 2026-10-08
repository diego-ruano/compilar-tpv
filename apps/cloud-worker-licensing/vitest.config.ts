// vitest.config.ts
//
// Los tests corren DENTRO de workerd (no en Node con mocks): el pool de
// Cloudflare levanta el worker real con sus bindings, así que el Durable Object
// que toca un test es el mismo TenantHub que se despliega.
//
// `wrangler.configPath` reutiliza la configuración de producción; sólo se
// sobreescriben los secretos, que en producción viven en `wrangler secret` y en
// los tests tienen que ser deterministas.

import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";

export default defineConfig({
	plugins: [
		cloudflareTest({
			wrangler: { configPath: "./wrangler.json" },
			// RI-46: aunque se habilite un binding remoto para una prueba manual, la suite
			// siempre usa recursos locales y no requiere credenciales de Cloudflare.
			remoteBindings: false,
			miniflare: {
				bindings: {
					LICENSE_JWT_SECRET: "secreto-de-pruebas-no-usar-en-produccion",
				},
			},
		}),
	],
});
