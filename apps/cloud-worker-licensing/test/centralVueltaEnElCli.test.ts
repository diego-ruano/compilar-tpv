// test/centralVueltaEnElCli.test.ts
//
// Lo que contesta la aplicación entera (`app`: la ruta, `completarErrores` y el `onError`) a la vuelta
// de la central a un instante (`POST /v1/admin/central/volver`) en cada desenlace que el CLI tiene
// que saber leer: la vuelta hecha; la que ha vuelto pero no atiende, que sale como 503 `external` por
// `completarErrores`; la que no se ha aplicado; la llamada al objeto que no vuelve (el 500 del
// `onError`); la que no se hace porque la copia de antes no llega a R2; y los dos rechazos del token.
// Y otra orden con la central sin atender (copiar), que es el 503 `external` sin nada que deshacer; el
// estado de una central con la vuelta preparada y sin aplicar, del que el CLI saca la orden que la
// aplica; aplicarla con esa orden (`reiniciar`), y otra vez, ya aplicada; la lista de las copias con
// las de una vuelta (su marcador y cuándo se pidió); y una restauración con una copia que no existe y
// otra cuya llamada no vuelve.
//
// Queda escrito en `scripts/tpv-license.respuestas.json`, que es lo que sirve el worker de mentira de
// `scripts/tpv-license.test.mjs`: así el CLI se prueba con la respuesta de verdad, y si la ruta o la
// clasificación de los errores cambian, esto falla. Un cambio a propósito se regenera con
// `pnpm --filter tpv-api exec vitest run test/centralVueltaEnElCli.test.ts -u`, y el test del CLI
// (`node --test scripts/tpv-license.test.mjs`) dice si sigue enseñando con qué salir.
//
// Lo que cambia de una vez a otra va fijo: las horas (en ISO, en milisegundos y en la clave de la
// copia de antes), el hash de cada migración, lo que ocupa la base y el id de la marca de la vuelta.
// Los marcadores son los del doble de la plataforma.

import { env, runInDurableObject } from "cloudflare:test";
import { expect, it, vi } from "vitest";

import { app } from "../src/app";
import { CLAVE_RESTAURACION_EN_CURSO, CLAVE_VUELTA_EN_CURSO } from "../src/durableObjects/baseCentral.guardas";
import {
	centralDePrueba,
	centralInterceptada,
	centralSinAprovisionar,
	conDobleDeInstantes,
	conR2Caido,
	MARCADORES,
	type CentralDePrueba,
} from "./helpers/central";

const TOKEN = "token-de-pruebas";

type Respuesta = { status: number; cuerpo: unknown };

/** Una ruta de `/v1/admin/central`, por la aplicación entera, con el token `token`. */
async function pedir(
	metodo: "GET" | "POST",
	ruta: string,
	entorno: Record<string, unknown>,
	cuerpo?: unknown,
	token: string = TOKEN,
): Promise<Respuesta> {
	const res = await app.request(
		new Request(`https://api/v1/admin/central${ruta}`, {
			method: metodo,
			headers: { authorization: `Bearer ${token}`, ...(cuerpo === undefined ? {} : { "content-type": "application/json" }) },
			...(cuerpo === undefined ? {} : { body: JSON.stringify(cuerpo) }),
		}),
		undefined,
		entorno,
	);
	return { status: res.status, cuerpo: await res.json() };
}

/** La vuelta a un instante de hace una hora (el doble de la plataforma da siempre el mismo marcador). */
const volver = (entorno: Record<string, unknown>, token?: string) =>
	pedir("POST", "/volver", entorno, { instanteMs: Date.now() - 3_600_000 }, token);

const entornoCon = (central: Pick<CentralDePrueba, "entorno">) => ({ ...(env as any), ADMIN_API_TOKEN: TOKEN, ...central.entorno });

/** Lo que cambia de una vez a otra, fijo (ver la cabecera). */
function fijo(respuesta: Respuesta): Respuesta {
	return JSON.parse(JSON.stringify(respuesta), (clave, valor) => {
		if (clave === "aplicadaMs" || clave === "desdeMs") return 1_764_036_000_000;
		if (clave === "hash") return "‹el hash de la migración›";
		if (clave === "bytes") return 32_768;
		if (clave === "id") return "00000000-0000-4000-8000-000000000000";
		if (typeof valor === "string") {
			return valor
				.replace(/antes-de-volver-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z/g, "antes-de-volver-2026-11-25T02-00-00.000Z")
				.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g, "2026-11-25T01:00:00.000Z");
		}
		return valor;
	});
}

