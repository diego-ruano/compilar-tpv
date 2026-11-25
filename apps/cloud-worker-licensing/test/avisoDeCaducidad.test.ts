// test/avisoDeCaducidad.test.ts
//
// REV-13 · El aviso de caducidad.
//
// Una licencia que caduca no avisa sola: el cliente se entera el día que el TPV deja de vender.
// El enlace es el de compra de siempre —lo que convierte esa compra en tiempo añadido es activar
// la clave en un equipo que ya tiene licencia—, así que aquí lo que se fija es el reparto de los
// avisos: a quién, cuántas veces y qué pasa cuando el correo no sale o la central falla con una.
//
// Corre contra una base central de verdad (`helpers/central.ts`), nueva en cada caso, vista a través
// de su stub (`centralInterceptada`), por donde se le hace fallar un viaje.

import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";

import { centralDePrueba, centralInterceptada, desvio, filasDe, type Atender, type CentralDePrueba } from "./helpers/central";
import type { SentenciaEnlazada } from "../src/durableObjects/baseCentral.rpc";
import { avisarDeCaducidades, enlaceDeCompra } from "../src/domains/licensing/avisosDeCaducidad";
import { CentralNoDisponible } from "../src/server/central/cliente";

/** Lo que se manda a Sentry: la operación y el error. */
const { capturados } = vi.hoisted(() => ({ capturados: [] as { operacion: string; error: unknown }[] }));

vi.mock("../src/observability/errors", async (importOriginal) => {
	const original = await importOriginal<typeof import("../src/observability/errors")>();
	return {
		...original,
		capturarError: (error: unknown, operacion: string) => {
			if (!original.esRechazoEsperado(error)) capturados.push({ operacion, error });
			original.capturarError(error, operacion);
		},
	};
});

/** Con Axiom configurado: lo que se le manda, en `eventos`. */
const AXIOM = { AXIOM_TOKEN: "token-de-pruebas", AXIOM_DATASET_SYNC: "sync-de-pruebas" };
let eventos: any[] = [];

beforeEach(() => {
	capturados.length = 0;
	eventos = [];
	vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
		eventos.push(...JSON.parse(String(init.body)));
		return new Response("{}", { status: 200 });
	});
});

afterEach(() => {
	vi.unstubAllGlobals();
});

/** Los eventos `central_no_disponible` que han salido, cuando son `cuantos`: el motivo, el método y la ruta. */
async function sinLaCentral(cuantos: number) {
	const de = () => eventos.filter((e) => e.event === "central_no_disponible");
	await vi.waitFor(() => expect(de()).toHaveLength(cuantos));
	return de().map((e) => [e.motivo, e.metodo, e.ruta]);
}

const DIA = 24 * 60 * 60 * 1000;
const AHORA = 1_800_000_000_000;

type Correo = { to: string; subject: string; html: string; text: string };

function entorno(extra: Record<string, unknown> = {}) {
	const enviados: Correo[] = [];
	const env = {
		EMAIL_FROM_ADDRESS: "pedidos@ejemplo.test",
		EMAIL_FROM_NAME: "TPV",
		CHECKOUT_URL: "https://buy.stripe.com/renovacion",
		EMAIL: {
			send: async (msg: Correo) => {
				enviados.push(msg);
			},
		},
		...extra,
	} as any;
	return { env, enviados };
}

type Escenario = {
	db: CentralDePrueba["db"];
	/** Ejecuta SQL directamente en la base central, por debajo de sus guardas. */
	sql: (texto: string, ...args: unknown[]) => Promise<unknown>;
	/** Una licencia activa que caduca dentro de `dias`. Devuelve su id. */
	licencia: (id: string, dias: number, extra?: Record<string, unknown>) => Promise<string>;
	avisos: () => Promise<Array<{ license_id: string; kind: string; expires_at_ms: number }>>;
	/** Cambia lo que contesta la central a `db` (`desvio`); con `null`, vuelve a dejarlo pasar. */
	desviar: (atender: Atender | null) => void;
};

