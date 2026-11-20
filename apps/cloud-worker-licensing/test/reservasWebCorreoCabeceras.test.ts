// test/reservasWebCorreoCabeceras.test.ts
//
// AUD-40 · Lo que va a una cabecera de los correos de la reserva web sale en una línea.
//
// El nombre del negocio llega al asunto y al remitente tal como está en la base, y ahí lo deja quien
// escribe Business_Settings: una Handy por `PATCH /v1/configuracion/business` (la ruta no veta el rol)
// o la Main, que sube su propio SQL por la réplica. Con un CR/LF dentro, el asunto salía partido y el
// negocio escribía cabeceras en correos de nuestro dominio a quien reservara en su web. Se limpia
// donde se compone el correo, no al guardar: lo que la Main sube no pasa por ninguna validación.
//
// Y la dirección: la del alta la escribe un visitante cualquiera. Una con un salto de línea, o una
// lista, no es una dirección: el alta no entra (AUD-39), y si llegara al correo, no se envía.
//
// De punta a punta: el nombre lo fija una Handy por la ruta real y el TenantHub real; la
// confirmación la dispara un visitante por la ruta pública, sobre la agenda de verdad (la puerta
// —clave, Turnstile, limitador— se deja pasar como en `reservasWebPublico.test.ts`).

import { env as entorno } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

import { enLaAgenda, lectorSobre } from "./helpers/agenda";
import { clienteSobre } from "./helpers/clienteSql";
import { crearEsquemaTenant } from "./helpers/esquemaTenant";
import { enElHub } from "./helpers/hub";
import { prepararPlanoDeControl } from "./helpers/planoDeControl";
import { sumarDias } from "../src/domains/reservas_web/disponibilidad";
import { horaLocalEn } from "../src/domains/reservas_web/horaDelNegocio";

/** La base central de la prueba en curso (`email_sends`). Sin ella, nadie debería preguntarle nada. */
let baseCentral: any = null;
let preguntasSinBase = 0;

vi.mock("../src/server/db", async (original) => ({
	...(await (original as any)()),
	getDb: () =>
		baseCentral ?? {
			execute: async () => {
				preguntasSinBase++;
				throw new Error("no hay base central en este paso");
			},
		},
}));

// Lo que deja la autenticación real (token + prueba del equipo + licencia) para una Handy.
vi.mock("../src/middleware/tenant", async (original) => ({
	...(await (original as any)()),
	tenantAuth: async (c: any, next: any) => {
		c.set("tenantId", "aud40-tenant");
		c.set("deviceId", "aud40-handy");
		c.set("token", "jwt-ficticio");
		c.set("licHash", "lic-ficticia");
		await next();
	},
}));

/** La agenda y el lector de la prueba pública en curso: los mocks de abajo los leen al llamarse. */
let enCurso: { motor: any; leer: any } | null = null;

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

vi.mock("../src/observability/axiom", async (importOriginal) => {
	const original = await importOriginal<typeof import("../src/observability/axiom")>();
	return { ...original, reportarReservaWeb: () => Promise.resolve() };
});

vi.mock("../src/durableObjects/agendaWeb", async (importOriginal) => {
	const original = await importOriginal<typeof import("../src/durableObjects/agendaWeb")>();
	return { ...original, agendaDe: () => enCurso!.motor };
});

const { configuracionRoutes } = await import("../src/domains/configuracion/configuracion.routes");
const { reservasWebPublicoRoutes } = await import("../src/domains/reservas_web/publico.routes");
const { negocioDelCorreo, enviarCorreoReservaWeb } = await import("../src/domains/reservas_web/correos");

/** Lo que manda la Handy: el salto del final lo quita `recortar`, los de dentro llegaban al asunto. */
const NOMBRE_CON_SALTOS = "Bar Pepe\r\nBcc: x@prueba.test\r\nX-Prueba: 1\r\n";

/** Ninguna cabecera de lo que sale lleva un salto de línea ni otro carácter de control. */
function sinSaltos(m: any) {
	for (const v of [m.subject, m.from?.name, m.to, m.replyTo]) {
		if (v !== undefined) expect(String(v)).not.toMatch(/[\p{Cc}\u2028\u2029]/u);
	}
}

