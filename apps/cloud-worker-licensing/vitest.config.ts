// vitest.config.ts
//
// Los tests corren DENTRO de workerd (no en Node con mocks): el pool de
// Cloudflare levanta el worker real con sus bindings, así que el Durable Object
// que toca un test es el mismo TenantHub que se despliega.
//
// `wrangler.configPath` reutiliza la configuración de producción (bindings, Durable Objects,
// reglas de módulos), pero la suite no puede hablar con nada de verdad:
//
//   · Los textos del entorno —las `vars` de `wrangler.json`, los secretos y lo que haya en el
//     `.dev.vars` del equipo— se pisan con los de `test/helpers/entornoDePruebas.ts`: direcciones
//     `.invalid` y secretos deterministas, y vacío todo lo que no esté en esa tabla.
//   · Todo lo que el worker de pruebas manda fuera (`fetch`, WebSocket, sockets) sale por un worker
//     auxiliar que lo corta y lo apunta. Los dobles de un test no pasan por ahí: sustituyen al
//     cliente o al `fetch` antes de que la petición salga. Ver `test/helpers/sinRed.ts`.
//
// La excepción son los `*.node.test.ts`: no prueban el worker, leen su fuente con el analizador de
// TypeScript, que workerd no puede cargar (el proceso del pool se cae al importarlo). Corren en
// Node, en su propio proyecto, y `pnpm --filter tpv-api test` ejecuta los dos. Tampoco salen a la
// red: `test/helpers/sinRed.node.setup.ts`.

import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import { configDefaults, defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";

import {
	COLECTOR_DE_SALIDAS,
	SALIDA_BLOQUEADA,
	WORKER_SIN_RED,
	describirSalida,
	entornoDeLaSuite,
} from "./test/helpers/entornoDePruebas";

const aqui = (relativa: string) => fileURLToPath(new URL(relativa, import.meta.url));

const EN_NODE = "test/**/*.node.test.ts";

/**
 * Los textos que wrangler va a meter en el entorno del worker de pruebas: las `vars` de
 * `wrangler.json` y lo que haya en el `.dev.vars` de esta carpeta o, si no existe, en su `.env` y
 * su `.env.local`. El pool no deja desactivar esa carga, así que se le pregunta al mismo wrangler
 * que usa él (el suyo, no el de este paquete) qué va a cargar. De ahí sólo se usan los nombres.
 */
function textosQueCargaWrangler(): string[] {
	const pool = realpathSync(aqui("./node_modules/@cloudflare/vitest-pool-workers/package.json"));
	const wranglerDelPool = createRequire(pool)("wrangler");
	const { workerOptions } = wranglerDelPool.unstable_getMiniflareWorkerOptions(aqui("./wrangler.json"));
	return Object.keys(workerOptions.bindings ?? {});
}

// El worker por el que sale la red de la suite. Lo que le llega no tenía doble y además se ha
// saltado la guarda (`test/helpers/sinRed.ts`): lo corta, lo apunta, y la guarda lo recoge por
// `Colector` al terminar cada test. Contesta en vez de lanzar: una excepción aquí sólo saldría como
// ruido en la consola, y lo que hace fallar al test es lo apuntado.
const RED_BLOQUEADA = `
import { WorkerEntrypoint } from "cloudflare:workers";

const describirSalida = ${describirSalida.toString()};

const cortadas = [];

export default {
	fetch(peticion) {
		const salida = describirSalida(peticion.method, peticion.url);
		cortadas.push(salida);
		return new Response(${JSON.stringify(SALIDA_BLOQUEADA)} + ": " + salida, { status: 599 });
	},
};

export class Colector extends WorkerEntrypoint {
	fetch() {
		return Response.json(cortadas.splice(0));
	}
}
`;

export default defineConfig({
	// Vite carga por su cuenta el `.env` de esta carpeta y lo pasa a los tests por `import.meta.env`
	// y `process.env` (las claves `VITE_*`). Aquí no se usa para nada: sin carpeta, no carga ninguno.
	// Hace falta aquí y en cada proyecto: con uno solo de los dos sitios, una `VITE_*` del `.env`
	// sigue llegando a los tests (comprobado con un `.env` de mentira).
	envDir: false,
	test: {
		projects: [
			{
				envDir: false,
				plugins: [
					cloudflareTest({
						wrangler: { configPath: "./wrangler.json" },
						// RI-46: aunque se habilite un binding remoto para una prueba manual, la suite
						// siempre usa recursos locales y no requiere credenciales de Cloudflare.
						remoteBindings: false,
						miniflare: {
							bindings: entornoDeLaSuite(textosQueCargaWrangler()),
							outboundService: WORKER_SIN_RED,
							serviceBindings: {
								[COLECTOR_DE_SALIDAS]: { name: WORKER_SIN_RED, entrypoint: "Colector" },
							},
							workers: [
								{
									name: WORKER_SIN_RED,
									modules: true,
									script: RED_BLOQUEADA,
									compatibilityDate: "2026-05-29",
								},
							],
						},
					}),
				],
				test: {
					name: "workerd",
					exclude: [...configDefaults.exclude, EN_NODE],
					// La guarda de red, antes de cada fichero de tests.
					setupFiles: ["./test/helpers/sinRed.setup.ts"],
				},
			},
			{
				envDir: false,
				test: {
					name: "node",
					include: [EN_NODE],
					environment: "node",
					// Su propia guarda: aquí no hay workerd ni worker auxiliar.
					setupFiles: ["./test/helpers/sinRed.node.setup.ts"],
				},
			},
		],
	},
});
