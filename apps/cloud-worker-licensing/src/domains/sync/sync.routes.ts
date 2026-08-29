// src/domains/sync/sync.routes.ts
//
// Catch-up de la sincronización nube → Main. Cuando el WebSocket de la Main se reconecta tras
// un corte, la Main pide las operaciones que se perdió desde su último checkpoint (`Seq`). El
// DO ya registra cada escritura aplicada en `Sync_Changes` (Op_Id, Statements_Json resueltas,
// Seq monotono); aquí solo se sirven en orden.
//
// Solo la Main (rol tpv) consume este endpoint: es quien tiene la BD local que mantener al día.

import { Hono } from "hono";

import type { Env } from "../../env";
import { isTpvDevice } from "../../lib/deviceAuth";
import { tenantQuery } from "../../lib/tenantClient";
import { tenantAuth, type TenantVars } from "../../middleware/tenant";
import { getDb } from "../../server/db";
import { getTenantDbRow } from "../../server/db/tenantDb";
import { provisionTenantDatabase } from "../licensing/licensing.helpers";

type Ctx = { Bindings: Env; Variables: TenantVars };

export const syncRoutes = new Hono<Ctx>();

syncRoutes.use("*", tenantAuth);

function rows(rs: any): any[] {
	const cols: string[] = rs?.columns ?? [];
	return (rs?.rows ?? []).map((r: any) => {
		if (r && typeof r === "object" && !Array.isArray(r)) return r;
		const o: Record<string, any> = {};
		cols.forEach((col, i) => {
			o[col] = r[i];
		});
		return o;
	});
}

function safeJsonParse(s: string): any {
	try {
		return JSON.parse(s);
	} catch {
		return null;
	}
}

// POST /v1/sync/changes  { since?: number, limit?: number }
// Devuelve las operaciones con Seq > since en orden ascendente.
syncRoutes.post("/changes", async (c) => {
	const okTpv = await isTpvDevice(c.env, c.get("tenantId"), c.get("deviceId"));
	if (!okTpv) return c.json({ error: "forbidden_not_tpv" }, 403);

	const body = await c.req.json().catch(() => ({}));
	const since = Math.max(0, Number((body as any)?.since ?? 0) || 0);
	const limit = Math.min(Math.max(1, Number((body as any)?.limit ?? 500) || 500), 1000);

	const snapshot = await tenantQuery(c.env, c.get("tenantId"), async (db) => {
		// Items y high-water en la misma transacción de lectura. La recuperación sólo desbloquea
		// cuando el checkpoint local alcanza exactamente una foto conocida del final del log.
		const [rs, rsHighWater] = await db.batch(
			[
				{
					sql: `
				SELECT Seq, Op_Id, Command_Name, Statements_Json, Device_Id, Created_At_Ms
				FROM Sync_Changes
				WHERE Seq > ?1
				ORDER BY Seq ASC
				LIMIT ?2;
			`,
					args: [since, limit],
				},
				{ sql: "SELECT COALESCE(MAX(Seq), 0) AS seq FROM Sync_Changes;", args: [] },
			],
			"read",
		);

		const items = rows(rs).map((r: any) => ({
			seq: Number(r.Seq ?? r.seq ?? 0),
			opId: String(r.Op_Id ?? r.op_id ?? ""),
			command: String(r.Command_Name ?? r.command_name ?? ""),
			statements: safeJsonParse(String(r.Statements_Json ?? r.statements_json ?? "[]")) ?? [],
			deviceId: r.Device_Id ? String(r.Device_Id) : null,
			createdAtMs: Number(r.Created_At_Ms ?? r.created_at_ms ?? 0),
		}));
		const highWater = Number((rows(rsHighWater)[0] as any)?.seq ?? 0);
		return { items, highWater };
	});
	const { items, highWater } = snapshot;

	const nextSince = items.length ? items[items.length - 1].seq : since;

	// SYNC-12: registramos el checkpoint (`since`, lo que la Main YA tiene confirmado) como suelo de
	// la purga del log. Usamos `since` (no `nextSince`) porque es el límite inferior seguro: si la
	// Main cayera antes de aplicar este lote, re-pediría desde `since` y no habríamos purgado de más.
	// Best-effort: un fallo aquí no debe romper el catch-up.
	try {
		await tenantQuery(c.env, c.get("tenantId"), async (db) => {
			await db.execute({
				sql: `
					CREATE TABLE IF NOT EXISTS Sync_Main_Checkpoints (
						Device_Id TEXT PRIMARY KEY,
						Last_Seq INTEGER NOT NULL,
						Updated_At_Ms INTEGER NOT NULL
					);
				`,
				args: [],
			});
			await db.execute({
				sql: `
					INSERT INTO Sync_Main_Checkpoints (Device_Id, Last_Seq, Updated_At_Ms)
					VALUES (?1, ?2, ?3)
					ON CONFLICT(Device_Id) DO UPDATE SET
						Last_Seq = MAX(Last_Seq, ?2),
						Updated_At_Ms = ?3;
				`,
				args: [c.get("deviceId"), since, Date.now()],
			});
		});
	} catch {
		/* el registro del checkpoint es best-effort (solo alimenta la purga) */
	}

	return c.json({ ok: true, items, nextSince, highWater });
});

