// test/notificacionesReintento.test.ts
//
// AUD-26: la papelera de la Handy contesta 404 (`notificacion_no_encontrada`) cuando su escritura no
// hace lo que se pedía: la notificación no es de quien la toca, o ya no está donde estaba. Lo decide
// el recuento de filas cuando se sabe, y el ESTADO cuando no.
//
// No siempre se sabe. Un reintento con la misma `X-Idempotency-Key` de una operación ya aplicada no
// vuelve a ejecutarla: el DO devuelve el `Result_Json` que guardó al aplicarla, y para un
// `tenantDb.exec` ése es el `storageResult` de `buildApplyBatch`, `null`, que sólo se cambia por el
// número de filas si el resultado se llegó a refinar después de aplicarla (SYNC-10, que es
// best-effort). Y el lote se confirma también cuando la escritura condicional no toca ninguna fila,
// así que `null` puede ser «hecho» o «no era tuya». Con `null` se mira cómo ha quedado la notificación
// (`decidirPorEstado`).
//
// Se recorre la ruta de verdad (`/v1/notificaciones/:id/{descartar,restaurar,eliminar}`, con su
// validador, el `apply` y el `applyViaHub` reales y el lote de `buildApplyBatch`) sobre el esquema
// real del negocio. Lo que se sustituye: la autenticación del dispositivo (una Handy ya verificada),
// la base del negocio (el SQLite del DO) y el DO, que aplica el lote y guarda por clave lo que guarda
// el gate del de verdad antes de refinarlo. Sin tiempos ni red.

import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

import { clienteSobre } from "./helpers/clienteSql";
import { crearEsquemaTenant } from "./helpers/esquemaTenant";
import { enElHub } from "./helpers/hub";

let dbActual: any = null;

vi.mock("../src/middleware/tenant", async (original) => ({
	...(await (original as any)()),
	// Una Handy emparejada y con licencia: el JWT y el device-proof ya están verificados.
	tenantAuth: async (c: any, next: any) => {
		c.set("tenantId", "t-aud26");
		c.set("deviceId", "dev-handy");
		await next();
	},
}));

vi.mock("../src/server/db", () => ({
	getDb: () => ({ execute: async () => ({ rows: [{ role: "handy" }] }) }),
}));

vi.mock("../src/lib/tenantClient", async (original) => ({
	...(await (original as any)()),
	tenantQuery: (_c: any, fn: any) => fn(dbActual),
}));

const { notificacionesRoutes } = await import("../src/domains/notificaciones/notificaciones.routes");
const { buildApplyBatch } = await import("../src/durableObjects/tenantHub.lote");

const app = new Hono();
app.route("/v1/notificaciones", notificacionesRoutes);

const ADMIN = "aud26-admin-ficticio";
const CAMARERO = "aud26-camarero-ficticio";

/**
 * Cómo contesta el DO de la prueba la primera vez que ve una clave. Siempre aplica el lote sobre el
 * SQLite del hub y guarda para esa clave lo que guarda el gate (`storageResult`), y luego:
 *  - `respuesta`: devuelve el resultado del lote (el recuento), como cuando todo va bien;
 *  - `sin-recuento`: devuelve lo guardado, como cuando el DO contesta sin el recuento (un resultado
 *    que no se dejó leer);
 *  - `respuesta-perdida`: falla, como cuando la respuesta no le llega a la Handy, que reintenta.
 * Un reintento con la misma clave nunca aplica nada: devuelve lo guardado.
 */
type Primera = "respuesta" | "sin-recuento" | "respuesta-perdida";

function hubDePrueba(hub: any, sql: any, primera: Primera) {
	const guardado = new Map<string, unknown>();
	return {
		idFromName: (n: string) => n,
		get: () => ({
			aplicar: async (params: any) => {
				if (guardado.has(params.opId)) return { ok: true, data: guardado.get(params.opId) };
				const lote = buildApplyBatch(params.command);
				const resultados: any[] = [];
				hub.state.storage.transactionSync(() => {
					sql.exec("PRAGMA defer_foreign_keys = ON;");
					for (const st of lote.middle) {
						const cur = sql.exec(st.sql, ...(st.args ?? []));
						resultados.push({ rows: cur.toArray(), rowsAffected: cur.rowsWritten ?? 0 });
					}
				});
				guardado.set(params.opId, lote.storageResult);
				if (primera === "sin-recuento") return { ok: true, data: lote.storageResult };
				if (primera === "respuesta-perdida") throw new Error("la respuesta no llegó a la Handy");
				return { ok: true, data: lote.resolveResult(resultados, 0) };
			},
		}),
	};
}

async function pedir(ruta: string, cuerpo: unknown, env: unknown, op: string) {
	const res = await app.request(
		ruta,
		{
			method: "POST",
			headers: {
				"content-type": "application/json",
				"X-Idempotency-Key": op,
				"X-Client-Now": "2026-11-11 13:00:00",
			},
			body: JSON.stringify(cuerpo),
		},
		env as any,
	);
	const texto = await res.text();
	let json: any = null;
	try {
		json = JSON.parse(texto);
	} catch {
		json = texto;
	}
	return { status: res.status, json };
}

