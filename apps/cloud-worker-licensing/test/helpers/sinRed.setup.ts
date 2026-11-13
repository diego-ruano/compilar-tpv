// test/helpers/sinRed.setup.ts
//
// Lo que Vitest carga antes de cada fichero de tests (`setupFiles` en `vitest.config.ts`): pone la
// guarda de red y hace fallar al test que haya intentado salir sin un doble. El porqué y el cómo,
// en `sinRed.ts`.

import { afterAll, afterEach, vi } from "vitest";

import { exigirQueNadaHayaSalido, ponerGuardaDeRed } from "./sinRed";

ponerGuardaDeRed();

// Un socket TCP: `vi.mock` sustituye el `connect` de `cloudflare:sockets` para todo lo que lo
// importe por el cargador de Vitest (los tests y el worker). Lo que lo abra por dentro de otro
// módulo del runtime (`node:net`, `node:tls`) no pasa por aquí: lo corta el worker auxiliar, sin
// apuntarlo, y `sinRed.test.ts` vigila que nadie los importe.
vi.mock("cloudflare:sockets", async (original) => {
	const { conectarConGuarda } = await import("./sinRed");
	return { ...(await original<object>()), connect: conectarConGuarda };
});

// Después de cada test, y al acabar el fichero por lo que salga en un `afterAll` o en una promesa
// que sobrevive a su test.
afterEach(exigirQueNadaHayaSalido);
afterAll(exigirQueNadaHayaSalido);
