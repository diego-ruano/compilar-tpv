// test/reservasWebAvisos.test.ts
//
// Reservas desde la web (docs/estudios/reservas-web.md §4.5 y §5.7): el correo al cliente cuando el
// restaurante cambia o cancela su reserva (`POST /v1/reservas-web/avisos`). Lo que se fija:
//   · el destinatario es el cliente de esa reserva en la nube, y sólo de una reserva web;
//   · una reserva que aún no ha subido es un 404, para que la Main lo repita;
//   · el mismo aviso no manda dos correos, y uno que no salió se puede repetir;
//   · lo que llega en el cuerpo tiene su forma y su tope: sale en un correo de nuestro dominio.

import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

import { crearEsquemaTenant } from "./helpers/esquemaTenant";
import { clienteSobre } from "./helpers/clienteSql";
import { enLaAgenda } from "./helpers/agenda";
import { prepararPlanoDeControl } from "./helpers/planoDeControl";

/** La base del negocio y la central de la prueba en curso, en el mismo SQLite. */
let base: any = null;

vi.mock("../src/middleware/tenant", async (original) => ({
	...(await (original as any)()),
	tenantAuth: async (c: any, next: any) => {
		c.set("tenantId", "t1");
		c.set("deviceId", "dev-main");
		await next();
	},
}));

vi.mock("../src/lib/tenantClient", async (original) => ({
	...(await (original as any)()),
	tenantQuery: (_c: any, fn: any) => fn(base),
}));

vi.mock("../src/server/db", async (original) => ({
	...(await (original as any)()),
	getDb: () => base,
}));

const { reservasWebMainRoutes } = await import("../src/domains/reservas_web/main.routes");
const { avisoReservaWebSchema } = await import("../src/domains/reservas_web/reservasWeb.schemas");
const { codigoDeReserva } = await import("../src/durableObjects/agendaWeb.motor");
const { sha256HexStr } = await import("../src/server/utils/crypto");

const app = new Hono();
app.route("/v1/reservas-web", reservasWebMainRoutes);

const enviados: any[] = [];
let correoCaido = false;
const ENV = {
	EMAIL_RESERVAS_FROM_ADDRESS: "reservas@altaria.test",
	EMAIL: {
		send: async (m: any) => {
			if (correoCaido) throw Object.assign(new Error("caído"), { code: "E_INTERNAL" });
			enviados.push(m);
		},
	},
};

const ID = "0199aa00-0000-7000-8000-00000000abcd";
/** SHA-256 de «ana@correo.es»: el mismo valor fija `tpv_domain::reservas_web::huella_de_correo`. */
const HUELLA_ANA = "80ec301799f952e798d6387318dc4616444dc00c3963ed5c1845cf85c0e60758";

function aviso(extra: Record<string, unknown> = {}) {
	return {
		id_aviso: "0199aa00-0000-7000-8000-0000000a0001",
		id_reserva: ID,
		tipo: "modificada",
		dia_ymd: "2026-10-24",
		hora: "22:00",
		personas: 4,
		mesa: "Mesa 7",
		id_cliente: "c1",
		huella_correo: HUELLA_ANA,
		...extra,
	};
}

async function mandar(cuerpo: unknown) {
	const res = await app.request(
		"/v1/reservas-web/avisos",
		{ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(cuerpo) },
		ENV as any,
	);
	return { status: res.status, json: (await res.json()) as any };
}

async function conNegocio(nombre: string, prueba: (sql: SqlStorage) => Promise<void>) {
	await enLaAgenda(`avisos-${nombre}`, async (_motor, state) => {
		const sql = state.storage.sql;
		crearEsquemaTenant(sql);
		prepararPlanoDeControl(sql);
		sql.exec(`UPDATE Business_Settings SET Business_Name = 'Bar Pepe', Telefono = '950 000 000' WHERE ID = 1;`);
		sql.exec(`INSERT INTO Clientes (ID_Cliente, Nombre, Email, Telefono) VALUES ('c1', 'Ana', 'ana@correo.es', '600112233');`);
		base = clienteSobre(sql, state.storage);
		enviados.length = 0;
		correoCaido = false;
		try {
			await prueba(sql);
		} finally {
			base = null;
		}
	});
}

