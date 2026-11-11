// src/domains/sync/sync.routes.ts
//
// Catch-up de la sincronización nube → Main. Cuando el WebSocket de la Main se reconecta tras
// un corte, la Main pide las operaciones que se perdió desde su último checkpoint (`Seq`). El
// DO ya registra cada escritura aplicada en `Sync_Changes` (Op_Id, Statements_Json resueltas,
// Seq monotono); aquí solo se sirven en orden.
//
// Solo la Main (rol tpv) consume este endpoint: es quien tiene la BD local que mantener al día.

import { Hono } from "hono";
import { capturarError } from "../../observability/errors";
import { PURGADO_HASTA, serializarCambios, type CambioGuardado } from "./cambiosJson";

import type { Env } from "../../env";
import { tenantQuery } from "../../lib/tenantClient";
import { cuerpoTolerante } from "../../lib/validacion";
import { reportarSaludDeSync as emitirSalud } from "../../observability/axiom";
import { soloLaMain, tenantAuth, type TenantVars } from "../../middleware/tenant";
import { getDb } from "../../server/db";
import { hubDe } from "../../lib/hub";
import { provisionTenantDatabase } from "../licensing/licensing.helpers";
import {
	TRANSACCIONALES,
	esTablaDeNegocio,
	esTransaccional,
	limiteVentana,
	sentenciaConteo,
	sentenciaVolcado,
} from "./bootstrap.ventana";
import {
	changesSchema,
	historicoSchema,
	saludSyncSchema,
	verificarClavesSchema,
} from "./sync.schemas";

type Ctx = { Bindings: Env; Variables: TenantVars };

export const syncRoutes = new Hono<Ctx>();

// ARQ-06: autenticación y rol se resuelven antes de que el validador lea el cuerpo.
syncRoutes.use("*", tenantAuth, soloLaMain("forbidden_not_tpv", 403));

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