async function escenario<T>(fn: (e: Escenario) => Promise<T>): Promise<T> {
	const central = await centralDePrueba();
	const { atender, desviar } = desvio();
	const e: Escenario = {
		db: centralInterceptada(central, atender).db,
		desviar,
		sql: (texto, ...args) => filasDe(central, texto, ...args),
		async licencia(id, dias, extra = {}) {
			const campos = {
				status: "active",
				disabled: 0,
				expires_at_ms: AHORA + dias * DIA,
				...extra,
			} as any;
			await filasDe(
				central,
				`INSERT INTO licenses (license_id, license_key_hash, status, disabled, plan, term_months,
				   origin, issued_at_ms, activated_at_ms, expires_at_ms, customer_email, customer_name,
				   created_at_ms, updated_at_ms)
				 VALUES (?, ?, ?, ?, 'standard', 12, 'stripe', ?, ?, ?, ?, 'Bar de pruebas', ?, ?);`,
				id,
				`hash-${id}`,
				campos.status,
				campos.disabled,
				AHORA - 300 * DIA,
				AHORA - 300 * DIA,
				campos.expires_at_ms,
				`${id}@ejemplo.test`,
				AHORA - 300 * DIA,
				AHORA - 300 * DIA,
			);
			return id;
		},
		async avisos() {
			return (await filasDe(
				central,
				`SELECT license_id, kind, expires_at_ms FROM license_notices ORDER BY kind;`,
			)) as any;
		},
	};
	return fn(e);
}

describe("REV-13 · a quién se avisa", () => {
	it("avisa a la que caduca dentro de 30 días y no a la que le quedan 60", async () => {
		const r = await escenario(async (e) => {
			await e.licencia("lic-30", 25);
			await e.licencia("lic-60", 60);
			const { env, enviados } = entorno();
			const resumen = await avisarDeCaducidades(env, e.db, AHORA);
			return { resumen, enviados, avisos: await e.avisos() };
		});

		expect(r.resumen.enviados).toBe(1);
		expect(r.enviados[0].to).toBe("lic-30@ejemplo.test");
		expect(r.avisos).toEqual([
			{ license_id: "lic-30", kind: "expira_30", expires_at_ms: AHORA + 25 * DIA },
		]);
	});

	it("una que ya caducó no recibe nada: el aviso llega antes, no después", async () => {
		const r = await escenario(async (e) => {
			await e.licencia("lic-vieja", -3, { status: "expired" });
			const { env, enviados } = entorno();
			return { resumen: await avisarDeCaducidades(env, e.db, AHORA), enviados };
		});

		expect(r.resumen.revisadas).toBe(0);
		expect(r.enviados).toHaveLength(0);
	});

	it("una anulada no recibe nada", async () => {
		// Avisar de que va a caducar una licencia que le has revocado es ruido, y confuso.
		const r = await escenario(async (e) => {
			await e.licencia("lic-anulada", 10, { status: "revoked", disabled: 1 });
			const { env, enviados } = entorno();
			return { resumen: await avisarDeCaducidades(env, e.db, AHORA), enviados };
		});

		expect(r.resumen.revisadas).toBe(0);
		expect(r.enviados).toHaveLength(0);
	});

	it("una comprada y nunca estrenada no recibe nada: no tiene reloj corriendo", async () => {
		const r = await escenario(async (e) => {
			await e.sql(
				`INSERT INTO licenses (license_id, license_key_hash, status, disabled, plan, term_months,
				   origin, issued_at_ms, customer_email, created_at_ms, updated_at_ms)
				 VALUES ('lic-nueva', 'h', 'issued', 0, 'standard', 12, 'stripe', ?, 'a@b.test', ?, ?);`,
				AHORA,
				AHORA,
				AHORA,
			);
			const { env, enviados } = entorno();
			return { resumen: await avisarDeCaducidades(env, e.db, AHORA), enviados };
		});

		expect(r.resumen.revisadas).toBe(0);
		expect(r.enviados).toHaveLength(0);
	});
});