describe("AUD-40 · el nombre del negocio que deja una Handy", () => {
	it("se guarda como llega, pero el correo sale con el asunto y el remitente en una línea", async () => {
		// La Handy cambia el nombre por la ruta real; el TenantHub, con una Main conectada.
		await enElHub("aud40-tenant", (motor: any) => {
			const sql = motor.state.storage.sql;
			crearEsquemaTenant(sql);
			const db = clienteSobre(sql, motor.state.storage);
			motor.withTenantDbRetry = async (_t: string, run: any) => run(db);
			motor.getTenantDb = async () => db;
			motor.touchLastSeen = async () => {};
			motor.maybePurgeSyncLog = async () => {};
			motor.isMainConnected = () => true;
			motor.isMainReady = () => true;
		});
		const app = new Hono();
		app.route("/v1/configuracion", configuracionRoutes);
		const respuesta = await app.request(
			"/v1/configuracion/business",
			{
				method: "PATCH",
				headers: {
					"content-type": "application/json",
					"X-Idempotency-Key": crypto.randomUUID(),
					"X-Client-Now": new Date().toISOString().slice(0, 19).replace("T", " "),
				},
				body: JSON.stringify({ patch: { business_name: NOMBRE_CON_SALTOS } }),
			},
			entorno,
		);
		expect(respuesta.status).toBe(200);

		// Guardar no lo limpia (la Main sube su propio SQL, que tampoco pasaría por aquí): lo que lee
		// el correo lleva los saltos de dentro.
		const negocio = await enElHub("aud40-tenant", async (motor: any) => {
			const sql = motor.state.storage.sql;
			expect(sql.exec(`SELECT Business_Name AS n FROM Business_Settings WHERE ID = 1;`).one().n).toBe(NOMBRE_CON_SALTOS);
			return negocioDelCorreo(clienteSobre(sql, motor.state.storage) as any);
		});
		expect(negocio.nombre).toBe("Bar Pepe\r\nBcc: x@prueba.test\r\nX-Prueba: 1");
		expect(preguntasSinBase).toBe(0);

		// El envío.
		const enviados: any[] = [];
		const r = await enElHub("aud40-central", async (hub: any) => {
			const sql = hub.state.storage.sql;
			prepararPlanoDeControl(sql);
			baseCentral = clienteSobre(sql, hub.state.storage);
			try {
				return await enviarCorreoReservaWeb(
					{
						EMAIL_RESERVAS_FROM_ADDRESS: "reservas@altaria.test",
						EMAIL: { send: async (m: any) => void enviados.push(m) },
					} as any,
					{
						tenantId: "aud40-tenant",
						id: "rw:confirmacion:aud40",
						tipo: "confirmacion",
						para: "ana@correo.test",
						negocio,
						reserva: { dia: "2026-11-20", hora: "21:00", personas: 2, mesa: "7", codigo: "ABC123" },
						enlace: "https://tpv-api.test/reservas-web/v1/w/rw_X/cancelar#t=TOKEN",
						dispositivo: "web",
					},
				);
			} finally {
				baseCentral = null;
			}
		});
		expect(r).toBe("enviado");
		expect(enviados).toHaveLength(1);
		sinSaltos(enviados[0]);
		expect(enviados[0].subject).toBe("Reserva confirmada en Bar Pepe Bcc: x@prueba.test X-Prueba: 1");
		expect(enviados[0].from.name).toBe("Bar Pepe Bcc: x@prueba.test X-Prueba: 1");
		expect(enviados[0].to).toBe("ana@correo.test");
	});
});

const AHORA = horaLocalEn("Europe/Madrid", Date.now());
const DIA = sumarDias(AHORA.slice(0, 10), 3);
const BASE = "/v1/publico/reservas/rw_AAAAAAAAAAAAAAAAAAAAAA";

const publico = new Hono();
publico.route("/v1/publico/reservas", reservasWebPublicoRoutes);
const enviadosWeb: any[] = [];
const ENV_WEB = {
	...(entorno as any),
	TURNSTILE_SITE_KEY: "0xPRUEBA",
	EMAIL_RESERVAS_FROM_ADDRESS: "reservas@altaria.test",
	EMAIL: { send: async (m: any) => void enviadosWeb.push(m) },
};

