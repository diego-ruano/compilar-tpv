// test/reservasWebPublico.test.ts
//
// Reservas desde la web (docs/estudios/reservas-web.md §4.2): las rutas públicas que llama el
// widget, de punta a punta sobre la agenda de verdad y la base del negocio con su esquema real. La
// puerta (`puerta.ts`) tiene sus propios tests (`reservasWebPuerta.test.ts`): aquí se deja pasar.
// Lo que se fija:
//   · lo que devuelve cada ruta, y que ninguna respuesta lleva datos personales de una reserva;
//   · que el alta no devuelve el token del enlace de cancelar (sólo viaja en el correo);
//   · los rechazos de la agenda salen con su identificador y su estado.

import { env as entorno } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

import { crearEsquemaTenant } from "./helpers/esquemaTenant";
import { enLaAgenda, lectorSobre } from "./helpers/agenda";
import { sumarDias } from "../src/domains/reservas_web/disponibilidad";
import { horaLocalEn } from "../src/domains/reservas_web/horaDelNegocio";

const AHORA = horaLocalEn("Europe/Madrid", Date.now());
const HOY = AHORA.slice(0, 10);
const DIA = sumarDias(HOY, 3);

/** La agenda y el lector de la prueba en curso: los mocks de abajo los leen al llamarse. */
let enCurso: { motor: any; leer: any } | null = null;

vi.mock("../src/domains/reservas_web/puerta", async (importOriginal) => {
	const original = await importOriginal<typeof import("../src/domains/reservas_web/puerta")>();
	const pasa = async (c: any, next: any) => {
		c.set("tenantId", "t1");
		await next();
	};
	return { ...original, puertaPublica: pasa, limitadorAltas: pasa, verificacionHumana: pasa };
});

vi.mock("../src/lib/tenantClient", async (importOriginal) => {
	const original = await importOriginal<typeof import("../src/lib/tenantClient")>();
	return { ...original, lecturaConHora: (_env: any, t: string, _hora: any, fn: any) => enCurso!.leer(t, fn) };
});

/** Los eventos que se mandarían a Axiom. */
const eventos: any[] = [];

vi.mock("../src/observability/axiom", async (importOriginal) => {
	const original = await importOriginal<typeof import("../src/observability/axiom")>();
	return {
		...original,
		reportarReservaWeb: (_env: any, campos: any) => {
			eventos.push(campos);
			return Promise.resolve();
		},
	};
});

vi.mock("../src/durableObjects/agendaWeb", async (importOriginal) => {
	const original = await importOriginal<typeof import("../src/durableObjects/agendaWeb")>();
	return { ...original, agendaDe: () => enCurso!.motor };
});

const { reservasWebPublicoRoutes } = await import("../src/domains/reservas_web/publico.routes");

const app = new Hono();
app.route("/v1/publico/reservas", reservasWebPublicoRoutes);
const ENV = { ...(entorno as any), TURNSTILE_SITE_KEY: "0xPRUEBA" };

const BASE = "/v1/publico/reservas/rw_AAAAAAAAAAAAAAAAAAAAAA";

const PERSONALES = ["Ana", "ana@correo.es", "600112233", "bebé"];

async function pedir(ruta: string, cuerpo?: unknown) {
	const res = await app.request(
		`${BASE}${ruta}`,
		cuerpo === undefined
			? {}
			: { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(cuerpo) },
		ENV,
	);
	const json = (await res.json()) as any;
	const texto = JSON.stringify(json);
	for (const p of PERSONALES) expect(texto, `${ruta} lleva «${p}»`).not.toContain(p);
	return { status: res.status, json, res };
}

async function conNegocio(nombre: string, prueba: (sql: SqlStorage, motor: any) => Promise<void>) {
	await enLaAgenda(nombre, async (motor, state) => {
		const sql = state.storage.sql;
		crearEsquemaTenant(sql);
		sql.exec(
			`UPDATE Business_Settings SET Reserva_Web_Activa = 1, Business_Name = 'Bar Pepe', Telefono = '950 000 000',
			        Direccion = 'Calle Mayor 1', Razon_Social = 'Pepe SL', CIF = 'B00000000',
			        Logo_DataUrl = 'data:image/png;base64,AAAA' WHERE ID = 1;`,
		);
		sql.exec(`INSERT INTO Zonas (ID_Zona, Nombre_Zona, Room_Points) VALUES ('z1', 'Salon', '[[0,0],[10,0]]');`);
		for (const [id, cap, reservable] of [["m2", 2, 1], ["m4", 4, 1], ["m8", 8, 0]] as const) {
			sql.exec(
				`INSERT INTO Mesas (ID_Mesa, ID_Zona, Numero_Mesa, Capacidad, Ubicacion_X, Ubicacion_Y, Shape, Width, Height, Radius)
				 VALUES (?, 'z1', ?, ?, 10, 20, 'round', 80, 80, 40);`,
				id,
				id.slice(1),
				cap,
			);
			if (reservable) {
				sql.exec(`INSERT INTO Reserva_Web_Mesas (ID_Mesa, Activa) VALUES (?, 1);`, id);
				sql.exec(
					`INSERT INTO Reserva_Web_Franjas (ID_Franja, ID_Mesa, Dias_Semana, Hora_Desde, Hora_Hasta)
					 VALUES (?, ?, 127, '20:00', '23:30');`,
					`f-${id}`,
					id,
				);
			}
		}
		const leer = lectorSobre(state, () => AHORA);
		motor.leer = leer;
		enCurso = { motor, leer };
		try {
			await prueba(sql, motor);
		} finally {
			enCurso = null;
		}
	});
}

