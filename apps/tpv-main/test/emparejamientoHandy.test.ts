// apps/tpv-main/test/emparejamientoHandy.test.ts
//
// El emparejamiento de un Handy con su Main: reclamarlo con la identidad del equipo, esperar a que la
// Main lo apruebe y guardar el token. Es el único camino por el que un Handy empieza a trabajar, y
// sus fallos no se ven hasta que alguien intenta vincular uno con el cliente delante.
//
// Se prueba con dobles del IPC y de la nube y el reloj de Vitest, así que los minutos de espera
// pasan en milisegundos.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	cancelarEmparejamiento,
	emparejarHandy,
	ESPERA_ENTRE_CONSULTAS_MS,
	ESPERA_SI_LA_NUBE_NO_LO_DICE_MS,
	type DependenciasEmparejamiento,
} from "../src/app/arranque/emparejamiento";

const CLAVE = "P".repeat(44);
const CODIGO = { pairCode: "123456", pairSecret: "s3cr3t" };
/** Lo que le queda al código según la nube, en los dobles. */
const CADUCA_EN_MS = 30_000;
/** Lo que tarda en volver la respuesta al claim: lo que el código caduca antes en la nube. */
const LATENCIA_MS = 50;
const CODIGO_CADUCADO_EN_LA_NUBE = "El código de vinculación ha caducado. Genera uno nuevo en el TPV principal.";

/** Un IPC y una nube en memoria. La Main aprueba tras `pendientesAntesDeAprobar` consultas. */
function crearDobles() {
	const estado = {
		identidad: { deviceId: "h1", devicePubkeyB64: CLAVE },
		respuestaClaim: { nonceB64: "bm9uY2U=", nonceExpiresAtMs: 999, caducaEnMs: CADUCA_EN_MS } as Record<string, unknown>,
		respuestaToken: { tenantId: "t1", token: "jwt" } as Record<string, unknown>,
		pendientesAntesDeAprobar: 2,
		errorAlConsultar: null as unknown,
		/** EMPAREJAR-ESPERA: lo que contestan las primeras consultas, una cada una, antes que lo demás. */
		fallosPasajeros: [] as unknown[],
		consultas: [] as Record<string, unknown>[],
		/** Cuándo llegó cada consulta, en el reloj de Vitest. */
		horasDeConsulta: [] as number[],
		/** Lo que la espera ha ido diciendo de las consultas que fallan (`null`: la nube vuelve a contestar). */
		avisos: [] as (string | null)[],
		claims: [] as Record<string, unknown>[],
		cancelaciones: [] as Record<string, unknown>[],
			/** Se ejecuta justo antes de contestar a una consulta: sirve para cancelar «mientras vuelve». */
		antesDeContestar: null as null | (() => void),
		tokenGuardado: null as unknown,
		/** PROD-04: la hora de la nube que da Rust para firmar; `null` = no contesta. */
		horaNube: null as number | null,
		pendiente: null as unknown,
		vivo: true,
		/**
		 * EMPAREJAR-ESPERA: desde cuándo la nube contesta que el código ha caducado. La nube calcula
		 * `caducaEnMs` antes de contestar al claim, así que el código caduca allí un poco antes de lo
		 * que la Handy apunta: la latencia. `null`: no caduca en la nube durante la prueba.
		 */
		caducaEnLaNube: null as number | null,
	};
	const deps: DependenciasEmparejamiento = {
		commands: {
            deviceGetIdentity: async () => estado.identidad,
            deviceFirmarEmparejamiento: async (args) => {
                const ts = estado.horaNube ?? Date.now();
                return { ts, sigB64: `firma:${ts}\n${args.accion}\n${args.pair_code}\n${args.nonce_b64}\nh1` };
            },
            handySetToken: async (args) => { estado.tokenGuardado = args; return "OK"; },
        },
		pedirALaNube: (async (ruta: string, cuerpo: Record<string, unknown>) => {
			if (ruta === "/v1/pair/claim") {
				estado.claims.push(cuerpo);
				return estado.respuestaClaim;
			}
			if (ruta === "/v1/pair/fetch-token") {
				estado.consultas.push(cuerpo);
				estado.horasDeConsulta.push(Date.now());
				if (estado.caducaEnLaNube !== null && Date.now() > estado.caducaEnLaNube) {
					throw { code: "pair_code_expired", message: CODIGO_CADUCADO_EN_LA_NUBE };
				}
				if (estado.fallosPasajeros.length > 0) throw estado.fallosPasajeros.shift();
				if (estado.errorAlConsultar) throw estado.errorAlConsultar;
				if (estado.consultas.length <= estado.pendientesAntesDeAprobar) {
					throw { code: "not_approved", message: "Emparejamiento pendiente de aprobación" };
				}
				estado.antesDeContestar?.();
				return estado.respuestaToken;
			}
			if (ruta === "/v1/pair/cancel") {
				estado.cancelaciones.push(cuerpo);
				return { ok: true, liberado: true };
			}
			throw new Error(`ruta inesperada ${ruta}`);
		}) as DependenciasEmparejamiento["pedirALaNube"],
		sigueVivo: () => estado.vivo,
		alQuedarPendiente: (p) => {
			estado.pendiente = p;
		},
		alCambiarElAviso: (aviso) => {
			estado.avisos.push(aviso);
		},
	};
	return { estado, deps };
}

