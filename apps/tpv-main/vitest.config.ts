// apps/tpv-main/vitest.config.ts
//
// Tests del frontend. Config aparte de `vite.config.ts` a propósito: lo que se prueba aquí es
// LÓGICA (módulos `.ts` que reciben datos y devuelven datos), no componentes, así que no hace
// falta el plugin de React ni un DOM.
//
// Entorno **node**, no jsdom. Montar React en los tests es lento, frágil y acaba comprobando que
// React funciona; y arrancar por ahí es lo que hace que una suite de frontend se abandone. El día
// que haga falta probar un componente se añade jsdom para esos ficheros, no para todos.
//
// Qué entra aquí: funciones puras (`shared/lib/*`) y stores de Zustand, que se prueban sin React
// (`store.getState()`). Qué NO: hooks con sockets, timers e `invoke` (useMainSocket y compañía).
// De esos, lo que merece prueba es su POLÍTICA, y para eso primero hay que sacarla a una función
// pura — igual que se hizo en Rust con `proxima_espera` del runner de jobs.

import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		environment: "node",
		include: ["test/**/*.test.{ts,tsx}"],
		setupFiles: ["test/react/setup.ts"],
	},
});