async function conNegocio(nombre: string, prueba: (sql: SqlStorage) => Promise<void>) {
	await enLaAgenda(nombre, async (motor, state) => {
		const sql = state.storage.sql;
		crearEsquemaTenant(sql);
		// El nombre, como lo dejaría la Handy (o la Main) del negocio.
		sql.exec(
			`UPDATE Business_Settings SET Reserva_Web_Activa = 1, Business_Name = ?, Telefono = '950 000 000' WHERE ID = 1;`,
			"Bar Pepe\r\nBcc: x@prueba.test\r\nX-Prueba: 1",
		);
		sql.exec(`INSERT INTO Zonas (ID_Zona, Nombre_Zona, Room_Points) VALUES ('z1', 'Salon', '[[0,0],[10,0]]');`);
		sql.exec(
			`INSERT INTO Mesas (ID_Mesa, ID_Zona, Numero_Mesa, Capacidad, Ubicacion_X, Ubicacion_Y, Shape, Width, Height, Radius)
			 VALUES ('m2', 'z1', '2', 2, 10, 20, 'round', 80, 80, 40);`,
		);
		sql.exec(`INSERT INTO Reserva_Web_Mesas (ID_Mesa, Activa) VALUES ('m2', 1);`);
		sql.exec(
			`INSERT INTO Reserva_Web_Franjas (ID_Franja, ID_Mesa, Dias_Semana, Hora_Desde, Hora_Hasta)
			 VALUES ('f-m2', 'm2', 127, '20:00', '23:30');`,
		);
		const leer = lectorSobre(state, () => AHORA);
		motor.leer = leer;
		enCurso = { motor, leer };
		prepararPlanoDeControl(sql);
		baseCentral = clienteSobre(sql, state.storage);
		enviadosWeb.length = 0;
		try {
			await prueba(sql);
		} finally {
			enCurso = null;
			baseCentral = null;
		}
	});
}

function alta(correo: string, hora = "21:00") {
	return publico.request(
		`${BASE}/reservas`,
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ dia: DIA, hora, personas: 2, mesa: "m2", nombre: "Ana Pérez", correo, telefono: "600 112 233" }),
		},
		ENV_WEB,
	);
}

describe("AUD-40 · la confirmación que dispara un visitante", () => {
	it("sale con el nombre del negocio en una línea", async () => {
		await conNegocio("aud40-publico", async () => {
			const res = await alta("ana@correo.test");
			expect(res.status).toBe(200);
			expect(((await res.json()) as any).correo_enviado).toBe(true);
			expect(enviadosWeb).toHaveLength(1);
			sinSaltos(enviadosWeb[0]);
			expect(enviadosWeb[0].subject).toBe("Reserva confirmada en Bar Pepe Bcc: x@prueba.test X-Prueba: 1");
		});
	});

	// AUD-39: la regla de un correo pedía una arroba, un punto y ningún espacio, y esto pasaba: la
	// reserva se hacía con esa cadena como destinatario. Ahora una sola dirección, o nada.
	for (const [i, [caso, correo]] of ([
		["un salto de línea con otra cabecera", "ana@correo.test\r\nbcc:otro@prueba.test"],
		["una lista", "ana@correo.test,otro@prueba.test"],
		["un nombre y la dirección entre ángulos", "Ana<ana@correo.test>"],
	] as const).entries()) {
		it(`con ${caso} en su correo, ni se reserva ni sale nada (AUD-39)`, async () => {
			await conNegocio(`aud39-publico-${i}`, async (sql) => {
				const res = await alta(correo);
				expect(res.status).toBe(400);
				expect(JSON.stringify(await res.json())).toContain("El correo no es válido");
				expect(sql.exec(`SELECT COUNT(*) AS n FROM peticiones;`).one().n).toBe(0);
				expect(enviadosWeb).toEqual([]);
				expect(sql.exec(`SELECT COUNT(*) AS n FROM email_sends;`).one().n).toBe(0);
			});
		});
	}
});