describe("REV-13 · cuántas veces se avisa", () => {
	it("el mismo ciclo repetido no manda un segundo correo", async () => {
		const r = await escenario(async (e) => {
			await e.licencia("lic-1", 25);
			const { env, enviados } = entorno();
			const uno = await avisarDeCaducidades(env, e.db, AHORA);
			const dos = await avisarDeCaducidades(env, e.db, AHORA + DIA);
			return { uno, dos, enviados };
		});

		expect(r.uno.enviados).toBe(1);
		expect(r.dos.enviados).toBe(0);
		expect(r.dos.yaAvisadas).toBe(1);
		expect(r.enviados).toHaveLength(1);
	});

	it("a una que entra ya con 5 días le llega UN correo, no los dos peldaños de golpe", async () => {
		const r = await escenario(async (e) => {
			await e.licencia("lic-urgente", 5);
			const { env, enviados } = entorno();
			return { resumen: await avisarDeCaducidades(env, e.db, AHORA), enviados, avisos: await e.avisos() };
		});

		expect(r.enviados).toHaveLength(1);
		expect(r.avisos).toHaveLength(1);
		expect(r.avisos[0].kind).toBe("expira_7");
		expect(r.enviados[0].subject).toContain("5 días");
	});

	it("la de 30 y luego la de 7 son dos avisos distintos", async () => {
		const r = await escenario(async (e) => {
			await e.licencia("lic-1", 25);
			const { env, enviados } = entorno();
			const lejos = await avisarDeCaducidades(env, e.db, AHORA);
			// Veinte días después le quedan 5: toca el peldaño urgente.
			const cerca = await avisarDeCaducidades(env, e.db, AHORA + 20 * DIA);
			return { lejos, cerca, enviados, avisos: await e.avisos() };
		});

		expect(r.lejos.enviados).toBe(1);
		expect(r.cerca.enviados).toBe(1);
		expect(r.avisos.map((a) => a.kind)).toEqual(["expira_30", "expira_7"]);
	});

	it("renovar vuelve a abrir el aviso del año que viene", async () => {
		// Es lo que justifica que `expires_at_ms` esté en la clave: sin él, la fila del año pasado
		// silenciaría para siempre a una licencia que se renueva todos los años.
		const r = await escenario(async (e) => {
			await e.licencia("lic-1", 25);
			const { env, enviados } = entorno();
			await avisarDeCaducidades(env, e.db, AHORA);

			await e.sql(`UPDATE licenses SET expires_at_ms=? WHERE license_id='lic-1';`, AHORA + 390 * DIA);
			const luego = await avisarDeCaducidades(env, e.db, AHORA + 365 * DIA);
			return { luego, enviados, avisos: await e.avisos() };
		});

		expect(r.luego.enviados).toBe(1);
		expect(r.enviados).toHaveLength(2);
		expect(r.avisos).toHaveLength(2);
	});

	it("si el correo no sale, la marca se suelta y mañana se reintenta", async () => {
		const r = await escenario(async (e) => {
			await e.licencia("lic-1", 25);
			let rota = true;
			const enviados: any[] = [];
			const env = {
				EMAIL_FROM_ADDRESS: "pedidos@ejemplo.test",
				CHECKOUT_URL: "https://buy.stripe.com/renovacion",
				EMAIL: {
					send: async (msg: any) => {
						if (rota) throw new Error("buzón caído");
						enviados.push(msg);
					},
				},
			} as any;

			const falla = await avisarDeCaducidades(env, e.db, AHORA);
			const avisosTrasFallo = await e.avisos();
			rota = false;
			const bien = await avisarDeCaducidades(env, e.db, AHORA + DIA);
			return { falla, avisosTrasFallo, bien, enviados };
		});

		expect(r.falla.fallidos).toBe(1);
		// Lo que no puede quedar: un aviso contado como enviado que nunca salió.
		expect(r.avisosTrasFallo).toHaveLength(0);
		expect(r.bien.enviados).toBe(1);
		expect(r.enviados).toHaveLength(1);
	});
});