/** Arranca el emparejamiento sin esperarlo, y deja el rechazo capturado para inspeccionarlo. */
function arrancar(deps: DependenciasEmparejamiento) {
	const promesa = emparejarHandy(CODIGO, deps);
	const resultado = promesa.then(
		(valor) => ({ valor, error: null as unknown }),
		(error: unknown) => ({ valor: undefined, error }),
	);
	return resultado;
}

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
});

afterEach(() => {
	vi.useRealTimers();
});

describe("emparejar un Handy", () => {
	it("reclama con la identidad del equipo, espera la aprobación y guarda el token", async () => {
		const { estado, deps } = crearDobles();
		const resultado = arrancar(deps);
		await vi.advanceTimersByTimeAsync(ESPERA_ENTRE_CONSULTAS_MS * 3);

		expect(await resultado).toEqual({ valor: { tenantId: "t1", token: "jwt", deviceId: "h1" }, error: null });
		expect(estado.claims).toEqual([
			{ pairCode: "123456", pairSecret: "s3cr3t", deviceId: "h1", devicePubKey: CLAVE, deviceName: "" },
		]);
		expect(estado.pendiente).toEqual({ pairCode: "123456", pairSecret: "s3cr3t", nonceB64: "bm9uY2U=", nonceExpiresAtMs: 999 });
		expect(estado.consultas).toHaveLength(3);
		expect(estado.tokenGuardado).toEqual({ token: "jwt", tenant_id: "t1" });
	});

	it("cada consulta va firmada con el reto del claim, la hora y el equipo", async () => {
		const { estado, deps } = crearDobles();
		estado.pendientesAntesDeAprobar = 0;
		const resultado = arrancar(deps);
		await vi.advanceTimersByTimeAsync(ESPERA_ENTRE_CONSULTAS_MS);
		await resultado;

		const [consulta] = estado.consultas as { ts: number }[];
		expect(consulta).toEqual({
			pairCode: "123456",
			deviceId: "h1",
			nonceB64: "bm9uY2U=",
			ts: consulta.ts,
			sigB64: `firma:${consulta.ts}\nPAIR_FETCH\n123456\nbm9uY2U=\nh1`,
		});
	});

	// PROD-04: una Handy con el reloj desfasado más de 2 minutos no se vinculaba nunca, porque la
	// nube rechaza la firma (`timestamp_out_of_range`). La hora sale de Rust, que la tiene del claim.
	it("la hora de la firma es la de la nube, no la del equipo", async () => {
		const { estado, deps } = crearDobles();
		estado.pendientesAntesDeAprobar = 0;
		estado.horaNube = Date.now() + 10 * 60_000;
		const resultado = arrancar(deps);
		await vi.advanceTimersByTimeAsync(ESPERA_ENTRE_CONSULTAS_MS);
		await resultado;

		const [consulta] = estado.consultas as { ts: number; sigB64: string }[];
		expect(consulta.ts).toBe(estado.horaNube);
		expect(consulta.sigB64).toBe(`firma:${estado.horaNube}
PAIR_FETCH
123456
bm9uY2U=
h1`);
	});

	it("pregunta cada 1,5 s, no antes", async () => {
		const { estado, deps } = crearDobles();
		estado.pendientesAntesDeAprobar = Number.POSITIVE_INFINITY;
		void arrancar(deps);
		await vi.advanceTimersByTimeAsync(ESPERA_ENTRE_CONSULTAS_MS - 1);
		expect(estado.consultas).toHaveLength(0);
		await vi.advanceTimersByTimeAsync(1);
		expect(estado.consultas).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(ESPERA_ENTRE_CONSULTAS_MS);
		expect(estado.consultas).toHaveLength(2);
		estado.vivo = false;
		await vi.advanceTimersByTimeAsync(ESPERA_ENTRE_CONSULTAS_MS);
	});

	it("el rechazo de la Main y lo que no va a cambiar cortan en el acto y no guardan nada", async () => {
		for (const code of ["pair_rejected", "conflict", "not_found", "validation", "device_revoked"]) {
			const { estado, deps } = crearDobles();
			estado.errorAlConsultar = { code, message: `fallo ${code}` };
			const resultado = arrancar(deps);
			await vi.advanceTimersByTimeAsync(ESPERA_ENTRE_CONSULTAS_MS * 5);

			expect((await resultado).error, code).toEqual(estado.errorAlConsultar);
			expect(estado.consultas, code).toHaveLength(1);
			expect(estado.tokenGuardado, code).toBeNull();
		}
	});

	// EMPAREJAR-ESPERA: un 503 de la central o del worker, un 429 del filtro por IP o un corte de red
	// terminaban la espera, y quien vinculaba tenía que volver a pulsar «Vincular» con la Main
	// esperando a aprobar.
	it("un fallo pasajero (la red, un 503, un 429, un 5xx) no corta la espera, y la aprobación entra", async () => {
		const { estado, deps } = crearDobles();
		estado.fallosPasajeros = [
			{ code: "external", message: "La nube está atendiendo demasiadas peticiones. Espera unos segundos y vuelve a intentarlo." },
			{ code: "external", message: "Demasiadas peticiones desde esta red. Vuelve a intentarlo dentro de 1 minuto." },
			{ code: "internal", message: "Error interno" },
			{ code: "main_offline", message: "No hay ningún TPV principal conectado" },
		];
		// Las cuatro consultas que fallan cuentan: la quinta ya trae el token.
		estado.pendientesAntesDeAprobar = 4;
		const resultado = arrancar(deps);
		await vi.advanceTimersByTimeAsync(CADUCA_EN_MS);

		expect(await resultado).toEqual({ valor: { tenantId: "t1", token: "jwt", deviceId: "h1" }, error: null });
		expect(estado.consultas).toHaveLength(5);
		expect(estado.tokenGuardado).toEqual({ token: "jwt", tenant_id: "t1" });
	});

	it("mientras la nube falla, espacia las consultas; en cuanto contesta, vuelve a cada 1,5 s", async () => {
		const { estado, deps } = crearDobles();
		const pasajero = { code: "external", message: "sin red" };
		estado.fallosPasajeros = [pasajero, pasajero, pasajero];
		estado.pendientesAntesDeAprobar = Number.POSITIVE_INFINITY;
		const inicio = Date.now();
		void arrancar(deps);
		await vi.advanceTimersByTimeAsync(CADUCA_EN_MS - ESPERA_ENTRE_CONSULTAS_MS);

		const entre = estado.horasDeConsulta.map((h, i) => h - (i === 0 ? inicio : estado.horasDeConsulta[i - 1]!));
		const B = ESPERA_ENTRE_CONSULTAS_MS;
		expect(entre.slice(0, 5)).toEqual([B, 2 * B, 4 * B, 8 * B, B]);
		estado.vivo = false;
		await vi.advanceTimersByTimeAsync(CADUCA_EN_MS);
	});

	it("dice que la nube no contesta mientras falla, y lo retira cuando vuelve a contestar", async () => {
		const { estado, deps } = crearDobles();
		estado.fallosPasajeros = [{ code: "external", message: "No se ha podido conectar con el servidor." }];
		estado.pendientesAntesDeAprobar = 2;
		const resultado = arrancar(deps);
		await vi.advanceTimersByTimeAsync(CADUCA_EN_MS);

		expect((await resultado).valor).toBeTruthy();
		expect(estado.avisos[0]).toContain("No se ha podido conectar con el servidor.");
		expect(estado.avisos[0]).toContain("Se sigue esperando");
		expect(estado.avisos[estado.avisos.length - 1]).toBeNull();
	});

	it("si el código caduca con la nube sin contestar, lo dice, y el código se da por caducado", async () => {
		const { estado, deps } = crearDobles();
		estado.errorAlConsultar = { code: "external", message: "No se ha podido conectar con el servidor." };
		const resultado = arrancar(deps);
		await vi.advanceTimersByTimeAsync(CADUCA_EN_MS + 20 * ESPERA_ENTRE_CONSULTAS_MS);

		const { error } = await resultado;
		expect(error).toMatchObject({ code: "pair_code_expired" });
		expect((error as Error).message).toContain("la nube no contestaba");
		expect((error as Error).message).toContain("No se ha podido conectar con el servidor.");
		expect(estado.tokenGuardado).toBeNull();
	});

	// EMPAREJAR-ESPERA: la última consulta llega siempre un poco después de que el código caduque en
	// la nube. Lo que contestaba entonces era un fallo pasajero para la Handy, y la espera de una Main
	// que no aprobaba acababa diciendo que la nube no contestaba, con dos instrucciones contradictorias.
	it("la Main que no aprueba: la nube dice que el código ha caducado, y la espera dice que la Main no aprobó", async () => {
		const { estado, deps } = crearDobles();
		estado.pendientesAntesDeAprobar = Number.POSITIVE_INFINITY;
		estado.caducaEnLaNube = Date.now() + CADUCA_EN_MS - LATENCIA_MS;
		const resultado = arrancar(deps);
		await vi.advanceTimersByTimeAsync(CADUCA_EN_MS + 5 * ESPERA_ENTRE_CONSULTAS_MS);

		const { error } = await resultado;
		expect(error).toMatchObject({ code: "pair_code_expired" });
		expect((error as Error).message).toContain("sin que el TPV principal aprobara");
		expect((error as Error).message).not.toContain("la nube no contestaba");
		expect(estado.avisos).toEqual([]);
		expect(estado.tokenGuardado).toBeNull();
	});

	it("si la nube falla y luego dice que el código ha caducado, la espera dice que la nube no contestaba", async () => {
		const { estado, deps } = crearDobles();
		estado.errorAlConsultar = { code: "external", message: "No se ha podido conectar con el servidor." };
		estado.caducaEnLaNube = Date.now() + CADUCA_EN_MS - LATENCIA_MS;
		const resultado = arrancar(deps);
		await vi.advanceTimersByTimeAsync(CADUCA_EN_MS + 20 * ESPERA_ENTRE_CONSULTAS_MS);

		const { error } = await resultado;
		expect(error).toMatchObject({ code: "pair_code_expired" });
		expect((error as Error).message).toContain("la nube no contestaba");
		expect((error as Error).message).toContain("No se ha podido conectar con el servidor.");
	});

	it("el código que la nube da por caducado en la primera consulta corta en el acto", async () => {
		const { estado, deps } = crearDobles();
		estado.caducaEnLaNube = Date.now();
		const resultado = arrancar(deps);
		await vi.advanceTimersByTimeAsync(ESPERA_ENTRE_CONSULTAS_MS * 5);

		const { error } = await resultado;
		expect(error).toMatchObject({ code: "pair_code_expired" });
		expect((error as Error).message).toContain("sin que el TPV principal aprobara");
		expect(estado.consultas).toHaveLength(1);
		expect(estado.tokenGuardado).toBeNull();
	});

	it("espera lo que la nube dice que le queda al código, y entonces se rinde", async () => {
		// Antes era una constante de 3 minutos contra un reto que caducaba a los 2: si la Main
		// aprobaba en el tercer minuto, la Handy fallaba igual.
		const { estado, deps } = crearDobles();
		estado.pendientesAntesDeAprobar = Number.POSITIVE_INFINITY;
		const resultado = arrancar(deps);
		await vi.advanceTimersByTimeAsync(CADUCA_EN_MS + ESPERA_ENTRE_CONSULTAS_MS);

		const { error } = await resultado;
		expect(error).toBeInstanceOf(Error);
		// Lo mismo que si la nube contestara que el código ha caducado: la pantalla lo da por gastado.
		expect(error).toMatchObject({ code: "pair_code_expired" });
		expect((error as Error).message).toContain("caducado");
		expect(estado.consultas.length).toBe(CADUCA_EN_MS / ESPERA_ENTRE_CONSULTAS_MS);
		expect(estado.tokenGuardado).toBeNull();
	});

	it("una aprobación en el último tramo del plazo todavía entra", async () => {
		const { estado, deps } = crearDobles();
		estado.pendientesAntesDeAprobar = CADUCA_EN_MS / ESPERA_ENTRE_CONSULTAS_MS - 1;
		const resultado = arrancar(deps);
		await vi.advanceTimersByTimeAsync(CADUCA_EN_MS);

		expect((await resultado).valor).toEqual({ tenantId: "t1", token: "jwt", deviceId: "h1" });
	});

	it("si la nube no dice cuánto le queda al código, espera dos minutos", async () => {
		const { estado, deps } = crearDobles();
		estado.respuestaClaim = { nonceB64: "bm9uY2U=", nonceExpiresAtMs: 999 };
		estado.pendientesAntesDeAprobar = Number.POSITIVE_INFINITY;
		const resultado = arrancar(deps);
		await vi.advanceTimersByTimeAsync(ESPERA_SI_LA_NUBE_NO_LO_DICE_MS + ESPERA_ENTRE_CONSULTAS_MS);

		expect((await resultado).error).toBeInstanceOf(Error);
		expect(estado.consultas.length).toBe(ESPERA_SI_LA_NUBE_NO_LO_DICE_MS / ESPERA_ENTRE_CONSULTAS_MS);
	});

	it("cancelar mientras vuelve la aprobación no deja el token guardado a escondidas", async () => {
		const { estado, deps } = crearDobles();
		estado.pendientesAntesDeAprobar = 0;
		estado.antesDeContestar = () => {
			estado.vivo = false;
		};
		const resultado = arrancar(deps);
		await vi.advanceTimersByTimeAsync(ESPERA_ENTRE_CONSULTAS_MS);

		expect(await resultado).toEqual({ valor: null, error: null });
		expect(estado.tokenGuardado).toBeNull();
	});

	it("cancelar suelta el código en la nube, firmado con el reto y marcado como cancelación", async () => {
		const { estado, deps } = crearDobles();
		await cancelarEmparejamiento(
			{ pairCode: "123456", nonceB64: "bm9uY2U=" },
			deps,
		);

		const [cancelacion] = estado.cancelaciones as { ts: number }[];
		expect(cancelacion).toEqual({
			pairCode: "123456",
			deviceId: "h1",
			nonceB64: "bm9uY2U=",
			ts: cancelacion.ts,
			// La acción va dentro de lo firmado: la firma de una consulta no puede servir para cancelar.
			sigB64: `firma:${cancelacion.ts}
PAIR_CANCEL
123456
bm9uY2U=
h1`,
		});
	});

	it("si la pantalla se va mientras espera, deja de preguntar y no guarda nada", async () => {
		const { estado, deps } = crearDobles();
		estado.pendientesAntesDeAprobar = Number.POSITIVE_INFINITY;
		const resultado = arrancar(deps);
		await vi.advanceTimersByTimeAsync(ESPERA_ENTRE_CONSULTAS_MS * 2);
		estado.vivo = false;
		await vi.advanceTimersByTimeAsync(CADUCA_EN_MS);

		expect(await resultado).toEqual({ valor: null, error: null });
		expect(estado.consultas).toHaveLength(2);
		expect(estado.tokenGuardado).toBeNull();
	});

	it("una identidad incompleta no llega a reclamar", async () => {
		for (const identidad of [{ deviceId: "", devicePubkeyB64: CLAVE }, { deviceId: "h1", devicePubkeyB64: "corta" }]) {
			const { estado, deps } = crearDobles();
			estado.identidad = identidad;
			const resultado = await arrancar(deps);
			expect(resultado.error, JSON.stringify(identidad)).toBeInstanceOf(Error);
			expect(estado.claims).toHaveLength(0);
		}
	});

	it("un claim sin reto, o un token sin tenant, no se dan por buenos", async () => {
		{
			const { estado, deps } = crearDobles();
			estado.respuestaClaim = {};
			const resultado = await arrancar(deps);
			expect(resultado.error).toBeInstanceOf(Error);
			expect(estado.pendiente).toBeNull();
		}
		{
			const { estado, deps } = crearDobles();
			estado.pendientesAntesDeAprobar = 0;
			estado.respuestaToken = { token: "jwt" };
			const resultado = arrancar(deps);
			await vi.advanceTimersByTimeAsync(ESPERA_ENTRE_CONSULTAS_MS);
			expect((await resultado).error).toBeInstanceOf(Error);
			expect(estado.tokenGuardado).toBeNull();
		}
	});

	it("sus propios fallos los explica con una frase, no con un código interno", async () => {
		// Lo que se lanza aquí acaba tal cual en la pantalla de vinculación, delante del camarero.
		const codigoInterno = /\b[a-z]+_[a-z0-9_]+\b/;
		const mensajes: string[] = [];

		{
			const { estado, deps } = crearDobles();
			estado.pendientesAntesDeAprobar = Number.POSITIVE_INFINITY;
			const resultado = arrancar(deps);
			await vi.advanceTimersByTimeAsync(CADUCA_EN_MS + ESPERA_ENTRE_CONSULTAS_MS);
			mensajes.push(((await resultado).error as Error).message);
		}
		{
			const { estado, deps } = crearDobles();
			estado.identidad = { deviceId: "", devicePubkeyB64: CLAVE };
			mensajes.push(((await arrancar(deps)).error as Error).message);
		}
		{
			const { estado, deps } = crearDobles();
			estado.respuestaClaim = {};
			mensajes.push(((await arrancar(deps)).error as Error).message);
		}
		{
			const { estado, deps } = crearDobles();
			estado.pendientesAntesDeAprobar = 0;
			estado.respuestaToken = { token: "jwt" };
			const resultado = arrancar(deps);
			await vi.advanceTimersByTimeAsync(ESPERA_ENTRE_CONSULTAS_MS);
			mensajes.push(((await resultado).error as Error).message);
		}

		for (const mensaje of mensajes) {
			expect(mensaje, mensaje).not.toMatch(codigoInterno);
			expect(mensaje.length, mensaje).toBeGreaterThan(20);
		}
		// El de la espera dice qué hacer: aprobarla en la Main.
		expect(mensajes[0]).toContain("TPV principal");
	});

	it("acepta el contrato del IPC y del proxy de emparejamiento", async () => {
		const { estado, deps } = crearDobles();
		estado.identidad = { deviceId: "h1", devicePubkeyB64: CLAVE };
		estado.respuestaClaim = { nonce_b64: "bm9uY2U=", nonce_expires_at_ms: 999, caducaEnMs: CADUCA_EN_MS };
		estado.respuestaToken = { tenant_id: "t1", token: "jwt" };
		estado.pendientesAntesDeAprobar = 0;
		const resultado = arrancar(deps);
		await vi.advanceTimersByTimeAsync(ESPERA_ENTRE_CONSULTAS_MS);

		expect((await resultado).valor).toEqual({ tenantId: "t1", token: "jwt", deviceId: "h1" });
	});
});
