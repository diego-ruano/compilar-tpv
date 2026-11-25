// test/reservasWebPublico.test.ts
//
// Reservas desde la web (docs/estudios/reservas-web.md §4.2): las rutas públicas que llama el
// widget, de punta a punta sobre la agenda de verdad y la base del negocio con su esquema real. La
// puerta (`puerta.ts`) tiene sus propios tests (`reservasWebPuerta.test.ts`): aquí se deja pasar.
// Lo que se fija:
//   · lo que devuelve cada ruta, y que ninguna respuesta lleva datos personales de una reserva;
//   · que el alta no devuelve el token del enlace de cancelar (sólo viaja en el correo), y que el
//     correo de confirmación va a la dirección del alta con un enlace que abre esa reserva;
//   · los rechazos de la agenda salen con su identificador y su estado.

import { env as entorno } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

import { crearEsquemaTenant } from "./helpers/esquemaTenant";
import { enLaAgenda, lectorSobre } from "./helpers/agenda";
import { centralDePrueba, filasDe, fotoDeLaCentral, type CentralDePrueba } from "./helpers/central";
import { sumarDias } from "../src/domains/reservas_web/disponibilidad";
import { horaLocalEn } from "../src/domains/reservas_web/horaDelNegocio";
import { MAX_ALTAS_DIA_CONEXION, MAX_ALTAS_DIA_RED, codigoDeReserva } from "../src/durableObjects/agendaWeb.motor";
import { msDelId } from "../src/lib/ids";
import { sha256HexStr } from "../src/server/utils/crypto";

const AHORA = horaLocalEn("Europe/Madrid", Date.now());
const HOY = AHORA.slice(0, 10);
const DIA = sumarDias(HOY, 3);

/**
 * La agenda, el lector y la base central de la prueba en curso: los mocks de abajo los leen al
 * llamarse, y las peticiones llevan la central en su `env` (`envDeLaPrueba`).
 */
let enCurso: { motor: any; leer: any; central: CentralDePrueba } | null = null;

vi.mock("../src/domains/reservas_web/puerta", async (importOriginal) => {
	const original = await importOriginal<typeof import("../src/domains/reservas_web/puerta")>();
	const pasa = async (c: any, next: any) => {
		c.set("tenantId", "t1");
		await next();
	};
	return { ...original, puertaPublica: pasa, limitadorAltas: pasa, verificacionHumana: pasa };
});

