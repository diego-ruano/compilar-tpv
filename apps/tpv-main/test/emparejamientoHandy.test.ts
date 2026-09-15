// apps/tpv-main/test/emparejamientoHandy.test.ts
//
// El emparejamiento de un Handy con su Main: reclamarlo con la identidad del equipo, esperar a que la
// Main lo apruebe y guardar el token. Es el único camino por el que un Handy empieza a trabajar, y
// sus fallos no se ven hasta que alguien intenta vincular uno con el cliente delante.
//
// Se prueba con dobles del IPC y de la nube y el reloj de Vitest, así que los tres minutos de espera
// pasan en milisegundos.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	emparejarHandy,
	ESPERA_ENTRE_CONSULTAS_MS,
	ESPERA_MAXIMA_APROBACION_MS,
	type DependenciasEmparejamiento,
} from "../src/app/arranque/emparejamiento";

const CLAVE = "P".repeat(44);
const CODIGO = { pairCode: "123456", pairSecret: "s3cr3t" };

/** Un IPC y una nube en memoria. La Main aprueba tras `pendientesAntesDeAprobar` consultas. */
function crearDobles() {
	const estado = {
		identidad: { deviceId: "h1", devicePubkeyB64: CLAVE } as Record<string, unknown>,
		respuestaClaim: { nonceB64: "bm9uY2U=", nonceExpiresAtMs: 999 } as Record<string, unknown>,
		respuestaToken: { tenantId: "t1", token: "jwt" } as Record<string, unknown>,
		pendientesAntesDeAprobar: 2,
		errorAlConsultar: null as unknown,
		consultas: [] as Record<string, unknown>[],
		claims: [] as Record<string, unknown>[],
		tokenGuardado: null as unknown,
		pendiente: null as unknown,
		vivo: true,
	};
	const deps: DependenciasEmparejamiento = {
		invoke: (async (comando: string, args?: Record<string, any>) => {
			if (comando === "device_get_identity") return estado.identidad;
			if (comando === "device_sign_b64") return { sigB64: `firma:${args?.args.payload}` };
			if (comando === "handy_set_token") {
				estado.tokenGuardado = args?.args;
				return null;
			}
			throw new Error(`comando inesperado ${comando}`);
		}) as DependenciasEmparejamiento["invoke"],
		pedirALaNube: (async (ruta: string, cuerpo: Record<string, unknown>) => {
			if (ruta === "/v1/pair/claim") {
				estado.claims.push(cuerpo);
				return estado.respuestaClaim;
			}
			if (ruta === "/v1/pair/fetch-token") {
				estado.consultas.push(cuerpo);
				if (estado.errorAlConsultar) throw estado.errorAlConsultar;
				if (estado.consultas.length <= estado.pendientesAntesDeAprobar) {
					throw { code: "not_approved", message: "Emparejamiento pendiente de aprobación" };
				}
				return estado.respuestaToken;
			}
			throw new Error(`ruta inesperada ${ruta}`);
		}) as DependenciasEmparejamiento["pedirALaNube"],
		sigueVivo: () => estado.vivo,
		alQuedarPendiente: (p) => {
			estado.pendiente = p;
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

	it("un error que no es «pendiente de aprobación» corta en el acto y no guarda nada", async () => {
		const { estado, deps } = crearDobles();
		estado.errorAlConsultar = { code: "external", message: "El código de vinculación ha caducado" };
		const resultado = arrancar(deps);
		await vi.advanceTimersByTimeAsync(ESPERA_ENTRE_CONSULTAS_MS * 5);

		expect((await resultado).error).toEqual(estado.errorAlConsultar);
		expect(estado.consultas).toHaveLength(1);
		expect(estado.tokenGuardado).toBeNull();
	});

	it("sin aprobación en tres minutos, se rinde", async () => {
		const { estado, deps } = crearDobles();
		estado.pendientesAntesDeAprobar = Number.POSITIVE_INFINITY;
		const resultado = arrancar(deps);
		await vi.advanceTimersByTimeAsync(ESPERA_MAXIMA_APROBACION_MS + ESPERA_ENTRE_CONSULTAS_MS);

		expect((await resultado).error).toBeInstanceOf(Error);
		expect(estado.consultas.length).toBe(ESPERA_MAXIMA_APROBACION_MS / ESPERA_ENTRE_CONSULTAS_MS);
		expect(estado.tokenGuardado).toBeNull();
	});

	it("si la pantalla se va mientras espera, deja de preguntar y no guarda nada", async () => {
		const { estado, deps } = crearDobles();
		estado.pendientesAntesDeAprobar = Number.POSITIVE_INFINITY;
		const resultado = arrancar(deps);
		await vi.advanceTimersByTimeAsync(ESPERA_ENTRE_CONSULTAS_MS * 2);
		estado.vivo = false;
		await vi.advanceTimersByTimeAsync(ESPERA_MAXIMA_APROBACION_MS);

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

	it("entiende los nombres de campo en snake_case que manda Rust o el worker", async () => {
		const { estado, deps } = crearDobles();
		estado.identidad = { device_id: "h1", device_pubkey_b64: CLAVE };
		estado.respuestaClaim = { nonce_b64: "bm9uY2U=", nonce_expires_at_ms: 999 };
		estado.respuestaToken = { tenant_id: "t1", token: "jwt" };
		estado.pendientesAntesDeAprobar = 0;
		const resultado = arrancar(deps);
		await vi.advanceTimersByTimeAsync(ESPERA_ENTRE_CONSULTAS_MS);

		expect((await resultado).valor).toEqual({ tenantId: "t1", token: "jwt", deviceId: "h1" });
	});
});