// ---------------------------------------------------------------------------
// POST /v1/sync/bootstrap — reconstrucción completa de la BD de una Main
// ---------------------------------------------------------------------------
//
// El catch-up (`/changes`) sirve para volver de un corte: reproduce las operaciones que la Main se
// perdió. NO sirve para volver de perder la BD, y son cosas distintas. El estado de una tabla no es
// la suma de sus cambios recientes, es la suma de TODOS, y `Sync_Changes` se purga a los 7 días
// (SYNC-12). Una Main que arranca con `Last_Seq = 0` y una `data.db` vacía pediría un catch-up que
// no puede reconstruir nada: los usuarios, los roles y el catálogo se crearon el primer día.
//
// Esto devuelve el ESTADO ACTUAL, no el log: un volcado de las tablas del tenant más el `Seq`
// exacto en el que se tomó la foto, para que la Main deje ahí su checkpoint y siga por el catch-up
// normal a partir de ese punto, sin huecos ni solapes.

/** Tope de filas del volcado. Ver `bootstrap_demasiado_grande` más abajo. */
const BOOTSTRAP_MAX_FILAS = 300_000;

/**
 * Tablas de control que NO forman parte del negocio y que la Main mantiene por su cuenta.
 * `Sync_Changes`/`Applied_Operations`/`Sync_Main_Checkpoints` son el andamiaje de la replicación en
 * la nube; el prefijo `_` cubre `_migrations`.
 */
const BOOTSTRAP_TABLAS_EXCLUIDAS = new Set([
	"Sync_Changes",
	"Applied_Operations",
	"Sync_Main_Checkpoints",
]);

function esTablaDeNegocio(nombre: string): boolean {
	if (!nombre) return false;
	if (nombre.startsWith("_") || nombre.startsWith("sqlite_") || nombre.startsWith("libsql_")) {
		return false;
	}
	return !BOOTSTRAP_TABLAS_EXCLUIDAS.has(nombre);
}

syncRoutes.post("/bootstrap", async (c) => {
	const okTpv = await isTpvDevice(c.env, c.get("tenantId"), c.get("deviceId"));
	if (!okTpv) return c.json({ error: "forbidden_not_tpv" }, 403);

	const resultado = await tenantQuery(c.env, c.get("tenantId"), async (db) => {
		const rsTablas = await db.execute({
			sql: `SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name ASC;`,
			args: [],
		});
		const tablas = rows(rsTablas)
			.map((r: any) => String(r.name ?? r.NAME ?? ""))
			.filter(esTablaDeNegocio);

		// Guardia de tamaño ANTES de construir el volcado: un isolate de Workers tiene 128 MB, y
		// quedarse sin memoria a mitad devolvería un error opaco en vez de una explicación. El conteo
		// va fuera de la transacción de lectura a propósito: sólo decide si cabe, no es el dato.
		const rsConteos = await db.batch(
			tablas.map((t) => ({ sql: `SELECT COUNT(*) AS n FROM "${t}";`, args: [] })),
			"read",
		);
		const totalFilas = rsConteos.reduce(
			(acc, rs) => acc + Number((rs.rows?.[0] as any)?.n ?? 0),
			0,
		);
		if (totalFilas > BOOTSTRAP_MAX_FILAS) {
			return { demasiadoGrande: true as const, totalFilas };
		}

		// La foto entera en UNA transacción de lectura, incluido el `Seq`. Es lo que hace que el
		// checkpoint sea exacto: leer el `Seq` aparte dejaría una ventana en la que una escritura
		// entra en el volcado Y vuelve luego por el catch-up, que la reaplicaría contra una fila
		// que ya está (PK duplicada → la op acaba en cuarentena y el panel de salud en rojo).
		const lote = await db.batch(
			[
				...tablas.map((t) => ({ sql: `SELECT * FROM "${t}";`, args: [] })),
				{ sql: `SELECT COALESCE(MAX(Seq), 0) AS seq FROM Sync_Changes;`, args: [] },
			],
			"read",
		);

		const rsSeq = lote[lote.length - 1];
		const seq = Number((rsSeq.rows?.[0] as any)?.seq ?? 0);

		const volcado = tablas.map((nombre, i) => {
			const rs = lote[i];
			const columnas: string[] = rs.columns ?? [];
			return {
				nombre,
				columnas,
				// Filas posicionales (no objetos): con 41 tablas, repetir el nombre de cada columna
				// en cada fila multiplicaría el tamaño de la respuesta sin añadir nada.
				filas: (rs.rows ?? []).map((r: any) =>
					Array.isArray(r) ? r : columnas.map((col) => r[col] ?? null),
				),
			};
		});

		return { demasiadoGrande: false as const, seq, tablas: volcado, totalFilas };
	});

	if (resultado.demasiadoGrande) {
		return c.json(
			{
				ok: false,
				code: "bootstrap_too_large",
				error: "bootstrap_demasiado_grande",
				totalFilas: resultado.totalFilas,
				limite: BOOTSTRAP_MAX_FILAS,
			},
			413,
		);
	}

	return c.json({
		ok: true,
		seq: resultado.seq,
		totalFilas: resultado.totalFilas,
		tablas: resultado.tablas,
	});
});

// POST /v1/sync/initialize-empty
// Única salida válida cuando el propio servidor confirma que no existe base del tenant. La acción
// es explícita desde la UI y jamás se usa como fallback de un timeout, un 500 o una migración rota.
syncRoutes.post("/initialize-empty", async (c) => {
	const tenantId = c.get("tenantId");
	const okTpv = await isTpvDevice(c.env, tenantId, c.get("deviceId"));
	if (!okTpv) return c.json({ error: "forbidden_not_tpv" }, 403);

	const central = getDb(c.env);
	const existing = await getTenantDbRow(central, tenantId);
	if (existing?.turso_url && existing?.turso_auth_token_enc && existing?.turso_db_name) {
		return c.json(
			{ ok: false, code: "conflict", error: "tenant_db_already_provisioned" },
			409,
		);
	}

	await provisionTenantDatabase(central, c.env, tenantId);
	return c.json({ ok: true });
});