describe("REV-13 · el enlace", () => {
	it("es el enlace de compra de siempre, con el correo puesto", async () => {
		const { env } = entorno();
		const url = new URL(
			enlaceDeCompra(env, {
				license_id: "lic-abc",
				customer_email: "bar@ejemplo.test",
			} as any)!,
		);

		expect(url.origin + url.pathname).toBe("https://buy.stripe.com/renovacion");
		expect(url.searchParams.get("prefilled_email")).toBe("bar@ejemplo.test");
	});

	it("sin CHECKOUT_URL no se manda ningún aviso", async () => {
		// Un aviso que no lleva a ninguna parte no es un aviso: deja al cliente sabiendo que tiene
		// un problema y sin qué hacer con él.
		const r = await escenario(async (e) => {
			await e.licencia("lic-1", 25);
			const { env, enviados } = entorno({ CHECKOUT_URL: "" });
			return { resumen: await avisarDeCaducidades(env, e.db, AHORA), enviados, avisos: await e.avisos() };
		});

		expect(r.resumen.sinEnlace).toBe(true);
		expect(r.enviados).toHaveLength(0);
		expect(r.avisos).toHaveLength(0);
	});
});

/** Como marca la plataforma un fallo pasajero, o la central saturada. */
const PASAJERA = { retryable: true };
const SATURADA = { overloaded: true };

/**
 * Un `Atender` que rechaza, como la plataforma (por defecto, ante un fallo pasajero), el primer viaje
 * con una sentencia que case con `patron` sobre la licencia `licencia`, sin que llegue a la central.
 */
function fallaUnaVez(patron: RegExp, licencia: string, marca: object = PASAJERA): Atender {
	let pendiente = true;
	return (metodo, argumentos, llamar) => {
		const sentencia = argumentos[0] as SentenciaEnlazada;
		if (!pendiente || metodo !== "ejecutar" || !patron.test(sentencia.sql) || sentencia.args[0] !== licencia) {
			return llamar();
		}
		pendiente = false;
		return Promise.reject(Object.assign(new Error("Durable Object reset because its code was updated."), marca));
	};
}

