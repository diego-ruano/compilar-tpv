// test/purgaBaseCentral.test.ts
//
// La recogida de basura de la base central (`server/purga.ts`).
//
// Las dos tablas que purga las hace crecer alguien de fuera, y ninguna se borraba nunca:
// `pair_claim_fallos` sólo se vaciaba al emparejar BIEN, así que un barrido de códigos dejaba una
// fila permanente por IP —con IPv6, sin techo—, y `email_sends` acumulaba para siempre trazas que
// el tope diario ya no mira pasadas 24 h.
//
// Lo que se comprueba aquí es la mitad que importa: que lo VIVO sobrevive. Un `DELETE` con el
// `WHERE` del revés pasaría igual de bien una prueba que sólo contara lo borrado, y dejaría a
// cualquiera emparejando sin freno.

import { describe, it, expect } from "vitest";

import { clienteSobre } from "./helpers/clienteSql";
import { enElHub } from "./helpers/hub";
import { prepararPlanoDeControl } from "./helpers/planoDeControl";
import {
	purgarBaseCentral,
	RETENCION_ENVIOS_MS,
	RETENCION_FALLOS_MS,
} from "../src/server/purga";

const AHORA = 1_800_000_000_000;

async function escenario<T>(
	nombre: string,
	fn: (e: {
		sql: any;
		db: any;
		fallo: (ip: string, ultimoFalloMs: number, bloqueadoHastaMs?: number) => void;
		envio: (id: string, sentAtMs: number) => void;
		ips: () => string[];
		envios: () => string[];
	}) => Promise<T>,
): Promise<T> {
	return enElHub(`purga-${nombre}`, async (hub: any) => {
		const sql = hub.state.storage.sql;
		prepararPlanoDeControl(sql);
		sql.exec(`DELETE FROM pair_claim_fallos;`);
		sql.exec(`DELETE FROM email_sends;`);

		return fn({
			sql,
			db: clienteSobre(sql, hub.state.storage),
			fallo(ip, ultimoFalloMs, bloqueadoHastaMs = 0) {
				sql.exec(
					`INSERT INTO pair_claim_fallos (ip, fallos, ultimo_fallo_ms, bloqueado_hasta_ms)
					 VALUES (?, 1, ?, ?);`,
					ip,
					ultimoFalloMs,
					bloqueadoHastaMs,
				);
			},
			envio(id, sentAtMs) {
				sql.exec(
					`INSERT INTO email_sends (id, tenant_id, device_id, to_email, proveedor, ok, sent_at_ms)
					 VALUES (?, 'tenant-1', 'dev', 'a@b.test', 'Prov', 1, ?);`,
					id,
					sentAtMs,
				);
			},
			ips: () =>
				sql
					.exec(`SELECT ip FROM pair_claim_fallos ORDER BY ip;`)
					.toArray()
					.map((f: any) => String(f.ip)),
			envios: () =>
				sql
					.exec(`SELECT id FROM email_sends ORDER BY id;`)
					.toArray()
					.map((f: any) => String(f.id)),
		});
	});
}

