// apps/tpv-main/vitest.config.ts
//
// Tests del frontend. Config aparte de `vite.config.ts` a propósito: lo que se prueba aquí es
// principalmente lógica (módulos `.ts` que reciben datos y devuelven datos). Las regresiones de
// componentes usan jsdom sólo en los ficheros que lo declaran con @vitest-environment.
//
// Entorno **node**, no jsdom. Montar React en los tests es lento, frágil y acaba comprobando que
// React funciona; y arrancar por ahí es lo que hace que una suite de frontend se abandone. El día
// que haga falta probar un componente se añade jsdom para esos ficheros, no para todos.
//
// Funciones puras y stores se prueban sin React. Los casos de componentes comprueban efectos
// de negocio observables: confirmar una escritura, descartar respuestas tardías y bloquear
// dos cobros. Sus transportes se sustituyen por promesas controladas, sin conexiones reales.
//
// ⚠️ Si añades un test de componente: aquí `act()` NO vacía de forma síncrona. Testing Library
// carga `react` por CommonJS y el grafo de Vite resuelve otra instancia del mismo 19.2.7, así que
// `render()` vuelve con el contenedor vacío. React pinta igual, pero de forma asíncrona: hay que
// esperar al primer pintado. El porqué y el patrón, en la cabecera de `test/react/shared-ui.test.tsx`.

import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		environment: "node",
		include: ["test/**/*.test.{ts,tsx}"],
		setupFiles: ["test/react/setup.ts"],
	},
});