describe("REV-13 · si la central falla con una licencia, las demás siguen", () => {
	it("al poner su marca: las demás reciben su aviso, y el suyo sale al día siguiente", async () => {
		const r = await escenario(async (e) => {
			// La que caduca antes es la primera que se revisa.
			await e.licencia("lic-a", 20);
			await e.licencia("lic-b", 25);
			const { env, enviados } = entorno(AXIOM);

			e.desviar(fallaUnaVez(/INSERT OR IGNORE INTO license_notices/, "lic-a"));
			const hoy = await avisarDeCaducidades(env, e.db, AHORA);
			e.desviar(null);
			const deHoy = enviados.map((c) => c.to);
			const manana = await avisarDeCaducidades(env, e.db, AHORA + DIA);
			return { hoy, deHoy, manana, enviados };
		});

		expect(r.hoy).toMatchObject({ revisadas: 2, enviados: 1, yaAvisadas: 0, fallidos: 1 });
		expect(r.deHoy).toEqual(["lic-b@ejemplo.test"]);
		// La central que no atiende por un fallo pasajero queda en Axiom, con la operación del cron, y no
		// va a Sentry: como en el resto del Worker.
		expect(await sinLaCentral(1)).toEqual([["pasajera", "cron", "cron.license_expiry"]]);
		expect(capturados).toEqual([]);
		// No llegó a marcarse, así que el ciclo siguiente la avisa.
		expect(r.manana).toMatchObject({ enviados: 1, yaAvisadas: 1, fallidos: 0 });
		expect(r.enviados.map((c) => c.to)).toEqual(["lic-b@ejemplo.test", "lic-a@ejemplo.test"]);
	});

	it("al soltar la marca de un aviso que no ha salido: las demás reciben el suyo", async () => {
		const r = await escenario(async (e) => {
			await e.licencia("lic-a", 20);
			await e.licencia("lic-b", 25);
			const enviados: string[] = [];
			const { env } = entorno({
				...AXIOM,
				EMAIL: {
					send: async (msg: Correo) => {
						if (msg.to === "lic-a@ejemplo.test") throw new Error("buzón caído");
						enviados.push(msg.to);
					},
				},
			});

			e.desviar(fallaUnaVez(/DELETE FROM license_notices/, "lic-a"));
			const resumen = await avisarDeCaducidades(env, e.db, AHORA);
			e.desviar(null);
			return { resumen, enviados };
		});

		expect(r.resumen).toMatchObject({ revisadas: 2, enviados: 1, yaAvisadas: 0, fallidos: 1 });
		expect(r.enviados).toEqual(["lic-b@ejemplo.test"]);
		// El correo que no salió va a Sentry; la central que no soltó la marca, a Axiom.
		expect(capturados.map((c) => c.operacion)).toEqual(["license_email.send"]);
		expect(await sinLaCentral(1)).toEqual([["pasajera", "cron", "cron.license_expiry"]]);
	});

	it("un fallo de la central que no es carga ni pasajero sí va a Sentry, con la operación del cron", async () => {
		const r = await escenario(async (e) => {
			await e.licencia("lic-a", 20);
			await e.licencia("lic-b", 25);
			const { env } = entorno(AXIOM);
			e.desviar(fallaUnaVez(/INSERT OR IGNORE INTO license_notices/, "lic-a", {}));
			return avisarDeCaducidades(env, e.db, AHORA);
		});

		expect(r).toMatchObject({ revisadas: 2, enviados: 1, fallidos: 1 });
		expect(capturados.map((c) => c.operacion)).toEqual(["cron.license_expiry"]);
		expect(capturados[0].error).toBeInstanceOf(CentralNoDisponible);
		expect(await sinLaCentral(1)).toEqual([["rechazo", "cron", "cron.license_expiry"]]);
	});
});

describe("REV-13 · con la central saturada, el ciclo se corta", () => {
	it("las que faltan cuentan como fallidas, sin más viajes ni Sentry, y mañana se avisa de todas", async () => {
		const r = await escenario(async (e) => {
			await e.licencia("lic-a", 20);
			await e.licencia("lic-b", 25);
			await e.licencia("lic-c", 28);
			const { env, enviados } = entorno(AXIOM);

			// Saturada al marcar la primera; lo que se pida después, contado.
			let saturada = false;
			let viajesDespues = 0;
			const marcarLaPrimera = fallaUnaVez(/INSERT OR IGNORE INTO license_notices/, "lic-a", SATURADA);
			e.desviar((metodo, argumentos, llamar) => {
				if (saturada) viajesDespues++;
				const respuesta = marcarLaPrimera(metodo, argumentos, llamar);
				if (respuesta instanceof Promise) respuesta.catch(() => (saturada = true));
				return respuesta;
			});
			const hoy = await avisarDeCaducidades(env, e.db, AHORA);
			e.desviar(null);
			const deHoy = enviados.map((c) => c.to);
			const manana = await avisarDeCaducidades(env, e.db, AHORA + DIA);
			return { hoy, deHoy, viajesDespues, manana, enviados: enviados.map((c) => c.to), avisos: await e.avisos() };
		});

		expect(r.hoy).toMatchObject({ revisadas: 3, enviados: 0, yaAvisadas: 0, fallidos: 3 });
		expect(r.deHoy).toEqual([]);
		expect(r.viajesDespues).toBe(0);
		expect(capturados).toEqual([]);
		expect(await sinLaCentral(1)).toEqual([["saturada", "cron", "cron.license_expiry"]]);
		// Ninguna se marcó: al día siguiente salen las tres.
		expect(r.manana).toMatchObject({ revisadas: 3, enviados: 3, fallidos: 0 });
		expect(r.enviados).toEqual(["lic-a@ejemplo.test", "lic-b@ejemplo.test", "lic-c@ejemplo.test"]);
		expect(r.avisos).toHaveLength(3);
	});
});