describe("purga de la base central", () => {
	it("se lleva el rastro de emparejamiento que el propio código ya trata como inexistente", async () => {
		const r = await escenario("fallos", async (e) => {
			// Justo en el borde por los dos lados: la ventana es la misma que el olvido del
			// contador, así que lo que queda es exactamente lo que aún cuenta para un tramo.
			e.fallo("1.1.1.1", AHORA - RETENCION_FALLOS_MS - 1);
			e.fallo("2.2.2.2", AHORA - RETENCION_FALLOS_MS + 1);
			e.fallo("3.3.3.3", AHORA);

			const purgado = await purgarBaseCentral(e.db, AHORA);
			return { ips: e.ips(), purgado };
		});

		expect(r.ips).toEqual(["2.2.2.2", "3.3.3.3"]);
		expect(r.purgado.fallosDeEmparejamiento).toBe(1);
	});

	it("una IP castigada ahora mismo no se libera por purgar", async () => {
		// El bloqueo más largo son 30 min y la ventana 24 h, así que esto no puede pasar hoy. Se
		// prueba porque alargar un tramo por encima de la retención SÍ lo abriría, y el síntoma
		// sería que esperar al cron te quita el castigo.
		const ips = await escenario("castigada", async (e) => {
			e.fallo("9.9.9.9", AHORA - RETENCION_FALLOS_MS + 1, AHORA + 30 * 60_000);
			await purgarBaseCentral(e.db, AHORA);
			return e.ips();
		});

		expect(ips).toEqual(["9.9.9.9"]);
	});

	it("de las trazas de correo se va lo viejo y se queda lo que aún se puede consultar", async () => {
		const r = await escenario("correo", async (e) => {
			e.envio("viejo", AHORA - RETENCION_ENVIOS_MS - 1);
			e.envio("reciente", AHORA - RETENCION_ENVIOS_MS + 1);

			const purgado = await purgarBaseCentral(e.db, AHORA);
			return { envios: e.envios(), purgado };
		});

		expect(r.envios).toEqual(["reciente"]);
		expect(r.purgado.trazasDeCorreo).toBe(1);
	});

	it("los envíos de dentro de la ventana del tope diario NUNCA se tocan", async () => {
		// Si se fueran, el tope de REV-14 dejaría de contar y con un token robado se podría mandar
		// sin límite con nuestro dominio detrás.
		const envios = await escenario("tope", async (e) => {
			e.envio("de-hoy", AHORA - 60_000);
			await purgarBaseCentral(e.db, AHORA);
			return e.envios();
		});

		expect(envios).toEqual(["de-hoy"]);
	});

	it("de los códigos de emparejamiento se va lo caducado hace más de un día, en cualquier estado (AUD-12)", async () => {
		// Por caducidad y no por estado: un código que nadie toca se queda en 'pending' para siempre.
		// Antes no se borraba ninguno, y cada número gastado lo estaba para siempre.
		const { RETENCION_CODIGOS_MS } = await import("../src/server/purga");
		const r = await escenario("codigos", async (e) => {
			e.sql.exec(`DELETE FROM pair_requests;`);
			const codigo = (pairCode: string, status: string, expiraMs: number) =>
				e.sql.exec(
					`INSERT INTO pair_requests (pair_code, secret_hash, tenant_id, created_by_device_id, status, created_at_ms, expires_at_ms)
					 VALUES (?, 'x', 'tenant-1', 'main-1', ?, ?, ?);`,
					pairCode,
					status,
					expiraMs - 10 * 60_000,
					expiraMs,
				);
			codigo("000001", "pending", AHORA - 400 * 24 * 60 * 60_000);
			codigo("000002", "used", AHORA - RETENCION_CODIGOS_MS - 1);
			codigo("000003", "rejected", AHORA - RETENCION_CODIGOS_MS - 1);
			codigo("000004", "expired", AHORA - RETENCION_CODIGOS_MS + 1);
			codigo("000005", "pending", AHORA + 5 * 60_000);

			const purgado = await purgarBaseCentral(e.db, AHORA);
			const quedan = e.sql
				.exec(`SELECT pair_code FROM pair_requests ORDER BY pair_code;`)
				.toArray()
				.map((f: any) => String(f.pair_code));
			return { quedan, purgado };
		});

		expect(r.quedan).toEqual(["000004", "000005"]);
		expect(r.purgado.codigosDeEmparejamiento).toBe(3);
	});

	it("un fallo en una tabla no impide purgar la otra", async () => {
		// Son tablas sin relación: que una falle no puede dejar a la otra creciendo. Se rompe la
		// primera, que es la que va delante.
		const r = await escenario("aislamiento", async (e) => {
			e.sql.exec(`DROP TABLE pair_claim_fallos;`);
			e.envio("viejo", AHORA - RETENCION_ENVIOS_MS - 1);

			const purgado = await purgarBaseCentral(e.db, AHORA);
			return { envios: e.envios(), purgado };
		});

		expect(r.envios).toEqual([]);
		expect(r.purgado.trazasDeCorreo).toBe(1);
		expect(r.purgado.fallosDeEmparejamiento).toBe(0);
	});
});