vi.mock("../src/domains/reservas_web/lecturasDeLaWeb", async (importOriginal) => {
	const original = await importOriginal<typeof import("../src/domains/reservas_web/lecturasDeLaWeb")>();
	return { ...original, leerParaLaWeb: (_env: any, t: string, lectura: any) => enCurso!.leer(t, lectura) };
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
const { huellasDeLaConexion } = await import("../src/domains/reservas_web/puerta");

const app = new Hono();
app.route("/v1/publico/reservas", reservasWebPublicoRoutes);
/** Los correos que han salido, y si el binding tiene que fallar. */
const enviados: any[] = [];
let correoCaido = false;
const ENV = {
	...(entorno as any),
	TURNSTILE_SITE_KEY: "0xPRUEBA",
	EMAIL_RESERVAS_FROM_ADDRESS: "reservas@altaria.test",
	EMAIL: {
		send: async (m: any) => {
			if (correoCaido) throw Object.assign(new Error("caído"), { code: "E_INTERNAL" });
			enviados.push(m);
		},
	},
};

/** El `env` de las peticiones de la prueba en curso: el de la suite, con su base central. */
function envDeLaPrueba() {
	return { ...ENV, ...enCurso!.central.entorno };
}

const BASE = "/v1/publico/reservas/rw_AAAAAAAAAAAAAAAAAAAAAA";

const PERSONALES = ["Ana", "ana@correo.es", "600112233", "bebé"];

async function pedir(ruta: string, cuerpo?: unknown) {
	const res = await app.request(
		`${BASE}${ruta}`,
		cuerpo === undefined
			? {}
			: { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(cuerpo) },
		envDeLaPrueba(),
	);
	const json = (await res.json()) as any;
	const texto = JSON.stringify(json);
	for (const p of PERSONALES) expect(texto, `${ruta} lleva «${p}»`).not.toContain(p);
	return { status: res.status, json, res };
}

async function conNegocio(
	nombre: string,
	prueba: (sql: SqlStorage, motor: any, central: CentralDePrueba) => Promise<void>,
) {
	const central = await centralDePrueba();
	await enLaAgenda(nombre, async (motor, state) => {
		const sql = state.storage.sql;
		crearEsquemaTenant(sql);
		sql.exec(
			`UPDATE Business_Settings SET Reserva_Web_Activa = 1, Business_Name = 'Bar Pepe', Telefono = '950 000 000',
			        Direccion = 'Calle Mayor 1', Razon_Social = 'Pepe SL', CIF = 'B00000000',
			        Logo_DataUrl = 'images/logo/0190f3a1-7b2c-4d4e-8f00-123456789abc.png' WHERE ID = 1;`,
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
		enCurso = { motor, leer, central };
		enviados.length = 0;
		correoCaido = false;
		try {
			await prueba(sql, motor, central);
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

/** La misma alta, como la manda el widget o el SDK: con los nombres públicos. */
const ALTA_WEB = {
	dia: DIA,
	hora: "21:00",
	personas: 2,
	mesa: "m2",
	nombre: "Ana Pérez",
	correo: "ana@correo.es",
	telefono: "600 112 233",
	nota: "Silla para bebé",
};

/** El token del enlace de cancelar de un correo de confirmación, que es el único sitio por donde viaja. */
function tokenDelCorreo(m: any): string {
	const linea = String(m.text)
		.split("\n")
		.find((l) => l.startsWith("Cancelar la reserva: "));
	return new URL(linea!.slice("Cancelar la reserva: ".length)).hash.slice("#t=".length);
}

/** Un alta desde una IP, como llega de Cloudflare: en `CF-Connecting-IP`. */
async function altaDesde(ip: string, cuerpo: unknown) {
	const res = await app.request(
		`${BASE}/reservas`,
		{ method: "POST", headers: { "content-type": "application/json", "CF-Connecting-IP": ip }, body: JSON.stringify(cuerpo) },
		envDeLaPrueba(),
	);
	return { status: res.status, json: (await res.json()) as any };
}

/** La alta n.º `i` de una tanda: cada una en su día y con su correo, para no chocar con otros topes. */
const altaN = (i: number) => ({ ...ALTA_WEB, dia: sumarDias(HOY, 2 + i), correo: `persona${i}@correo.test` });

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

	// M-072: el logo es la ruta de una imagen del bucket, que sólo se sirve con el id del negocio en
	// el camino (`/v1/images/:tenant/…`), y el widget sólo conoce su clave. No se manda.
	it("GET /negocio: el logo no sale", async () => {
		await conNegocio("publico-logo", async () => {
			expect(Object.keys((await pedir("/negocio")).json.negocio).sort()).toEqual(
				["cif", "direccion", "nombre", "razon_social", "telefono"],
			);
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
				nombre: "2",
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
			const { status, json } = await pedir("/reservas", ALTA_WEB);
			expect(status).toBe(200);
			expect(Object.keys(json).sort()).toEqual(["codigo", "correo_enviado", "dia", "hora", "mesa", "mesa_nombre", "ok", "personas"]);
			expect(json).toMatchObject({ ok: true, dia: DIA, hora: "21:00", personas: 2, mesa: "m2", mesa_nombre: "2", correo_enviado: true });
			expect(json.codigo).toMatch(/^[0-9A-F]{6}$/);
			// A Axiom, el id y nada de quien reserva.
			const alta = eventos.find((e) => e.event === "reserva_web_alta");
			expect(Object.keys(alta).sort()).toEqual(["event", "id_reserva", "tenant_id"]);
			for (const p of PERSONALES) expect(JSON.stringify(eventos)).not.toContain(p);

			expect((await pedir(`/disponibles?dia=${DIA}&hora=21:00&personas=2`)).json.mesas).toEqual(["m4"]);
			eventos.length = 0;
			expect(await pedir("/reservas", { ...ALTA_WEB, correo: "otro@correo.es" })).toMatchObject({
				status: 409,
				json: { ok: false, error: "mesa_no_disponible" },
			});
			expect(eventos).toEqual([{ event: "reserva_web_rechazo", tenant_id: "t1", motivo: "mesa_no_disponible" }]);
		});
	});

	it("POST /reservas: con la misma Idempotency-Key, la misma reserva; una mal formada no cuenta", async () => {
		await conNegocio("publico-reservar-intento", async (sql) => {
			const alta = (clave: string, cuerpo = ALTA_WEB) =>
				app.request(
					`${BASE}/reservas`,
					{ method: "POST", headers: { "content-type": "application/json", "Idempotency-Key": clave }, body: JSON.stringify(cuerpo) },
					envDeLaPrueba(),
				);
			const clave = "5b0e2f8c-6d1a-4c3e-9f7b-2a4d6e8f0a1c";
			const primera = (await (await alta(clave)).json()) as any;
			eventos.length = 0;
			const res = await alta(clave, { ...ALTA_WEB, mesa: "m4" });
			expect(res.status).toBe(200);
			const repetida = (await res.json()) as any;
			// La misma reserva; del correo no se sabe (salió con el alta de verdad) y no vuelve a salir.
			expect(repetida).toEqual({ ...primera, correo_enviado: null });
			expect(enviados).toHaveLength(1);
			expect(eventos.map((e) => e.event)).toEqual(["reserva_web_alta_repetida"]);
			expect(sql.exec(`SELECT COUNT(*) AS n FROM peticiones;`).toArray()[0]).toEqual({ n: 1 });

			// Una clave que no tiene la forma de una se ignora: es un alta más, y la mesa ya no está libre.
			expect((await alta("corta")).status).toBe(409);
		});
	});

	it("POST /reservas: la confirmación va a la dirección del alta, sin lo que escribió, con un enlace que abre su reserva", async () => {
		await conNegocio("publico-reservar-correo", async () => {
			const { json } = await pedir("/reservas", ALTA_WEB);
			expect(enviados).toHaveLength(1);
			const m = enviados[0];
			expect(m).toMatchObject({ to: "ana@correo.es", from: { email: "reservas@altaria.test", name: "Bar Pepe" } });
			expect(m.text).toContain(json.codigo);
			// Ni el nombre, ni el teléfono, ni la nota: sólo datos estructurados.
			for (const p of ["Ana", "600112233", "600 112 233", "bebé"]) {
				expect(m.text, p).not.toContain(p);
				expect(m.html, p).not.toContain(p);
			}
			// El enlace, con el token en el fragmento, abre la página de cancelar de esta reserva.
			const linea = String(m.text)
				.split("\n")
				.find((l) => l.startsWith("Cancelar la reserva: "));
			const enlace = new URL(linea!.slice("Cancelar la reserva: ".length));
			expect(enlace.pathname).toBe("/reservas-web/v1/w/rw_AAAAAAAAAAAAAAAAAAAAAA/cancelar");
			const token = enlace.hash.slice("#t=".length);
			expect((await pedir("/reserva", { token })).json).toMatchObject({ ok: true, dia: DIA, hora: "21:00", estado: "confirmada" });
		});
	});

	it("POST /reservas: si el correo no sale, la reserva sigue y la respuesta lo dice", async () => {
		await conNegocio("publico-reservar-sin-correo", async (sql) => {
			correoCaido = true;
			const { status, json } = await pedir("/reservas", ALTA_WEB);
			expect(status).toBe(200);
			expect(json).toMatchObject({ ok: true, correo_enviado: false });
			expect(sql.exec(`SELECT COUNT(*) AS n FROM peticiones;`).toArray()[0]).toEqual({ n: 1 });
		});
	});

	it("POST /reservas: lo que no valida es un 400 y no llega a la agenda", async () => {
		await conNegocio("publico-reservar-invalido", async (sql) => {
			// Con los nombres de dentro (`dia_ymd`, `email`) tampoco: la entrada pública es la de los nombres públicos.
			for (const malo of [{ ...ALTA_WEB, correo: "no-es-correo" }, { ...ALTA_WEB, personas: "2" }, { ...ALTA_WEB, nombre: { toString: null } }, ALTA]) {
				expect((await pedir("/reservas", malo)).status).toBe(400);
			}
			expect(sql.exec(`SELECT COUNT(*) AS n FROM peticiones;`).toArray()[0]).toEqual({ n: 0 });
		});
	});

	it("POST /reserva y /cancelar: con el token del correo", async () => {
		await conNegocio("publico-cancelar", async () => {
			const alta = await pedir("/reservas", ALTA_WEB);
			expect(enviados.map((m) => m.subject)).toEqual(["Reserva confirmada en Bar Pepe"]);
			const token = tokenDelCorreo(enviados[0]);
			enviados.length = 0;
			const resumen = await pedir("/reserva", { token });
			expect(resumen.json).toEqual({
				ok: true,
				dia: DIA,
				hora: "21:00",
				personas: 2,
				mesa: "m2",
				mesa_nombre: "2",
				estado: "confirmada",
				cancelable: true,
			});

			expect((await pedir("/cancelar", { token })).json).toEqual({ ok: true });
			expect((await pedir("/reserva", { token })).json.estado).toBe("cancelada");
			// El correo de «has cancelado», a su dirección; cancelar otra vez no lo repite.
			expect(enviados.map((m) => [m.to, m.subject])).toEqual([["ana@correo.es", "Reserva cancelada en Bar Pepe"]]);
			expect(enviados[0].text).toContain(alta.json.codigo);
			expect(enviados[0].text).not.toContain("600112233");
			await pedir("/cancelar", { token });
			expect(enviados).toHaveLength(1);
			expect(await pedir("/cancelar", { token: "inventado" })).toMatchObject({ status: 404, json: { error: "enlace_no_valido" } });
			// Sin token, la petición está mal hecha.
			expect((await pedir("/cancelar", {})).status).toBe(400);
		});
	});

	it("POST /reservas con la mesa automática: la de menos plazas en la que caben; sin ninguna, `sin_mesa_libre`", async () => {
		await conNegocio("publico-reservar-auto", async (sql) => {
			const auto = (correo: string, personas = 2) => pedir("/reservas", { ...ALTA_WEB, mesa: "auto", personas, correo });
			// Para 2 valen la de 2 y la de 4: se queda la de 2, y la de 4 sigue libre para un grupo.
			expect((await auto("a@correo.es")).json).toMatchObject({ ok: true, mesa: "m2", mesa_nombre: "2" });
			expect((await auto("b@correo.es")).json).toMatchObject({ ok: true, mesa: "m4", mesa_nombre: "4" });
			// La de 8 no es reservable: no queda ninguna.
			expect(await auto("c@correo.es")).toMatchObject({ status: 409, json: { ok: false, error: "sin_mesa_libre" } });
			// A la Main le llega la mesa asignada, nunca «auto».
			const mesas = sql.exec(`SELECT id_mesa FROM peticiones ORDER BY creada_ms, id_peticion;`).toArray().map((r: any) => r.id_mesa);
			expect(mesas.sort()).toEqual(["m2", "m4"]);
		});
	});

	it("POST /reservas con la mesa automática para 4: la de 2 no vale, la de 4 sí", async () => {
		await conNegocio("publico-reservar-auto-grupo", async () => {
			expect((await pedir("/reservas", { ...ALTA_WEB, mesa: "auto", personas: 4 })).json).toMatchObject({ ok: true, mesa: "m4" });
		});
	});

	it("POST /reservas: dos altas automáticas a la vez no se llevan la misma mesa", async () => {
		await conNegocio("publico-reservar-auto-a-la-vez", async () => {
			const [a, b, c] = await Promise.all(
				["a@correo.es", "b@correo.es", "c@correo.es"].map((correo) => pedir("/reservas", { ...ALTA_WEB, mesa: "auto", correo })),
			);
			const bien = [a, b, c].filter((r) => r.status === 200).map((r) => r.json.mesa);
			expect(bien.sort()).toEqual(["m2", "m4"]);
			expect([a, b, c].filter((r) => r.status === 409).map((r) => r.json.error)).toEqual(["sin_mesa_libre"]);
		});
	});
});

describe("el tope de altas por conexión y el correo de cancelar (RW-ALTAS)", () => {
	it("desde una IP, la alta n.º 11 da 429 con su código; desde otra IP entra", async () => {
		await conNegocio("publico-conexion-ipv4", async () => {
			for (let i = 0; i < MAX_ALTAS_DIA_CONEXION; i++) {
				expect((await altaDesde("198.51.100.7", altaN(i))).status, `alta ${i}`).toBe(200);
			}
			expect(await altaDesde("198.51.100.7", altaN(10))).toEqual({
				status: 429,
				json: { ok: false, error: "tope_reservas_conexion" },
			});
			expect(eventos.at(-1)).toEqual({ event: "reserva_web_rechazo", tenant_id: "t1", motivo: "tope_reservas_conexion" });
			// La de al lado es otra conexión.
			expect((await altaDesde("198.51.100.8", altaN(10))).status).toBe(200);
			// Las diez confirmaciones y la de la otra IP; la rechazada no gasta correo.
			expect(enviados).toHaveLength(MAX_ALTAS_DIA_CONEXION + 1);
		});
	});

	it("en IPv6 cuentan juntas las del mismo /64, y las de otro /64 no", async () => {
		await conNegocio("publico-conexion-ipv6", async () => {
			for (let i = 0; i < MAX_ALTAS_DIA_CONEXION; i++) {
				// Cada una con una dirección distinta del mismo /64, escrita de una forma distinta.
				const ip = i % 2 ? `2001:db8:1:2::${(i + 1).toString(16)}` : `2001:0DB8:0001:0002:${i + 1}:0:0:1`;
				expect((await altaDesde(ip, altaN(i))).status, `alta ${i} desde ${ip}`).toBe(200);
			}
			expect((await altaDesde("2001:db8:1:2:abcd:ef01:2345:6789", altaN(10))).json.error).toBe("tope_reservas_conexion");
			expect((await altaDesde("2001:db8:1:3::1", altaN(10))).status).toBe(200);
		});
	});

	it("en IPv6 tampoco se esquiva cambiando de /64 dentro del mismo /48: su red tiene su tope, y otra red entra", async () => {
		await conNegocio("publico-conexion-red-ipv6", async (sql) => {
			// Cada alta en su día: hacen falta más que los 30 que se admiten por defecto.
			sql.exec(`UPDATE Business_Settings SET Reserva_Web_Dias_Max = 60 WHERE ID = 1;`);
			// Diez de cada /64, en tres /64 del mismo /48: ninguno pasa de su tope de conexión.
			expect(MAX_ALTAS_DIA_RED).toBe(30);
			for (let i = 0; i < MAX_ALTAS_DIA_RED; i++) {
				const ip = `2001:db8:1:${Math.floor(i / 10) + 10}::${(i + 1).toString(16)}`;
				expect((await altaDesde(ip, altaN(i))).status, `alta ${i} desde ${ip}`).toBe(200);
			}
			// Un /64 nuevo del mismo /48 ya no entra; uno de otro /48, sí.
			expect(await altaDesde("2001:db8:1:ffff::1", altaN(MAX_ALTAS_DIA_RED))).toEqual({
				status: 429,
				json: { ok: false, error: "tope_reservas_conexion" },
			});
			expect((await altaDesde("2001:db8:2:ffff::1", altaN(MAX_ALTAS_DIA_RED))).status).toBe(200);
		});
	});

	it("reservar y cancelar en bucle desde una IP se corta, con los correos que lleva cada vuelta", async () => {
		await conNegocio("publico-conexion-bucle", async () => {
			for (let i = 0; i < MAX_ALTAS_DIA_CONEXION; i++) {
				enviados.length = 0;
				expect((await altaDesde("203.0.113.9", { ...ALTA_WEB, correo: `ciclo${i}@correo.test` })).status, `alta ${i}`).toBe(200);
				const token = tokenDelCorreo(enviados[0]);
				expect((await pedir("/cancelar", { token })).json).toEqual({ ok: true });
				expect(enviados.map((m) => m.subject)).toEqual(["Reserva confirmada en Bar Pepe", "Reserva cancelada en Bar Pepe"]);
			}
			enviados.length = 0;
			expect((await altaDesde("203.0.113.9", { ...ALTA_WEB, correo: "otra@correo.test" })).status).toBe(429);
			expect(enviados).toEqual([]);
		});
	});

	it("la IP no queda en claro en la agenda: sólo su huella, que cambia de un negocio a otro", async () => {
		await conNegocio("publico-conexion-sin-ip", async (sql, _motor, central) => {
			expect((await altaDesde("192.0.2.77", ALTA_WEB)).status).toBe(200);
			const huellas = sql.exec(`SELECT conexion_hash AS h FROM altas_por_conexion;`).toArray() as any[];
			expect(huellas).toHaveLength(1);
			expect(huellas[0].h).toBe((await huellasDeLaConexion(ENV as any, "t1", "192.0.2.77"))!.conexion);
			expect(huellas[0].h).not.toBe((await huellasDeLaConexion(ENV as any, "t2", "192.0.2.77"))!.conexion);
			// Una IPv6 deja dos: la de su /64 y la de su /48, y ninguna lleva la dirección.
			expect((await altaDesde("2001:db8:aaaa:bbbb::7", { ...ALTA_WEB, mesa: "m4", correo: "otra@correo.es" })).status).toBe(200);
			const v6 = (await huellasDeLaConexion(ENV as any, "t1", "2001:db8:aaaa:bbbb::7"))!;
			const nuevas = (sql.exec(`SELECT conexion_hash AS h FROM altas_por_conexion;`).toArray() as any[]).map((f) => f.h);
			expect(nuevas.sort()).toEqual([huellas[0].h, v6.conexion, v6.red].sort());
			// En ninguna tabla del objeto, ni entera ni a medias.
			const tablas = sql
				.exec(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%';`)
				.toArray()
				.map((t: any) => String(t.name));
			expect(tablas).toContain("altas_por_conexion");
			for (const tabla of tablas) {
				const texto = JSON.stringify(sql.exec(`SELECT * FROM "${tabla}";`).toArray());
				expect(texto, tabla).not.toContain("192.0.2");
				expect(texto, tabla).not.toMatch(/2001:db8|aaaa:bbbb/i);
			}
			// Ni en la base central (los correos que han salido).
			for (const [tabla, filas] of Object.entries(await fotoDeLaCentral(central))) {
				const texto = JSON.stringify(filas);
				expect(texto, tabla).not.toContain("192.0.2");
				expect(texto, tabla).not.toMatch(/2001:db8|aaaa:bbbb/i);
			}
		});
	});

	it("cancelar una reserva cuya confirmación no salió no manda correo ni gasta cupo", async () => {
		await conNegocio("publico-cancelar-sin-confirmacion", async (_sql, motor, central) => {
			// Apuntada sin pasar por la ruta: no ha salido ningún correo.
			const hecha = await motor.reservar({ tenantId: "t1", alta: ALTA });
			expect((await pedir("/cancelar", { token: hecha.token })).json).toEqual({ ok: true });
			expect((await pedir("/reserva", { token: hecha.token })).json.estado).toBe("cancelada");
			expect(enviados).toEqual([]);
			expect(await filasDe(central, `SELECT COUNT(*) AS n FROM email_sends;`)).toEqual([{ n: 0 }]);
		});
	});

	it("cancelar una reserva cuya confirmación falló en el binding tampoco manda el «has cancelado»", async () => {
		await conNegocio("publico-cancelar-confirmacion-fallida", async (_sql, motor, central) => {
			const hecha = await motor.reservar({ tenantId: "t1", alta: ALTA });
			await filasDe(
				central,
				`INSERT INTO email_sends (id, tenant_id, device_id, to_email, proveedor, ok, error_code, sent_at_ms, tipo)
				 VALUES (?, 't1', 'web', 'ana@correo.es', NULL, 0, 'E_INTERNAL', ?, 'reserva_web');`,
				`rw:confirmacion:${hecha.id_reserva}`,
				Date.now(),
			);
			expect((await pedir("/cancelar", { token: hecha.token })).json).toEqual({ ok: true });
			expect(enviados).toEqual([]);
			expect(await filasDe(central, `SELECT COUNT(*) AS n FROM email_sends;`)).toEqual([{ n: 1 }]);
		});
	});

	it("cancelar con el enlace del correo de un cambio del restaurante sí avisa, aunque la confirmación no saliera", async () => {
		await conNegocio("publico-cancelar-con-enlace-de-un-cambio", async (_sql, motor, central) => {
			// Apuntada sin confirmación; después el restaurante la cambia, y el correo que se lo cuenta
			// (lo pide la Main) lleva un enlace de cancelar nuevo.
			const hecha = await motor.reservar({ tenantId: "t1", alta: ALTA });
			const cambio = await motor.enlaceParaUnCambio({ tenantId: "t1", id_reserva: hecha.id_reserva, dia: DIA, hora: "21:00" });
			expect(cambio.token).toBeTruthy();
			expect((await pedir("/cancelar", { token: cambio.token })).json).toEqual({ ok: true });
			expect(enviados.map((m) => [m.to, m.subject])).toEqual([["ana@correo.es", "Reserva cancelada en Bar Pepe"]]);
			expect(await filasDe(central, `SELECT id FROM email_sends;`)).toEqual([{ id: `rw:cancelacion:${hecha.id_reserva}` }]);
		});
	});

	it("una reserva apuntada hace más de lo que se guarda la traza de los correos sí avisa al cancelar", async () => {
		await conNegocio("publico-cancelar-reserva-antigua", async (sql) => {
			// Un alta apuntada hace 100 días para dentro de unos días, con su enlace: la traza de su
			// confirmación ya se habría purgado, y no se puede saber si salió.
			const hace100Dias = Date.now() - 100 * 86_400_000;
			const hex = hace100Dias.toString(16).padStart(12, "0");
			const idReserva = `${hex.slice(0, 8)}-${hex.slice(8)}-7abc-8def-0123456789ab`;
			expect(msDelId(idReserva)).toBe(hace100Dias);
			sql.exec(
				`INSERT INTO peticiones (id_peticion, tipo, id_reserva, id_mesa, dia_ymd, hora, comensales, email_hash, datos_json,
				                         creada_local, creada_ms, estado)
				 VALUES ('p-antigua', 'alta', ?, 'm2', ?, '21:00', 2, 'x', ?, ?, ?, 'pendiente');`,
				idReserva,
				DIA,
				JSON.stringify({ nombre: "Ana", email: "ana@correo.es", telefono: "600112233", nota: null }),
				AHORA,
				hace100Dias,
			);
			const token = "AAAAAAAAAAAAAAAAAAAAAA";
			sql.exec(
				`INSERT INTO enlaces (token_hash, id_reserva, caduca_ms) VALUES (?, ?, ?);`,
				await sha256HexStr(token),
				idReserva,
				Date.now() + 10 * 86_400_000,
			);
			expect((await pedir("/cancelar", { token })).json).toEqual({ ok: true });
			expect(enviados.map((m) => [m.to, m.subject])).toEqual([["ana@correo.es", "Reserva cancelada en Bar Pepe"]]);
			expect(enviados[0].text).toContain(codigoDeReserva(idReserva));
		});
	});
});
