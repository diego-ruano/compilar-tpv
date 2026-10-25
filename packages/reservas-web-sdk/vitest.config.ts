// Tests del SDK. Entorno node por defecto; los que necesitan la página (la casilla, el iframe)
// declaran jsdom en su cabecera.

import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		environment: "node",
		include: ["test/**/*.test.ts"],
	},
});