function reserva(sql: SqlStorage, origen: "WEB" | "TPV", cliente: string | null = "c1") {
	sql.exec(
		`INSERT INTO Reservas (ID_Reserva, ID_Cliente, Dia_YMD, Hora, Turno, Comensales, Estado, Origen)
		 VALUES (?, ?, '2026-10-24', '21:00', 'CENA', 2, 'PROXIMA', ?);`,
		ID,
		cliente,
		origen,
	);
}

describe("el aviso al cliente de un cambio del restaurante", () => {
	it("va al cliente de la reserva web, con los datos de después del cambio; repetido, no manda otro", async () => {
		await conNegocio("modificada", async (sql) => {
			reserva(sql, "WEB");
			expect(await mandar(aviso())).toEqual({ status: 200, json: { ok: true, enviado: true } });
			expect(enviados).toHaveLength(1);
			expect(enviados[0]).toMatchObject({ to: "ana@correo.es", subject: "Tu reserva en Bar Pepe ha cambiado" });
			for (const t of ["sábado, 24 de octubre de 2026", "22:00", "4 personas", "Mesa 7", codigoDeReserva(ID)]) {
				expect(enviados[0].text).toContain(t);
			}
			// Ni el nombre ni el teléfono del cliente.
			expect(enviados[0].text).not.toContain("Ana");
			expect(enviados[0].text).not.toContain("600112233");

			expect((await mandar(aviso())).json).toEqual({ ok: true, enviado: true });
			expect(enviados).toHaveLength(1);
			// Uno distinto, sí.
			await mandar(aviso({ id_aviso: "0199aa00-0000-7000-8000-0000000a0002", tipo: "cancelada" }));
			expect(enviados.map((m) => m.subject)).toEqual(["Tu reserva en Bar Pepe ha cambiado", "Tu reserva en Bar Pepe se ha cancelado"]);
			const traza = sql.exec(`SELECT id, device_id, tipo FROM email_sends ORDER BY id;`).toArray();
			expect(traza).toEqual([
				{ id: "rw:aviso:0199aa00-0000-7000-8000-0000000a0001", device_id: "dev-main", tipo: "reserva_web" },
				{ id: "rw:aviso:0199aa00-0000-7000-8000-0000000a0002", device_id: "dev-main", tipo: "reserva_web" },
			]);
		});
	});

	it("una reserva que aún no está en la nube es un 404: se repite más tarde", async () => {
		await conNegocio("no-esta", async () => {
			expect(await mandar(aviso())).toMatchObject({ status: 404, json: { error: "reserva_inexistente" } });
			expect(enviados).toEqual([]);
		});
	});

	it("si la nube aún tiene otro cliente en la reserva, espera: no le cuenta la reserva a otra persona", async () => {
		await conNegocio("otro-cliente", async (sql) => {
			sql.exec(`INSERT INTO Clientes (ID_Cliente, Nombre, Email) VALUES ('c2', 'Luis', 'luis@correo.es');`);
			reserva(sql, "WEB");
			// La Main ya se la ha pasado a Luis (c2), pero eso aún no ha subido.
			const deLuis = { id_cliente: "c2", huella_correo: await sha256HexStr("luis@correo.es") };
			expect(await mandar(aviso(deLuis))).toMatchObject({ status: 404, json: { error: "reserva_no_al_dia" } });
			expect(enviados).toEqual([]);
			// Cuando sube, sale, y a Luis.
			sql.exec(`UPDATE Reservas SET ID_Cliente = 'c2' WHERE ID_Reserva = ?;`, ID);
			expect((await mandar(aviso(deLuis))).json).toEqual({ ok: true, enviado: true });
			expect(enviados.map((m) => m.to)).toEqual(["luis@correo.es"]);
		});
	});

	it("si la nube aún tiene el correo de antes del cliente, espera: no escribe a una dirección que ya no es suya", async () => {
		await conNegocio("otro-correo", async (sql) => {
			reserva(sql, "WEB");
			// En la Main se corrigió el correo de Ana, pero eso aún no ha subido.
			const corregido = { huella_correo: await sha256HexStr("ana.bien@correo.es") };
			expect(await mandar(aviso(corregido))).toMatchObject({ status: 404, json: { error: "reserva_no_al_dia" } });
			// Y si la Main se lo quitó y aquí aún lo tiene, tampoco.
			expect(await mandar(aviso({ huella_correo: null }))).toMatchObject({ status: 404 });
			expect(enviados).toEqual([]);
			sql.exec(`UPDATE Clientes SET Email = 'ana.bien@correo.es' WHERE ID_Cliente = 'c1';`);
			expect((await mandar(aviso(corregido))).json).toEqual({ ok: true, enviado: true });
			expect(enviados.map((m) => m.to)).toEqual(["ana.bien@correo.es"]);
		});
	});

	it("una reserva del TPV no se avisa: no hay correo de nadie que haya reservado por la web", async () => {
		await conNegocio("del-tpv", async (sql) => {
			reserva(sql, "TPV");
			expect(await mandar(aviso())).toMatchObject({ status: 409, json: { error: "reserva_no_web" } });
			expect(enviados).toEqual([]);
		});
	});

	it("sin correo del cliente no hay a quién decírselo, y no es un error", async () => {
		await conNegocio("sin-correo", async (sql) => {
			reserva(sql, "WEB", null);
			expect(await mandar(aviso({ id_cliente: null, huella_correo: null }))).toEqual({ status: 200, json: { ok: true, enviado: false } });
		});
	});

	it("si el correo no sale, se dice para que se repita, y al repetirlo sale", async () => {
		await conNegocio("caido", async (sql) => {
			reserva(sql, "WEB");
			correoCaido = true;
			expect(await mandar(aviso())).toMatchObject({ status: 502, json: { error: "correo_no_enviado" } });
			correoCaido = false;
			expect((await mandar(aviso())).json).toEqual({ ok: true, enviado: true });
			expect(enviados).toHaveLength(1);
		});
	});

	it("si ese aviso está saliendo por otro lado, se dice para que se repita: no se da por hecho", async () => {
		await conNegocio("en-curso", async (sql) => {
			reserva(sql, "WEB");
			sql.exec(
				`INSERT INTO email_sends (id, tenant_id, device_id, to_email, ok, error_code, sent_at_ms, tipo)
				 VALUES ('rw:aviso:0199aa00-0000-7000-8000-0000000a0001', 't1', 'dev-main', 'ana@correo.es', 0, 'enviando', ?, 'reserva_web');`,
				Date.now(),
			);
			expect(await mandar(aviso())).toMatchObject({ status: 503, json: { error: "correo_en_curso" } });
			expect(enviados).toEqual([]);
		});
	});

	it("lo que no tiene su forma no pasa", () => {
		const bueno = avisoReservaWebSchema.safeParse(aviso({ mesa: null, hora: "21:30:00" }));
		expect(bueno.success).toBe(true);
		expect(bueno.data).toMatchObject({ mesa: null, hora: "21:30" });
		for (const malo of [
			aviso({ id_aviso: "corto" }),
			aviso({ id_aviso: "<script>alert(1)</script>" }),
			aviso({ tipo: "borrada" }),
			aviso({ dia_ymd: "2026-02-31" }),
			aviso({ hora: "25:00" }),
			aviso({ personas: 0 }),
			aviso({ personas: "4" }),
			aviso({ mesa: "Mesa 7\nVisita https://otra.web" }),
			aviso({ mesa: "x".repeat(61) }),
			aviso({ huella_correo: "ana@correo.es" }),
		]) {
			expect(avisoReservaWebSchema.safeParse(malo).success, JSON.stringify(malo).slice(0, 90)).toBe(false);
		}
	});
});