/** Un negocio con un administrador, un camarero y un aviso para los administradores. */
async function conHub(
	nombre: string,
	estado: "activa" | "descartada",
	primera: Primera,
	fn: (sql: any, env: unknown) => Promise<void>,
) {
	await enElHub(nombre, async (hub: any) => {
		const sql = hub.state.storage.sql;
		crearEsquemaTenant(sql);
		for (const [id, rol] of [
			[ADMIN, "Administrador"],
			[CAMARERO, "Camarero"],
		]) {
			sql.exec(
				`INSERT INTO Usuarios (ID_Usuario, ID_Rol, Email, Password_Hash, Nombre, Estado)
				 VALUES (?, (SELECT ID_Rol FROM Roles WHERE Nombre_Rol = ?), ?, 'x', 'Ficticio', 'Activo');`,
				id,
				rol,
				`${id}@ficticio.invalid`,
			);
		}
		sql.exec(
			`INSERT INTO Notificaciones (ID_Notificacion, Tipo, Severidad, Titulo, Destino_Tipo, Destino_Valor, Estado, Creada_En)
			 VALUES ('aviso', 'aviso', 'info', 'Aviso ficticio', 'rol',
			         (SELECT ID_Rol FROM Roles WHERE Nombre_Rol = 'Administrador'), ?, '2026-11-11 10:00:00');`,
			estado,
		);
		dbActual = clienteSobre(sql, hub.state.storage);
		await fn(sql, { TenantHub: hubDePrueba(hub, sql, primera) });
	});
}

const estadoDe = (sql: any): string | null =>
	(sql.exec("SELECT Estado FROM Notificaciones WHERE ID_Notificacion = 'aviso';").toArray()[0] as any)?.Estado ?? null;

const ACCIONES = [
	["descartar", "activa", "descartada"],
	["restaurar", "descartada", "activa"],
	["eliminar", "descartada", null],
] as const;

describe("AUD-26 · la papelera de la Handy: con el recuento, si se sabe; si no, por el estado", () => {
	for (const [accion, partida, queda] of ACCIONES) {
		it(`${accion}: el reintento con la misma clave de una operación ya aplicada contesta ok`, async () => {
			await conHub(`aud26-reintento-${accion}`, partida, "respuesta", async (sql, env) => {
				const ruta = `/v1/notificaciones/aviso/${accion}`;
				// Una clave con la forma de la de la Handy (16 a 64 caracteres, AUD-32).
				const clave = `op-aud26-reintento-${accion}`;

				const primero = await pedir(ruta, { id_usuario: ADMIN }, env, clave);
				expect(primero).toEqual({ status: 200, json: { ok: true } });
				expect(estadoDe(sql)).toBe(queda);

				// La primera respuesta no llegó y la Handy reenvía con la misma clave: el DO no vuelve a
				// aplicarla y devuelve lo que guardó (`null` en un `exec`). Quedó como se pidió: ok.
				const reenvio = await pedir(ruta, { id_usuario: ADMIN }, env, clave);
				expect(reenvio).toEqual({ status: 200, json: { ok: true } });
				expect(estadoDe(sql)).toBe(queda);
			});
		});

		it(`${accion}: lo que se sabe que no tocó ninguna fila contesta 404`, async () => {
			await conHub(`aud26-ajena-${accion}`, partida, "respuesta", async (sql, env) => {
				// El aviso es del rol Administrador: el camarero no lo toca, y el DO lo dice con un 0.
				const r = await pedir(`/v1/notificaciones/aviso/${accion}`, { id_usuario: CAMARERO }, env, `op-aud26-ajena-${accion}`);
				expect(r.status).toBe(404);
				expect(r.json.error).toBe("notificacion_no_encontrada");
				expect(estadoDe(sql)).toBe(partida);
			});
		});
	}

	// Cero filas y la respuesta perdida: el `null` guardado no dice que no tocara nada, y tampoco que
	// lo hiciera. La notificación sigue como estaba, así que es un 404.
	for (const [accion, partida] of [
		["descartar", "activa"],
		["eliminar", "descartada"],
	] as const) {
		it(`${accion} una ajena, contestada por el DO sin recuento, da 404`, async () => {
			await conHub(`aud26-ajena-do-${accion}`, partida, "sin-recuento", async (sql, env) => {
				const r = await pedir(`/v1/notificaciones/aviso/${accion}`, { id_usuario: CAMARERO }, env, `op-aud26-ajena-do-${accion}`);
				expect(r.status).toBe(404);
				expect(r.json.error).toBe("notificacion_no_encontrada");
				expect(estadoDe(sql)).toBe(partida);
			});
		});

		it(`${accion} una ajena, reintentada con la misma clave tras perder la respuesta, contesta 404`, async () => {
			await conHub(`aud26-ajena-http-${accion}`, partida, "respuesta-perdida", async (sql, env) => {
				const ruta = `/v1/notificaciones/aviso/${accion}`;
				const clave = `op-aud26-ajena-http-${accion}`;
				expect((await pedir(ruta, { id_usuario: CAMARERO }, env, clave)).status).toBe(500);

				const r = await pedir(ruta, { id_usuario: CAMARERO }, env, clave);
				expect(r.status).toBe(404);
				expect(r.json.error).toBe("notificacion_no_encontrada");
				expect(estadoDe(sql)).toBe(partida);
			});
		});
	}

	it("eliminar contestado por el DO sin recuento: si ya no existe, ok (borrar es idempotente)", async () => {
		await conHub("aud26-eliminar-do", "descartada", "sin-recuento", async (sql, env) => {
			const r = await pedir("/v1/notificaciones/aviso/eliminar", { id_usuario: ADMIN }, env, "op-aud26-eliminar-do-propia");
			expect(r).toEqual({ status: 200, json: { ok: true } });
			expect(estadoDe(sql)).toBe(null);
		});
	});
});