it("lo que contesta la aplicación a la vuelta, en cada desenlace, es lo que sirve el worker de mentira del CLI", async () => {
	// Lo que dejan en el log y en Sentry la llamada que no vuelve y el rastro: aquí no se mira.
	vi.spyOn(console, "log").mockImplementation(() => {});
	vi.spyOn(console, "error").mockImplementation(() => {});

	const hecha = await centralDePrueba();
	await conDobleDeInstantes(hecha, []);

	const sinAtender = await centralDePrueba();
	// Vuelve a un instante de en medio de una restauración desde una copia: con su marca.
	await conDobleDeInstantes(sinAtender, [], {
		alReiniciar: (state) => {
			state.storage.kv.delete(CLAVE_VUELTA_EN_CURSO);
			state.storage.kv.put(CLAVE_RESTAURACION_EN_CURSO, { clave: "base-central/2026-11-24.sql.gz", desdeMs: 1 });
		},
	});

	const sinAplicar = await centralDePrueba();
	await conDobleDeInstantes(sinAplicar, [], { alReiniciar: () => {} });

	// La llamada que prepara la vuelta no vuelve: el objeto se ha reiniciado a mitad.
	const sinRespuesta = centralInterceptada(await centralDePrueba(), (metodo, _a, llamar) =>
		metodo === "prepararVuelta" ? Promise.reject(new Error("el objeto se ha reiniciado")) : llamar(),
	);

	const sinCopia = await centralDePrueba();
	await conDobleDeInstantes(sinCopia, []);
	await conR2Caido(sinCopia);

	// Otra orden con la central sin atender: el 503 `external` que no trae con qué deshacer nada.
	const aMedias = await centralDePrueba();
	await runInDurableObject(env.BaseCentral.get(aMedias.stub.id), (_o, state) =>
		state.storage.kv.put(CLAVE_RESTAURACION_EN_CURSO, { clave: "base-central/2026-11-24.sql.gz", desdeMs: 1 }),
	);

	// Restaurar: una copia que no existe (lo dice la ruta), y la llamada que no vuelve (pasa de 30 s y
	// el objeto se reinicia a mitad).
	const sinRestaurar = centralSinAprovisionar();
	const restaurandoSinRespuesta = centralInterceptada(centralSinAprovisionar(), (metodo, _a, llamar) =>
		metodo === "aprovisionar" ? Promise.reject(new Error("el objeto se ha reiniciado")) : llamar(),
	);
	const conLaCopia = { claveDeCopia: "base-central/2026-11-24.sql.gz" };

	const { ADMIN_API_TOKEN: _, ...sinElTokenDelWorker } = entornoCon(hecha);

	/** Aplica la vuelta que quedó sin aplicar en `central`, ahora que el reinicio sí llega. */
	async function aplicarLaPreparada(central: CentralDePrueba): Promise<Respuesta> {
		await conDobleDeInstantes(central, []);
		return pedir("POST", "/volver", entornoCon(central), { reiniciar: MARCADORES.actual });
	}

	/** La lista de las copias, con sólo las filas de la vuelta que contestó `r`: en el bucket están las de todas. */
	async function copiasDeLaVuelta(r: Respuesta): Promise<Respuesta> {
		const deLaVuelta = String((r.cuerpo as { copiaDeAntes: string }).copiaDeAntes).replace(/\.sql\.gz$/, "");
		const lista = await pedir("GET", "/copias", entornoCon(hecha));
		const cuerpo = lista.cuerpo as { copias: { clave: string }[] };
		return { ...lista, cuerpo: { ...cuerpo, copias: cuerpo.copias.filter((c) => c.clave.startsWith(deLaVuelta)) } };
	}

	const vueltaHecha = await volver(entornoCon(hecha));
	const respuestas = {
		"//":
			"Lo que contesta la aplicación entera a la vuelta de la central a un instante (y a copiar, restaurar y " +
			"pedir el estado) en cada desenlace que el CLI tiene que saber leer. Lo escribe " +
			"apps/cloud-worker-licensing/test/centralVueltaEnElCli.test.ts (con -u) y lo sirve el worker de mentira " +
			"de scripts/tpv-license.test.mjs. No se edita a mano.",
		"vuelta-hecha": vueltaHecha,
		"copias-tras-la-vuelta": await copiasDeLaVuelta(vueltaHecha),
		"vuelta-que-no-atiende": await volver(entornoCon(sinAtender)),
		"vuelta-sin-aplicar": await volver(entornoCon(sinAplicar)),
		"estado-con-la-vuelta-sin-aplicar": await pedir("GET", "/estado", entornoCon(sinAplicar)),
		"aplicar-la-preparada": await aplicarLaPreparada(sinAplicar),
		"aplicar-ya-aplicada": await pedir("POST", "/volver", entornoCon(sinAplicar), { reiniciar: MARCADORES.actual }),
		"vuelta-sin-respuesta": await volver(entornoCon(sinRespuesta)),
		"vuelta-sin-copia-de-antes": await volver(entornoCon(sinCopia)),
		"token-rechazado": await volver(entornoCon(hecha), "otro-token"),
		"sin-token-en-el-worker": await volver(sinElTokenDelWorker),
		"copiar-a-medias": await pedir("POST", "/copiar-ahora", entornoCon(aMedias)),
		"restaurar-sin-copia": await pedir("POST", "/aprovisionar", entornoCon(sinRestaurar), conLaCopia),
		"restaurar-sin-respuesta": await pedir("POST", "/aprovisionar", entornoCon(restaurandoSinRespuesta), conLaCopia),
	};

	// Lo que el CLI tiene que leer bien, dicho aquí también: si cambia, cambia a propósito.
	expect(respuestas).toMatchObject({
		"vuelta-hecha": { status: 200, cuerpo: { ok: true, deshacer: expect.any(String) } },
		"copias-tras-la-vuelta": {
			status: 200,
			cuerpo: { ok: true, copias: [{ marcador: expect.any(String), pedida: expect.any(String) }] },
		},
		"vuelta-que-no-atiende": {
			status: 503,
			cuerpo: { ok: false, code: "external", error: "central_restauracion_a_medias", deshacer: expect.any(String) },
		},
		"vuelta-sin-aplicar": { status: 503, cuerpo: { ok: false, error: "central_vuelta_sin_aplicar", deshacer: expect.any(String) } },
		"estado-con-la-vuelta-sin-aplicar": {
			status: 200,
			cuerpo: { ok: true, enCurso: { vuelta: { fase: "preparada", preparada: { deshacer: expect.any(String) } } } },
		},
		"aplicar-la-preparada": { status: 200, cuerpo: { ok: true, deshacer: expect.any(String), estado: { enCurso: { vuelta: null } } } },
		"aplicar-ya-aplicada": { status: 409, cuerpo: { ok: false, error: "central_sin_vuelta_preparada" } },
		"vuelta-sin-respuesta": { status: 500, cuerpo: { ok: false, error: "internal_error" } },
		"vuelta-sin-copia-de-antes": { status: 500, cuerpo: { ok: false, error: "central_copia_fallida" } },
		"token-rechazado": { status: 401 },
		"sin-token-en-el-worker": { status: 503, cuerpo: { error: "admin_disabled" } },
		"copiar-a-medias": { status: 503, cuerpo: { ok: false, code: "external", error: "central_restauracion_a_medias" } },
		"restaurar-sin-copia": { status: 422, cuerpo: { ok: false, error: "central_copia_inservible" } },
		"restaurar-sin-respuesta": { status: 500, cuerpo: { ok: false, error: "internal_error" } },
	});
	expect(respuestas["copiar-a-medias"].cuerpo).not.toHaveProperty("deshacer");
	const fijas = Object.fromEntries(
		Object.entries(respuestas).map(([nombre, r]) => [nombre, typeof r === "string" ? r : fijo(r)]),
	);
	await expect(`${JSON.stringify(fijas, null, 2)}\n`).toMatchFileSnapshot("../../../scripts/tpv-license.respuestas.json");
});