const ALTA = {
	dia_ymd: DIA,
	hora: "21:00",
	personas: 2,
	id_mesa: "m2",
	nombre: "Ana Pérez",
	email: "ana@correo.es",
	telefono: "600 112 233",
	nota: "Silla para bebé",
};

describe("las rutas públicas de la reserva web", () => {
	it("GET /negocio: lo del negocio y el calendario", async () => {
		await conNegocio("publico-negocio", async (sql) => {
			const { status, json } = await pedir("/negocio");
			expect(status).toBe(200);
			expect(json).toMatchObject({
				ok: true,
				negocio: {
					nombre: "Bar Pepe",
					direccion: "Calle Mayor 1",
					telefono: "950 000 000",
					logo: "data:image/png;base64,AAAA",
					razon_social: "Pepe SL",
					cif: "B00000000",
				},
				hoy: HOY,
				primer_dia: sumarDias(HOY, 1),
				ultimo_dia: sumarDias(HOY, 30),
				max_personas: 4,
				duracion_min: 120,
				turnstile: "0xPRUEBA",
			});
			expect(json.dias_abiertos).toHaveLength(30);

			sql.exec(`INSERT INTO Reserva_Web_Cierres (ID_Cierre, Dia_YMD) VALUES ('c1', ?);`, DIA);
			expect((await pedir("/negocio")).json.dias_abiertos).not.toContain(DIA);

			sql.exec(`UPDATE Business_Settings SET Reserva_Web_Activa = 0;`);
			const cerrada = await pedir("/negocio");
			expect(cerrada.status).toBe(409);
			expect(cerrada.json).toMatchObject({
				ok: false,
				error: "reserva_web_cerrada",
				negocio: { nombre: "Bar Pepe", telefono: "950 000 000" },
			});
		});
	});

	it("GET /negocio: un logo que no es una imagen en `data:` no sale", async () => {
		await conNegocio("publico-logo", async (sql) => {
			sql.exec(`UPDATE Business_Settings SET Logo_DataUrl = 'https://otra.web/logo.png';`);
			expect((await pedir("/negocio")).json.negocio.logo).toBeNull();
		});
	});

	it("GET /dia: los tramos de llegada, o por qué ese día no", async () => {
		await conNegocio("publico-dia", async () => {
			expect((await pedir(`/dia?dia=${DIA}`)).json).toEqual({ ok: true, dia: DIA, tramos: [{ desde: "19:40", hasta: "21:50" }] });
			expect(await pedir(`/dia?dia=${HOY}`)).toMatchObject({ status: 400, json: { error: "dia_no_reservable" } });
			expect((await pedir(`/dia?dia=2026-02-31`)).status).toBe(400);
		});
	});

	it("GET /plano: salones y mesas para dibujar, sin nada de las reservas", async () => {
		await conNegocio("publico-plano", async () => {
			const { json, res } = await pedir("/plano");
			expect(res.headers.get("Cache-Control")).toBe("public, max-age=60");
			expect(json.completo).toBe(true);
			expect(json.salones).toEqual([{ id: "z1", nombre: "Salon", puntos: "[[0,0],[10,0]]" }]);
			expect(json.mesas.map((m: any) => [m.id, m.reservable])).toEqual([
				["m2", true],
				["m4", true],
				["m8", false],
			]);
			expect(json.mesas[0]).toEqual({
				id: "m2",
				id_salon: "z1",
				numero: "2",
				forma: "round",
				x: 10,
				y: 20,
				ancho: 80,
				alto: 80,
				radio: 40,
				capacidad: 2,
				reservable: true,
			});
		});
	});

	it("GET /plano: con más mesas de las que caben, lo dice en vez de cortar en silencio", async () => {
		await conNegocio("publico-plano-techo", async (sql) => {
			for (let i = 0; i < 500; i++) {
				sql.exec(
					`INSERT INTO Mesas (ID_Mesa, ID_Zona, Numero_Mesa, Capacidad, Ubicacion_X, Ubicacion_Y, Shape, Width, Height)
					 VALUES (?, 'z1', ?, 2, 0, 0, 'rect', 80, 80);`,
					`x${i}`,
					`x${i}`,
				);
			}
			const { json } = await pedir("/plano");
			expect(json.completo).toBe(false);
			expect(json.mesas).toHaveLength(500);
		});
	});

	it("GET /disponibles: las mesas libres; una consulta mal hecha es un 400", async () => {
		await conNegocio("publico-disponibles", async () => {
			expect((await pedir(`/disponibles?dia=${DIA}&hora=21:00&personas=2`)).json).toEqual({
				ok: true,
				mesas: ["m2", "m4"],
				alternativas: [],
			});
			expect((await pedir(`/disponibles?dia=${DIA}&hora=17:00&personas=2`)).json.error).toBe("hora_fuera_de_franja");
			for (const malo of ["personas=0", "personas=dos", "personas=51", "hora=25:00&personas=2"]) {
				const consulta = malo.includes("hora=") ? `dia=${DIA}&${malo}` : `dia=${DIA}&hora=21:00&${malo}`;
				expect((await pedir(`/disponibles?${consulta}`)).status, malo).toBe(400);
			}
		});
	});

	it("POST /reservas: confirma sin devolver el token ni el id, y la mesa ya no se ofrece", async () => {
		await conNegocio("publico-reservar", async () => {
			const { status, json } = await pedir("/reservas", ALTA);
			expect(status).toBe(200);
			expect(Object.keys(json).sort()).toEqual(["codigo", "dia", "hora", "mesa", "ok", "personas"]);
			expect(json).toMatchObject({ ok: true, dia: DIA, hora: "21:00", personas: 2, mesa: "2" });
			expect(json.codigo).toMatch(/^[0-9A-F]{6}$/);
			// A Axiom, el id y nada de quien reserva.
			const alta = eventos.find((e) => e.event === "reserva_web_alta");
			expect(Object.keys(alta).sort()).toEqual(["event", "id_reserva", "tenant_id"]);
			for (const p of PERSONALES) expect(JSON.stringify(eventos)).not.toContain(p);

			expect((await pedir(`/disponibles?dia=${DIA}&hora=21:00&personas=2`)).json.mesas).toEqual(["m4"]);
			eventos.length = 0;
			expect(await pedir("/reservas", { ...ALTA, email: "otro@correo.es" })).toMatchObject({
				status: 409,
				json: { ok: false, error: "mesa_no_disponible" },
			});
			expect(eventos).toEqual([{ event: "reserva_web_rechazo", tenant_id: "t1", motivo: "mesa_no_disponible" }]);
		});
	});

	it("POST /reservas: con la misma Idempotency-Key, la misma reserva; una mal formada no cuenta", async () => {
		await conNegocio("publico-reservar-intento", async (sql) => {
			const alta = (clave: string, cuerpo = ALTA) =>
				app.request(
					`${BASE}/reservas`,
					{ method: "POST", headers: { "content-type": "application/json", "Idempotency-Key": clave }, body: JSON.stringify(cuerpo) },
					ENV,
				);
			const clave = "5b0e2f8c-6d1a-4c3e-9f7b-2a4d6e8f0a1c";
			const primera = (await (await alta(clave)).json()) as any;
			eventos.length = 0;
			const res = await alta(clave, { ...ALTA, id_mesa: "m4" });
			expect(res.status).toBe(200);
			const repetida = (await res.json()) as any;
			expect(Object.keys(repetida).sort()).toEqual(["codigo", "dia", "hora", "mesa", "ok", "personas"]);
			expect(repetida).toEqual(primera);
			expect(eventos.map((e) => e.event)).toEqual(["reserva_web_alta_repetida"]);
			expect(sql.exec(`SELECT COUNT(*) AS n FROM peticiones;`).toArray()[0]).toEqual({ n: 1 });

			// Una clave que no tiene la forma de una se ignora: es un alta más, y la mesa ya no está libre.
			expect((await alta("corta")).status).toBe(409);
		});
	});

	it("POST /reservas: lo que no valida es un 400 y no llega a la agenda", async () => {
		await conNegocio("publico-reservar-invalido", async (sql) => {
			for (const malo of [{ ...ALTA, email: "no-es-correo" }, { ...ALTA, personas: "2" }, { ...ALTA, nombre: { toString: null } }]) {
				expect((await pedir("/reservas", malo)).status).toBe(400);
			}
			expect(sql.exec(`SELECT COUNT(*) AS n FROM peticiones;`).toArray()[0]).toEqual({ n: 0 });
		});
	});

	it("POST /reserva y /cancelar: con el token del correo", async () => {
		await conNegocio("publico-cancelar", async (_sql, motor) => {
			const hecha = await motor.reservar({ tenantId: "t1", alta: { ...ALTA, telefono: "600112233" } });
			const resumen = await pedir("/reserva", { token: hecha.token });
			expect(resumen.json).toEqual({ ok: true, dia: DIA, hora: "21:00", personas: 2, mesa: "2", estado: "confirmada", cancelable: true });

			expect((await pedir("/cancelar", { token: hecha.token })).json).toEqual({ ok: true });
			expect((await pedir("/reserva", { token: hecha.token })).json.estado).toBe("cancelada");
			expect(await pedir("/cancelar", { token: "inventado" })).toMatchObject({ status: 404, json: { error: "enlace_no_valido" } });
			// Sin token, la petición está mal hecha.
			expect((await pedir("/cancelar", {})).status).toBe(400);
		});
	});
});
