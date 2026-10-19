// Tests del widget. Entorno node por defecto (la lógica pura); los de componentes y `embed.js`
// declaran jsdom en su cabecera, como en la Main.

import { defineConfig } from "vitest/config";

export default defineConfig({
	// El plano viene de @tpv/plano, que no tiene tsconfig propio: sin esto su JSX se compilaría con el
	// runtime clásico (`React.createElement` sin `React` importado).
	esbuild: { jsx: "automatic" },
	test: {
		environment: "node",
		include: ["test/**/*.test.{ts,tsx}"],
		setupFiles: ["test/setup.ts"],
	},
});
