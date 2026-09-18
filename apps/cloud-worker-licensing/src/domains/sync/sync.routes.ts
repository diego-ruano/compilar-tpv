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
import { reportarSaludDeSync as emitirSalud } from "../../observability/axiom";
import { tenantAuth, type TenantVars } from "../../middleware/tenant";
import { getDb } from "../../server/db";
import { getTenantDbRow } from "../../server/db/tenantDb";
import { provisionTenantDatabase } from "../licensing/licensing.helpers";
import {
	TRANSACCIONALES,
	esTablaDeNegocio,
	esTransaccional,
	limiteVentana,
	sentenciaConteo,
	sentenciaVolcado,
} from "./bootstrap.ventana";

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

	const snapshot = await tenantQuery(c, async (db) => {
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
		await tenantQuery(c, async (db) => {
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

/**
 * Tope de filas de la FASE 1. Sigue existiendo porque el volcado se construye entero en memoria y
 * un isolate de Workers tiene 128 MB: quedarse sin memoria a mitad devolvería un error opaco en
 * vez de una explicación. Lo que ha cambiado (SYNC-19) es que ya no es un techo del producto —
 * pasado el tope el equipo no podía recuperarse—, porque el histórico que lo hacía crecer ya no
 * viaja por aquí, sino por `/historico`.
 */
const BOOTSTRAP_MAX_FILAS = 300_000;

syncRoutes.post("/bootstrap", async (c) => {
	const okTpv = await isTpvDevice(c.env, c.get("tenantId"), c.get("deviceId"));
	if (!okTpv) return c.json({ error: "forbidden_not_tpv" }, 403);

	const clientNow = c.req.header("x-client-now");

	const resultado = await tenantQuery(c, async (db) => {
		const rsTablas = await db.execute({
			sql: `SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name ASC;`,
			args: [],
		});
		const tablas = rows(rsTablas)
			.map((r: any) => String(r.name ?? r.NAME ?? ""))
			.filter(esTablaDeNegocio);

		// El límite de la ventana se calcula ANTES y una sola vez: entra como argumento en todas
		// las sentencias del volcado, de modo que padre e hijas seleccionan el mismo conjunto. Si
		// cada una lo recalculara, dos sentencias del mismo lote podrían caer a distinto lado de un
		// segundo y dejar una hija huérfana.
		const rsCierre = await db.execute({
			sql: `SELECT Fecha_Hora FROM Cierres_Caja WHERE Reabierto_En IS NULL
			      ORDER BY Fecha_Hora DESC LIMIT 1;`,
			args: [],
		});
		const ultimoCierre = (rows(rsCierre)[0] as any)?.Fecha_Hora ?? null;
		const desde = limiteVentana(clientNow, ultimoCierre ? String(ultimoCierre) : null);

		// Guardia de tamaño ANTES de construir el volcado. Cuenta EXACTAMENTE el trozo que se va a
		// construir (no la tabla entera): contar de más devolvería un 413 por algo que sí cabe, y
		// ese 413 llega el día que un cliente ha perdido su base. Va fuera de la transacción de
		// lectura a propósito: sólo decide si cabe, no es el dato.
		const rsConteos = await db.batch(
			tablas.map((t) => sentenciaConteo(t, desde)),
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
				...tablas.map((t) => sentenciaVolcado(t, desde)),
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
				// `parcial` es lo que la Main usa para sembrar su cola de backfill. Se marca por
				// clasificación y no comparando conteos: comparar exigiría un COUNT(*) de la tabla
				// entera —cientos de miles de lecturas facturadas para decidir un booleano— y
				// además abriría una carrera con las escrituras que entran a la vez. Una tabla
				// transaccional que resulte estar completa termina su backfill con una página
				// vacía, que es gratis.
				parcial: esTransaccional(nombre),
				// Filas posicionales (no objetos): con 41 tablas, repetir el nombre de cada columna
				// en cada fila multiplicaría el tamaño de la respuesta sin añadir nada.
				filas: (rs.rows ?? []).map((r: any) =>
					Array.isArray(r) ? r : columnas.map((col) => r[col] ?? null),
				),
			};
		});

		// Orden de backfill, decidido AQUÍ (padres primero). La Main lo guarda tal cual: cada
		// página de la fase 2 es su propia transacción, así que una hija insertada antes que su
		// padre no tiene dónde apoyarse.
		const backfill = TRANSACCIONALES.map((t) => t.nombre).filter((n) => tablas.includes(n));

		return { demasiadoGrande: false as const, seq, tablas: volcado, totalFilas, desde, backfill };
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

	// ⚠️ Los nombres de este sobre son el CONTRATO con `BootstrapSnapshot` de Rust, que lo
	// deserializa con serde y falla ENTERO si uno no coincide. Salió `totalFilas` desde el día que
	// se escribió (db4b5d8) mientras Rust esperaba `total_filas`: la recuperación desde la nube —la
	// única salida de quien pierde su `data.db`— nunca llegó a funcionar, y no se vio porque ningún
	// test recorría ese camino entero. Al tocar aquí, mira `crates/tpv-contracts/src/sync.rs`; lo
	// vigila `syncBootstrap.test.ts` («el sobre lleva EXACTAMENTE los nombres que deserializa Rust»).
	return c.json({
		ok: true,
		seq: resultado.seq,
		total_filas: resultado.totalFilas,
		ventana_desde: resultado.desde,
		backfill: resultado.backfill,
		tablas: resultado.tablas,
	});
});

// ---------------------------------------------------------------------------
// POST /v1/sync/historico — FASE 2: el resto del histórico, paginado
// ---------------------------------------------------------------------------
//
// La fase 1 devuelve una foto coherente y con `Seq` exacto, y eso es lo que la obliga a caber en
// una petición. Esto es lo contrario y por eso es fácil: son datos que ya no cambian, así que no
// necesitan ser coherentes con ningún `Seq`, ni transacción, ni baton, ni foto. Se paginan y ya.
//
// **Paginación por `rowid`, no por clave primaria.** Era lo intuitivo y no vale: seis de estas
// tablas tienen PK compuesta (`Pago_Detalles`, `Lote_Consumos`, `Suelto_Consumos`,
// `Cierre_Denominaciones`, `Notificacion_Lecturas`, `Fichaje_Dia`), y paginar por tuplas obligaría
// a mantener a mano un mapa tabla→columnas. El `rowid` es una sola columna, existe en todas, es
// total y es estable mientras nadie haga `VACUUM` sobre la base del tenant — cosa que este código
// no hace en ningún sitio.
//
// Se re-descarga la ventana que ya trajo la fase 1. Es coste acotado y conocido, y a cambio
// desaparece toda la familia de casos especiales de "empezar por donde lo dejó la otra fase".

/** Tope de filas por página. Lo impone el servidor: el cliente pide, no manda. */
const HISTORICO_MAX_FILAS = 2_000;
const HISTORICO_FILAS_DEFECTO = 1_000;

/** Alias del `rowid` en el `SELECT`. Con dos guiones bajos no colisiona con ninguna columna real. */
const COL_CURSOR = "__rowid";

syncRoutes.post("/historico", async (c) => {
	const okTpv = await isTpvDevice(c.env, c.get("tenantId"), c.get("deviceId"));
	if (!okTpv) return c.json({ error: "forbidden_not_tpv" }, 403);

	const body = await c.req.json().catch(() => ({}));
	const tabla = String((body as any)?.tabla ?? "");
	const cursor = Math.max(0, Number((body as any)?.cursor ?? 0) || 0);
	const limite = Math.min(
		Math.max(1, Number((body as any)?.limite ?? HISTORICO_FILAS_DEFECTO) || HISTORICO_FILAS_DEFECTO),
		HISTORICO_MAX_FILAS,
	);

	// Lista blanca cerrada, no saneado: el nombre de tabla se interpola en el SQL (no se puede
	// enlazar con `?`), y el conjunto de tablas que la fase 2 rellena está decidido de antemano.
	if (!esTransaccional(tabla)) {
		return c.json({ ok: false, code: "validation", error: "tabla_no_paginable" }, 400);
	}

	const resultado = await tenantQuery(c, async (db) => {
		// Un tenant con una versión de esquema por detrás puede no tener la tabla. Eso se informa
		// como "no hay nada que traer", no como un error: la recuperación no puede quedarse
		// atascada por una tabla que en ese negocio todavía no existe.
		const rsExiste = await db.execute({
			sql: `SELECT 1 AS hay FROM sqlite_master WHERE type = 'table' AND name = ?1;`,
			args: [tabla],
		});
		if (rows(rsExiste).length === 0) {
			return { columnas: [] as string[], filas: [] as any[][], siguiente: null as number | null };
		}

		const rs = await db.execute({
			sql: `SELECT rowid AS ${COL_CURSOR}, * FROM "${tabla}"
			      WHERE rowid > ?1 ORDER BY rowid LIMIT ?2;`,
			args: [cursor, limite],
		});

		const todas: string[] = rs.columns ?? [];
		const columnas = todas.slice(1);
		const filasCrudas = (rs.rows ?? []).map((r: any) =>
			Array.isArray(r) ? r : todas.map((col) => r[col] ?? null),
		);
		const filas = filasCrudas.map((f) => f.slice(1));

		// El cursor sólo avanza mientras haya página completa. Una página corta significa "no queda
		// nada": devolver un cursor ahí haría que el cliente pidiera para siempre.
		const siguiente =
			filasCrudas.length === limite ? Number(filasCrudas[filasCrudas.length - 1][0]) : null;

		return { columnas, filas, siguiente };
	});

	return c.json({
		ok: true,
		tabla,
		columnas: resultado.columnas,
		filas: resultado.filas,
		siguiente_cursor: resultado.siguiente,
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

/* ===== SYNC-24: comprobar que la nube y la Main dicen lo mismo ===== */

/**
 * Foto para CONTRASTAR, no para restaurar.
 *
 * Devuelve dos cosas y cada una cubre lo que la otra no:
 *
 * - `conteos`: `COUNT(*)` de **todas** las tablas de negocio, enteras. Es baratísimo (un agregado
 *   por tabla) y es lo único que ve una fila que falta o que sobra fuera de la ventana.
 * - `ventana`: el contenido de los últimos `VENTANA_DIAS`, con las MISMAS sentencias que el
 *   bootstrap. Es lo que ve un VALOR distinto — el caso que nos mordió (un `UPDATE` de
 *   `Razon_Social` que no llegó a subir) y que ningún contador detecta, porque la fila está en los
 *   dos sitios.
 *
 * El histórico viejo se queda fuera a propósito: ya no cambia, así que volver a leerlo cada ciclo
 * es pagar lecturas de Turso por comprobar datos inmutables. Si algo se descuadró ahí, se descuadró
 * cuando estaba dentro de la ventana.
 *
 * ⚠️ NO abre transacción ni devuelve `Seq`, y ésa es la diferencia con `/bootstrap`. Aquí una foto
 * ligeramente movida no hace daño: lo peor que produce es un descuadre que al ciclo siguiente ya no
 * está. Pagar una transacción de lectura sobre toda la ventana, en cambio, sí compite con quien
 * está vendiendo.
 */
syncRoutes.post("/verificar", async (c) => {
	const okTpv = await isTpvDevice(c.env, c.get("tenantId"), c.get("deviceId"));
	if (!okTpv) return c.json({ error: "forbidden_not_tpv" }, 403);

	const clientNow = c.req.header("x-client-now");

	const resultado = await tenantQuery(c, async (db) => {
		const rsTablas = await db.execute({
			sql: `SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name ASC;`,
			args: [],
		});
		const tablas = rows(rsTablas)
			.map((r: any) => String(r.name ?? r.NAME ?? ""))
			.filter(esTablaDeNegocio);

		const rsCierre = await db.execute({
			sql: `SELECT Fecha_Hora FROM Cierres_Caja WHERE Reabierto_En IS NULL
			      ORDER BY Fecha_Hora DESC LIMIT 1;`,
			args: [],
		});
		const ultimoCierre = (rows(rsCierre)[0] as any)?.Fecha_Hora ?? null;
		const desde = limiteVentana(clientNow, ultimoCierre ? String(ultimoCierre) : null);

		// Conteos de tabla ENTERA (no de la ventana): es lo que delata una fila perdida en el
		// histórico, que la ventana no mira.
		const rsConteos = await db.batch(
			tablas.map((t) => ({ sql: `SELECT COUNT(*) AS n FROM "${t}";`, args: [] })),
			"read",
		);
		const conteos = tablas.map((nombre, i) => ({
			nombre,
			filas: Number((rsConteos[i]?.rows?.[0] as any)?.n ?? 0),
		}));

		// Guardia de tamaño sobre lo que se va a construir de verdad, igual que en el bootstrap.
		// Si la ventana no cabe, se devuelven los conteos igualmente: media comprobación es mejor
		// que ninguna, y es justo el caso en el que más falta hace saber que algo va mal.
		const rsVentanaN = await db.batch(
			tablas.map((t) => sentenciaConteo(t, desde)),
			"read",
		);
		const filasVentana = rsVentanaN.reduce(
			(acc, rs) => acc + Number((rs.rows?.[0] as any)?.n ?? 0),
			0,
		);
		// El `Seq` se lee DESPUES de todo lo demas, y eso NO es un detalle de implementacion.
		//
		// La Main lo usa para decidir si puede borrar arriba lo que aqui sobra: solo se atreve si su
		// marcapaginas llega hasta aqui, porque entonces ya ha visto todo lo que hay en esta foto y
		// una fila que le falte no puede ser "algo de la Handy que aun no me ha llegado".
		//
		// Leyendolo ANTES, una escritura que entrara a mitad de la lectura acabaria en la foto con
		// un Seq mayor del que se apunto: la Main se creeria al dia y borraria una comanda que
		// acaban de abrir. Leyendolo al final, el numero es siempre >= al de cualquier fila que
		// viaje, asi que la comparacion falla del lado que no destruye nada.
		const leerHastaSeq = async () => {
			const rs = await db.execute({
				sql: "SELECT COALESCE(MAX(Seq), 0) AS seq FROM Sync_Changes;",
				args: [],
			});
			return Number((rows(rs)[0] as any)?.seq ?? 0);
		};

		if (filasVentana > BOOTSTRAP_MAX_FILAS) {
			return {
				conteos,
				ventana: [],
				ventana_omitida: true as const,
				desde,
				hasta_seq: await leerHastaSeq(),
			};
		}

		const rsVolcado = await db.batch(
			tablas.map((t) => sentenciaVolcado(t, desde)),
			"read",
		);
		const ventana = tablas.map((nombre, i) => {
			const rs = rsVolcado[i];
			const columnas: string[] = (rs?.columns ?? []).map((x: any) => String(x));
			return {
				nombre,
				columnas,
				filas: (rs?.rows ?? []).map((r: any) => columnas.map((c) => r[c] ?? null)),
			};
		});

		return {
			conteos,
			ventana,
			ventana_omitida: false as const,
			desde,
			hasta_seq: await leerHastaSeq(),
		};
	});

	return c.json(resultado);
});

/**
 * Las CLAVES de una tabla, sin su contenido (SYNC-25).
 *
 * Con `/verificar` a secas, la Main sólo puede preguntar en una dirección: «esta fila que tienes,
 * ¿está igual en mi base?». La contraria —«esta fila que tengo yo, ¿está en la tuya?»— no puede
 * hacerla, porque para recorrer *sus* filas de la ventana tendría que reproducir la definición de
 * la ventana, que vive aquí a propósito (una sola fuente, con sus CTEs de comandas e hijas).
 * Copiarla a Rust serían dos definiciones que acabarían divergiendo.
 *
 * Con la lista de claves delante no hace falta reproducir nada: la Main resta los dos conjuntos y
 * sabe EXACTAMENTE cuáles faltan arriba y cuáles sobran, en vez de saber sólo cuántas.
 *
 * Sobre la tabla ENTERA y no sobre la ventana: una clave ocupa poco, y así se ve también lo que se
 * haya descuadrado en el histórico.
 *
 * ⚠️ **Esto no se pide nunca salvo que algo ya no cuadre.** La Main compara primero los `COUNT(*)`,
 * que cuestan un agregado por tabla, y sólo pide las claves de las tablas cuyo contador no encaja.
 * El caso normal —todo cuadra— no paga nada de esto; la parte cara se paga el día que hay un
 * problema, que es cuando merece la pena pagarla.
 *
 * Las columnas de la clave las manda la MAIN y no se deducen aquí. El esquema es el mismo en los
 * dos lados, así que da igual quién lo lea; lo que no da igual es que lo lean **dos sitios
 * distintos**, porque entonces pueden discrepar.
 */
syncRoutes.post("/verificar-claves", async (c) => {
	const okTpv = await isTpvDevice(c.env, c.get("tenantId"), c.get("deviceId"));
	if (!okTpv) return c.json({ error: "forbidden_not_tpv" }, 403);

	const cuerpo = await c.req.json().catch(() => ({}) as any);
	const pedidas: { nombre: string; claves: string[] }[] = Array.isArray(cuerpo?.tablas)
		? cuerpo.tablas.slice(0, 60)
		: [];

	// Nombre e identificadores se interpolan en el SQL (no se pueden enlazar con `?`), así que se
	// filtran igual que en el bootstrap: sólo lo que puede ser un identificador nuestro.
	const aceptable = (n: unknown) =>
		typeof n === "string" && /^[A-Za-z0-9_]{1,64}$/.test(n) && !n.startsWith("_");

	const validas = pedidas.filter(
		(t) =>
			aceptable(t?.nombre) &&
			esTablaDeNegocio(t.nombre) &&
			Array.isArray(t?.claves) &&
			t.claves.length > 0 &&
			t.claves.length <= 4 &&
			t.claves.every(aceptable),
	);
	if (!validas.length) return c.json({ tablas: [] });

	const resultado = await tenantQuery(c, async (db) => {
		// Tope por tabla. Una lista de claves crece con la tabla, y sin techo una base con años de
		// histórico devolvería decenas de megas por una petición de diagnóstico. Si no cabe se dice
		// (`truncada`) en vez de mandar media lista, que se leería como "te sobran 400.000 filas".
		const TOPE = 200_000;

		const rs = await db.batch(
			validas.map((t) => ({
				sql: `SELECT ${t.claves.map((k) => `"${k}"`).join(", ")} FROM "${t.nombre}" LIMIT ${TOPE + 1};`,
				args: [],
			})),
			"read",
		);

		return {
			tablas: validas.map((t, i) => {
				const filas = rs[i]?.rows ?? [];
				const truncada = filas.length > TOPE;
				return {
					nombre: t.nombre,
					columnas: t.claves,
					claves: truncada
						? []
						: filas.map((r: any) => t.claves.map((k) => r[k] ?? null)),
					truncada,
				};
			}),
		};
	});

	return c.json(resultado);
});

/**
 * El TPV cuenta cómo está su sincronización. NADIE MIRA ESTO A MANO: va a Axiom.
 *
 * Existe porque el aviso útil de un descuadre no es para quien está delante del TPV —un `op_id` y
 * un error de SQL no los puede usar un camarero, y un aviso que no se puede atender se aprende a
 * ignorar— sino para quien puede arreglarlo. El equipo se chiva solo y aquí no hay interfaz que
 * abrir.
 *
 * Es **best-effort por diseño**: si esto falla, el TPV sigue exactamente igual. Nada de lo que
 * rodea a la observabilidad puede afectar a vender ni a replicar.
 */
syncRoutes.post("/salud", async (c) => {
	const okTpv = await isTpvDevice(c.env, c.get("tenantId"), c.get("deviceId"));
	if (!okTpv) return c.json({ error: "forbidden_not_tpv" }, 403);

	const cuerpo = await c.req.json().catch(() => ({}) as any);
	const descuadres = Array.isArray(cuerpo?.descuadres) ? cuerpo.descuadres.slice(0, 50) : [];

	// `waitUntil`: sin él, el runtime cancela la entrega en cuanto se responde el `{ok:true}`.
	c.executionCtx.waitUntil(
		emitirSalud(c.env, {
			tenant_id: c.get("tenantId"),
			device_id: c.get("deviceId"),
			// Se recorta lo que llega: es un informe, no un canal de datos. Sin esto, un bug del
			// cliente podría mandar filas enteras de negocio a un dataset de observabilidad.
			descuadres: descuadres.map((d: any) => ({
				tabla: String(d?.tabla ?? "").slice(0, 64),
				faltan: Number(d?.faltan ?? 0),
				sobran: Number(d?.sobran ?? 0),
				distintas: Number(d?.distintas ?? 0),
			})),
			apartadas: Number(cuerpo?.apartadas ?? 0),
			reparadas: Number(cuerpo?.reparadas ?? 0),
			ventana_omitida: Boolean(cuerpo?.ventana_omitida),
		}),
	);

	return c.json({ ok: true });
});
