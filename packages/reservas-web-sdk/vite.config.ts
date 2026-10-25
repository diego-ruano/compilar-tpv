// packages/reservas-web-sdk/vite.config.ts
//
// Lo que se publica en npm (`pnpm build`): el SDK en ES modules, sin dependencias, con su entrada de
// tipos aparte (`./tipos`). El que sirve el worker para las webs sin compilación
// (`/reservas-web/v1/sdk.js`) lo compila el widget desde estas mismas fuentes, en un solo fichero
// (`apps/reservas-web/vite.config.ts`).

import { defineConfig } from "vite";

export default defineConfig({
	build: {
		lib: { entry: { index: "src/index.ts", tipos: "src/tipos.ts" }, formats: ["es"] },
		outDir: "dist",
		emptyOutDir: true,
		sourcemap: false,
		target: "es2020",
	},
});