// POST /v1/sync/changes  { since?: number, limit?: number }
// Devuelve las operaciones con Seq > since en orden ascendente, el final del log (`highWater`) y
// el mayor Seq que ya se purgó (`purgadoHasta`, AUD-19).
syncRoutes.post("/changes", cuerpoTolerante(changesSchema), async (c) => {
	const { since, limit } = c.req.valid("json");

	const snapshot = await tenantQuery(c, async (db) => {
		// Items, high-water y lo purgado en la misma transacción de lectura. La recuperación sólo
		// desbloquea cuando el checkpoint local alcanza exactamente una foto conocida del final del
		// log. AUD-19: y lo purgado tiene que ser de la misma foto que los items; leído aparte, una
		// purga entre medias escondería el tramo que se lleva. Cada lectura es de una fila: los
		// extremos del log por su clave (un `MIN` o un `MAX` solo, sin recorrerlo), la marca por la
		// del checkpoint.
		const [rs, rsFinal, rsPrimero, rsPurgado] = await db.batch(
			[
				{
					sql: `
				SELECT Seq, Op_Id, Command_Name, Statements_Json, Device_Id, Created_At_Ms,
                        CASE WHEN json_valid(Statements_Json) THEN json_type(Statements_Json) ELSE 'invalid' END AS Statements_Type
				FROM Sync_Changes
				WHERE Seq > ?1
				ORDER BY Seq ASC
				LIMIT ?2;
			`,
					args: [since, limit],
				},
				{ sql: "SELECT COALESCE(MAX(Seq), 0) AS seq FROM Sync_Changes;", args: [] },
				{ sql: "SELECT MIN(Seq) AS primero FROM Sync_Changes;", args: [] },
				{
					sql: "SELECT Last_Seq AS purgado FROM Sync_Main_Checkpoints WHERE Device_Id = ?1;",
					args: [PURGADO_HASTA],
				},
			],
			"read",
		);

		const items = rows(rs) as unknown as CambioGuardado[];
		const highWater = Number((rows(rsFinal)[0] as any)?.seq ?? 0);
		// La marca la escribe la purga desde AUD-19. Un log que ya purgó el código anterior no la
		// tiene, y a cualquiera le falta lo que hay por debajo de su primer Seq conservado: de ahí
		// el `MIN(Seq) - 1` (0 con el log vacío). Basta porque nunca dice de más (por debajo del
		// primero no queda nada) y la marca, cuando existe, ya cubre todo lo que se borró desde
		// AUD-19. Lo único que puede decir de menos es un hueco que la purga anterior dejara por
		// encima de su primer conservado, cuando la antigüedad y el Seq de dos escrituras en vuelo a
		// la vez se cruzaban justo en el corte de los 7 días; se cierra en cuanto una purga de este
		// código pasa por ese tramo. Ninguna base de producción la ha ejecutado.
		const marca = Number((rows(rsPurgado)[0] as any)?.purgado ?? 0);
		const primero = (rows(rsPrimero)[0] as any)?.primero;
		const debajoDelPrimero = primero == null ? 0 : Number(primero) - 1;
		const purgadoHasta = Math.max(marca, debajoDelPrimero);
		return { items, highWater, purgadoHasta };
	});
	const { items, highWater, purgadoHasta } = snapshot;

	const responseJson = serializarCambios(items, since, highWater, purgadoHasta);

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
	} catch (error) {
		capturarError(error, "sync.checkpoint");
		/* el registro del checkpoint es best-effort (solo alimenta la purga) */
	}

	return c.body(responseJson, 200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
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

/** Alias del `rowid` en el `SELECT`. Con dos guiones bajos no colisiona con ninguna columna real. */
const COL_CURSOR = "__rowid";

syncRoutes.post("/historico", cuerpoTolerante(historicoSchema), async (c) => {
	const { tabla, cursor, limite } = c.req.valid("json");

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
	const central = getDb(c.env);
	if (await hubDe(c.env, tenantId).estaAprovisionado()) {
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
/**
 * Tope de filas de UNA respuesta de `/verificar-claves`, y también el de una tabla suelta.
 *
 * Una lista de claves crece con la tabla, y sin techo una base con años de histórico devolvería
 * decenas de megas por una petición de diagnóstico.
 */
export const TOPE_CLAVES = 200_000;

/**
 * Lee las claves de cada tabla **gastando un presupuesto común** (REV-21).
 *
 * El tope por tabla no acotaba nada por sí solo: la petición admite 60 tablas y se resolvían
 * **todas a la vez** en un `batch`, así que el peor caso eran 60 × 200.000 listas de claves vivas
 * en un isolate de 128 MB. No hacía falta un atacante: un negocio con años de histórico y varias
 * tablas descuadradas lo alcanza solo, y justo el día que la verificación hace falta — que es el
 * único día en que este endpoint se pide.
 *
 * Por eso se recorren de una en una y el presupuesto se va gastando: las primeras tablas salen
 * enteras y las que ya no caben se marcan `truncada`, que es lo que la Main sabe leer («ésta no la
 * puedo comparar, la salto», `sync.rs::contrastar_con_la_nube`). Se pierde una comparación y se
 * vuelve a pedir; lo que no se pierde es el isolate, que se las llevaría todas por delante.
 *
 * El tope entra por parámetro para poder probar el reparto sin sembrar doscientas mil filas.
 */
export async function leerClaves(
	db: { execute: (q: { sql: string; args: any[] }) => Promise<any> },
	tablas: { nombre: string; claves: string[] }[],
	tope: number,
): Promise<{
	tablas: { nombre: string; columnas: string[]; claves: unknown[][]; truncada: boolean }[];
}> {
	let presupuesto = tope;
	const salida: {
		nombre: string;
		columnas: string[];
		claves: unknown[][];
		truncada: boolean;
	}[] = [];

	for (const t of tablas) {
		const cabe = Math.min(tope, presupuesto);
		// Sin presupuesto no se consulta siquiera: traer filas para tirarlas es pagar la memoria
		// igual, que es justo lo que se viene a evitar.
		if (cabe <= 0) {
			salida.push({ nombre: t.nombre, columnas: t.claves, claves: [], truncada: true });
			continue;
		}

		const r = await db.execute({
			sql: `SELECT ${t.claves.map((k) => `"${k}"`).join(", ")} FROM "${t.nombre}" LIMIT ${cabe + 1};`,
			args: [],
		});
		const filas = r.rows ?? [];

		// Media lista se leería como «te sobran 400.000 filas», así que o va entera o no va.
		if (filas.length > cabe) {
			salida.push({ nombre: t.nombre, columnas: t.claves, claves: [], truncada: true });
			continue;
		}

		presupuesto -= filas.length;
		salida.push({
			nombre: t.nombre,
			columnas: t.claves,
			claves: filas.map((f: any) => t.claves.map((k) => f[k] ?? null)),
			truncada: false,
		});
	}

	return { tablas: salida };
}

syncRoutes.post("/verificar-claves", cuerpoTolerante(verificarClavesSchema), async (c) => {
	const { tablas } = c.req.valid("json");
	if (!tablas.length) return c.json({ tablas: [] });

	const resultado = await tenantQuery(c, (db) => leerClaves(db, tablas, TOPE_CLAVES));

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
syncRoutes.post("/salud", cuerpoTolerante(saludSyncSchema), async (c) => {
	const datos = c.req.valid("json");
	// `waitUntil`: sin él, el runtime cancela la entrega en cuanto se responde el `{ok:true}`.
	c.executionCtx.waitUntil(
		emitirSalud(c.env, {
			tenant_id: c.get("tenantId"),
			device_id: c.get("deviceId"),
			// Se recorta lo que llega: es un informe, no un canal de datos. Sin esto, un bug del
			// cliente podría mandar filas enteras de negocio a un dataset de observabilidad.
			descuadres: datos.descuadres,
			apartadas: datos.apartadas,
			reparadas: datos.reparadas,
			ventana_omitida: datos.ventana_omitida,
			reparacion_apagada: datos.reparacion_apagada,
		}),
	);

	return c.json({ ok: true });
});
