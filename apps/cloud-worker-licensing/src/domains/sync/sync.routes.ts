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
import { alHub } from "../../lib/enElHub";
import { gzipSiSeAcepta } from "../../lib/gzip";
import { getDb } from "../../server/db";
import { hubDe } from "../../lib/hub";
import { provisionTenantDatabase } from "../licensing/licensing.helpers";
import {
	TRANSACCIONALES,
	esTablaDeNegocio,
	esTransaccional,
	sentenciaConteo,
	sentenciaVolcado,
	ventanasCandidatas,
} from "./bootstrap.ventana";
import {
	Escritor,
	VOLCADO_MAX_BYTES,
	bytesDe,
	enBytes,
	escribirTablas,
	lectorDe,
	primerValor,
	siguiente,
	type Lector,
	type Resultado,
	type Sentencia,
} from "./volcado";
import {
	changesSchema,
	historicoSchema,
	saludSyncSchema,
	verificarClavesSchema,
} from "./sync.schemas";

type Ctx = { Bindings: Env; Variables: TenantVars };

export const syncRoutes = new Hono<Ctx>();

// Las respuestas que crecen con el negocio salen comprimidas si la Main lo acepta (`lib/gzip.ts`).
// Va delante de `alHub`: comprime el Worker lo que vuelve del TenantHub, no el TenantHub.
syncRoutes.use("/changes", gzipSiSeAcepta);
syncRoutes.use("/bootstrap", gzipSiSeAcepta);
syncRoutes.use("/historico", gzipSiSeAcepta);
syncRoutes.use("/verificar", gzipSiSeAcepta);
syncRoutes.use("/verificar-claves", gzipSiSeAcepta);

// ARQ-06: autenticación y rol se resuelven antes de que el validador lea el cuerpo.
syncRoutes.use("*", tenantAuth, alHub, soloLaMain("forbidden_not_tpv", 403));

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
 * Tope de filas de la FASE 1. Desde SYNC-19 no es un techo del producto —pasado el tope el equipo
 * no podía recuperarse—, porque el histórico que lo hacía crecer ya no viaja por aquí, sino por
 * `/historico`. Lo que cabe en memoria lo acota el tope en bytes (`VOLCADO_MAX_BYTES`); éste se
 * queda como guardia barata: se sabe con un `COUNT` por tabla, antes de leer una sola fila.
 */
export const BOOTSTRAP_MAX_FILAS = 300_000;

/** Los dos topes de un volcado: manda el que antes se alcance. */
export type Topes = { filas: number; bytes: number };

const TOPES: Topes = { filas: BOOTSTRAP_MAX_FILAS, bytes: VOLCADO_MAX_BYTES };

const SQL_TABLAS: Sentencia = {
	sql: "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name ASC;",
	args: [],
};
const SQL_ULTIMO_CIERRE: Sentencia = {
	sql: `SELECT Fecha_Hora FROM Cierres_Caja WHERE Reabierto_En IS NULL
	      ORDER BY Fecha_Hora DESC LIMIT 1;`,
	args: [],
};
const SQL_SEQ: Sentencia = { sql: "SELECT COALESCE(MAX(Seq), 0) AS seq FROM Sync_Changes;", args: [] };

/** Las tablas de negocio y la hora del último cierre no reabierto: de dónde sale la ventana. */
function leerPuntoDePartida(lector: Lector): Promise<{ tablas: string[]; ultimoCierre: string | null }> {
	return lector.foto([SQL_TABLAS, SQL_ULTIMO_CIERRE], (rs) => {
		const tablas = [...siguiente(rs).filas].map((f) => String(f[0] ?? "")).filter(esTablaDeNegocio);
		const cierre = primerValor(siguiente(rs));
		return { tablas, ultimoCierre: cierre == null ? null : String(cierre) };
	});
}

function seqDe(r: Resultado): number {
	return Number(primerValor(r) ?? 0);
}

/* ===== La ventana que cabe ===== */

/** Lo que ocupa una tabla en un volcado: lo que lleva siempre y, de media, cada una de sus filas. */
type Peso = { fijo: number; porFila: number };

/** Cuántas filas de cada tabla se miran para saber lo que ocupa una. */
const FILAS_DE_MUESTRA = 64;

/**
 * Pesa cada tabla escribiendo sus últimas filas, que son las que se parecen a las de la ventana.
 * Es una estimación: lo que decide de verdad si un volcado cabe es el `Escritor`, al escribirlo.
 */
function pesarTablas(lector: Lector, tablas: string[]): Promise<Map<string, Peso>> {
	return lector.foto(
		tablas.map((t) => ({
			sql: `SELECT * FROM "${t}" ORDER BY rowid DESC LIMIT ${FILAS_DE_MUESTRA};`,
			args: [],
		})),
		(rs) => {
			const pesos = new Map<string, Peso>();
			for (const nombre of tablas) {
				const { columnas, filas } = siguiente(rs);
				let n = 0;
				let bytes = 0;
				for (const fila of filas) {
					// La fila y la coma que la separa de la siguiente.
					bytes += bytesDe(JSON.stringify(fila)) + 1;
					n++;
				}
				const fijo = bytesDe(JSON.stringify({ nombre, columnas, parcial: true, filas: [] })) + 1;
				pesos.set(nombre, { fijo, porFila: n ? bytes / n : 0 });
			}
			return pesos;
		},
	);
}

/** Lo que mide una ventana antes de volcarla: sus filas, contadas, y sus bytes, estimados. */
type Medida = { filas: number; bytes: number };

/**
 * Mide ventanas de una misma base: cuenta EXACTAMENTE las filas que entrarían (con las sentencias
 * del volcado, no la tabla entera) y estima sus bytes con el peso de cada tabla. Las maestras no
 * dependen de la ventana y se cuentan una vez.
 */
function medidorDeVentanas(lector: Lector, tablas: string[], pesos: Map<string, Peso>): (desde: string) => Promise<Medida> {
	const deMaestras = new Map<string, number>();
	return async (desde) => {
		const porContar = tablas.filter((t) => esTransaccional(t) || !deMaestras.has(t));
		const contadas = await lector.foto(
			porContar.map((t) => sentenciaConteo(t, desde)),
			(rs) => new Map(porContar.map((t) => [t, Number(primerValor(siguiente(rs)) ?? 0)])),
		);
		for (const [t, n] of contadas) if (!esTransaccional(t)) deMaestras.set(t, n);

		const medida: Medida = { filas: 0, bytes: 0 };
		for (const t of tablas) {
			const n = contadas.get(t) ?? deMaestras.get(t) ?? 0;
			const peso = pesos.get(t) ?? { fijo: 0, porFila: 0 };
			medida.filas += n;
			medida.bytes += peso.fijo + n * peso.porFila;
		}
		return medida;
	};
}

/**
 * Vuelca la ventana más ancha que cabe en los topes (`bootstrap.ventana.ts`: los 30 días si caben,
 * y si no una semana, un día o sólo lo imprescindible).
 *
 * Cada candidata se mide antes de volcarla: contar cuesta un agregado por tabla y evita leer un mes
 * entero para tirarlo. La medida de los bytes es una estimación, y puede fallar hacia los dos lados:
 *
 * - Si se queda corta, `volcar` dice que no (`null`) al pasarse del tope escribiendo, y se prueba
 *   la candidata siguiente.
 * - Si se queda larga, se descarta una candidata que cabía y viaja una más estrecha. Con la última
 *   no puede pasar: detrás no hay otra, y descartarla por una estimación sería contestar «no cabe»
 *   a un negocio que sí cabe. Se intenta siempre que quepa por filas, y decide lo que se escribe.
 *   (Sólo donde escribir para a tiempo, `paraAlEscribir`: con la ruta en el Worker, intentarlo es
 *   traer todas las filas por la llamada al DO, así que allí la estimación sí descarta.)
 *
 * La medida va fuera de la foto a propósito: sólo decide qué ventana se intenta, no es el dato.
 * `volcar` recibe el límite UNA vez y lo usa en todas sus sentencias, de modo que padre e hijas
 * seleccionan el mismo conjunto; si cada una lo recalculara, dos sentencias de la misma foto podrían
 * caer a distinto lado de un segundo y dejar una hija huérfana.
 *
 * Devuelve el volcado, o `null` con las filas de la ventana más estrecha si ni ésa cabe.
 */
async function volcarLaVentanaQueQuepa<T>(
	lector: Lector,
	tablas: string[],
	candidatas: string[],
	topes: Topes,
	volcar: (desde: string) => Promise<T | null>,
): Promise<{ volcado: T } | { volcado: null; filas: number }> {
	const medir = medidorDeVentanas(lector, tablas, await pesarTablas(lector, tablas));
	let filas = 0;
	for (const [i, desde] of candidatas.entries()) {
		const medida = await medir(desde);
		filas = medida.filas;
		if (medida.filas > topes.filas) continue;
		const esLaUltima = i === candidatas.length - 1;
		if (medida.bytes > topes.bytes && !(esLaUltima && lector.paraAlEscribir)) continue;
		const volcado = await volcar(desde);
		if (volcado !== null) return { volcado };
	}
	return { volcado: null, filas };
}

/** El cuerpo de la fase 1, ya en JSON, o `null` con las filas de lo imprescindible, que no cabía. */
export type Fase1 = { cuerpo: Uint8Array<ArrayBuffer> } | { cuerpo: null; totalFilas: number };

/**
 * La fase 1: el volcado con el que una Main reconstruye su base, con la ventana más ancha que cabe.
 * Los topes entran por parámetro para poder probar el desborde sin sembrar un mes de un bar.
 */
export async function volcarFase1(lector: Lector, clientNow: unknown, topes: Topes = TOPES): Promise<Fase1> {
	const { tablas, ultimoCierre } = await leerPuntoDePartida(lector);

	// Orden de backfill, decidido AQUÍ (padres primero). La Main lo guarda tal cual: cada página
	// de la fase 2 es su propia transacción, así que una hija insertada antes que su padre no
	// tiene dónde apoyarse. No depende del ancho de la ventana: la fase 2 recorre cada tabla
	// entera.
	const backfill = TRANSACCIONALES.map((t) => t.nombre).filter((n) => tablas.includes(n));

	// La foto entera de una vez, incluido el `Seq`. Es lo que hace que el checkpoint sea exacto:
	// leer el `Seq` aparte dejaría una ventana en la que una escritura entra en el volcado Y vuelve
	// luego por el catch-up, que la reaplicaría contra una fila que ya está (PK duplicada → la op
	// acaba en cuarentena y el panel de salud en rojo).
	//
	// ⚠️ Los nombres de este sobre son el CONTRATO con `BootstrapSnapshot` de Rust, que lo
	// deserializa con serde y falla ENTERO si uno no coincide. Salió `totalFilas` desde el día que
	// se escribió (db4b5d8) mientras Rust esperaba `total_filas`: la recuperación desde la nube —la
	// única salida de quien pierde su `data.db`— nunca llegó a funcionar, y no se vio porque ningún
	// test recorría ese camino entero. Al tocar aquí, mira `crates/tpv-contracts/src/sync.rs`; lo
	// vigila `syncBootstrap.test.ts` («el sobre lleva EXACTAMENTE los nombres que deserializa Rust»).
	// A serde el orden de los campos le da igual: `seq` y `total_filas` van al final porque se
	// saben al terminar de escribir las tablas.
	const volcar = (desde: string) =>
		lector.foto([...tablas.map((t) => sentenciaVolcado(t, desde)), SQL_SEQ], (rs) => {
			const e = new Escritor(topes.bytes);
			e.texto(
				`{"ok":true,"ventana_desde":${JSON.stringify(desde)},"backfill":${JSON.stringify(backfill)},"tablas":`,
			);
			// `parcial` es lo que la Main usa para sembrar su cola de backfill. Se marca por
			// clasificación y no comparando conteos: comparar exigiría un COUNT(*) de la tabla
			// entera y además abriría una carrera con las escrituras que entran a la vez. Una tabla
			// transaccional que resulte estar completa termina su backfill con una página vacía,
			// que es gratis.
			const filas = escribirTablas(e, tablas, rs, topes.filas, esTransaccional);
			if (filas === null) return null;
			e.texto(`,"seq":${seqDe(siguiente(rs))},"total_filas":${filas}}`);
			return e.cerrar();
		});

	const r = await volcarLaVentanaQueQuepa(lector, tablas, ventanasCandidatas(clientNow, ultimoCierre), topes, volcar);
	return r.volcado ? { cuerpo: r.volcado } : { cuerpo: null, totalFilas: r.filas };
}

/** Un volcado ya escrito, como respuesta. */
function enJson(cuerpo: Uint8Array<ArrayBuffer>): Response {
	return new Response(cuerpo, { status: 200, headers: { "content-type": "application/json" } });
}

syncRoutes.post("/bootstrap", async (c) => {
	const resultado = await volcarFase1(lectorDe(c), c.req.header("x-client-now"));

	if (!resultado.cuerpo) {
		return c.json(
			{
				ok: false,
				code: "bootstrap_too_large",
				error: "bootstrap_demasiado_grande",
				totalFilas: resultado.totalFilas,
				limite: BOOTSTRAP_MAX_FILAS,
				limiteBytes: VOLCADO_MAX_BYTES,
			},
			413,
		);
	}

	return enJson(resultado.cuerpo);
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

/** Lo más que ocupa el final de una página: `],"siguiente_cursor":`, un `rowid` y la llave. */
const CIERRE_DE_PAGINA = 48;

/**
 * Una página del histórico de `tabla`, ya en JSON.
 *
 * La página se corta en `limite` filas o antes de pasar de `maxBytes`, lo que ocurra antes, y
 * nunca sin al menos una fila: una página vacía con cursor dejaría al backfill pidiendo la misma
 * para siempre. Cortada por tamaño lleva su `siguiente_cursor` igual que una completa, que es lo
 * único que la Main mira para seguir (`backfill_aplicar_pagina`).
 *
 * Esa primera fila entra aunque sola pase del tope, y entonces la página también lo pasa. Hace
 * falta una fila de megas (el SQLite del DO admite hasta 8 MB) que además se ensanche al escribirla
 * en JSON, como un texto lleno de caracteres de control; partirla no se puede, y rechazarla
 * dejaría al backfill atascado en ella para siempre.
 */
export async function paginaDelHistorico(
	lector: Lector,
	{ tabla, cursor, limite }: { tabla: string; cursor: number; limite: number },
	maxBytes: number = VOLCADO_MAX_BYTES,
): Promise<Uint8Array<ArrayBuffer>> {
	const cabecera = `{"ok":true,"tabla":${JSON.stringify(tabla)}`;

	// Un tenant con una versión de esquema por detrás puede no tener la tabla. Eso se informa como
	// "no hay nada que traer", no como un error: la recuperación no puede quedarse atascada por una
	// tabla que en ese negocio todavía no existe.
	const existe = await lector.foto(
		[{ sql: "SELECT 1 AS hay FROM sqlite_master WHERE type = 'table' AND name = ?1;", args: [tabla] }],
		(rs) => primerValor(siguiente(rs)) !== null,
	);
	if (!existe) return enBytes(`${cabecera},"columnas":[],"filas":[],"siguiente_cursor":null}`);

	return lector.foto(
		[
			{
				sql: `SELECT rowid AS ${COL_CURSOR}, * FROM "${tabla}"
				      WHERE rowid > ?1 ORDER BY rowid LIMIT ?2;`,
				args: [cursor, limite],
			},
		],
		(rs) => {
			const { columnas, filas } = siguiente(rs);
			const e = new Escritor(maxBytes);
			// La primera columna es el cursor: viaja aparte, no como una columna más.
			e.texto(`${cabecera},"columnas":${JSON.stringify(columnas.slice(1))},"filas":[`);

			let n = 0;
			let ultimo: unknown = null;
			let cortada = false;
			for (const fila of filas) {
				const texto = JSON.stringify(fila.slice(1));
				// Lo que ocuparía la página con esta fila: lo escrito, la fila con su coma y el cierre.
				if (n > 0 && e.ocupado + bytesDe(texto) + 1 + CIERRE_DE_PAGINA > maxBytes) {
					cortada = true;
					break;
				}
				e.texto(n ? `,${texto}` : texto);
				ultimo = fila[0];
				n++;
			}

			// El cursor sólo avanza mientras pueda quedar algo: detrás de una página que se llena, o
			// que se corta por tamaño, puede haber más. Una página corta significa "no queda nada":
			// devolver un cursor ahí haría que el cliente pidiera para siempre.
			const siguienteCursor = cortada || n === limite ? Number(ultimo) : null;
			e.texto(`],"siguiente_cursor":${JSON.stringify(siguienteCursor)}}`);
			return e.todo();
		},
	);
}

syncRoutes.post("/historico", cuerpoTolerante(historicoSchema), async (c) => {
	const pedido = c.req.valid("json");

	// Lista blanca cerrada, no saneado: el nombre de tabla se interpola en el SQL (no se puede
	// enlazar con `?`), y el conjunto de tablas que la fase 2 rellena está decidido de antemano.
	if (!esTransaccional(pedido.tabla)) {
		return c.json({ ok: false, code: "validation", error: "tabla_no_paginable" }, 400);
	}

	return enJson(await paginaDelHistorico(lectorDe(c), pedido));
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
 * - `ventana`: el contenido de la ventana de la fase 1 (los últimos `VENTANA_DIAS`, o lo que quepa
 *   de ellos), con las MISMAS sentencias que el bootstrap. Es lo que ve un VALOR distinto — el
 *   caso que nos mordió (un `UPDATE` de `Razon_Social` que no llegó a subir) y que ningún contador
 *   detecta, porque la fila está en los dos sitios.
 *
 * El histórico viejo se queda fuera a propósito: ya no cambia, así que volver a leerlo cada ciclo
 * es pagar lecturas de la base por comprobar datos inmutables. Si algo se descuadró ahí, se descuadró
 * cuando estaba dentro de la ventana.
 *
 * Los conteos y la ventana se leen en dos pasos, no en una sola foto como el `/bootstrap`. Aquí
 * no hace falta que coincidan al milímetro: lo peor que produce una escritura que entre entre los
 * dos es un descuadre que al ciclo siguiente ya no está. Lo que sí importa es dónde se lee el
 * `Seq` (abajo).
 *
 * Los topes entran por parámetro para poder probar el desborde sin sembrar un mes de un bar.
 */
export async function fotoDeVerificacion(
	lector: Lector,
	clientNow: unknown,
	topes: Topes = TOPES,
): Promise<Uint8Array<ArrayBuffer>> {
	const { tablas, ultimoCierre } = await leerPuntoDePartida(lector);
	const candidatas = ventanasCandidatas(clientNow, ultimoCierre);

	// Conteos de tabla ENTERA (no de la ventana): es lo que delata una fila perdida en el
	// histórico, que la ventana no mira.
	const conteos = await lector.foto(
		tablas.map((t) => ({ sql: `SELECT COUNT(*) AS n FROM "${t}";`, args: [] })),
		(rs) => tablas.map((nombre) => ({ nombre, filas: Number(primerValor(siguiente(rs)) ?? 0) })),
	);
	const cabecera = (desde: string) =>
		`{"conteos":${JSON.stringify(conteos)},"desde":${JSON.stringify(desde)}`;

	// La ventana es la de la fase 1 de la recuperación, con sus topes y encogida igual: si los 30
	// días no caben se contrasta lo que quepa (una semana, un día, o lo que hay desde el último
	// cierre), que sigue viendo un valor distinto en lo reciente. Si no cabe ni eso, se devuelven
	// los conteos igualmente: media comprobación es mejor que ninguna, y es justo el caso en el que
	// más falta hace saber que algo va mal.
	//
	// El `Seq` se lee DESPUES de las filas, y eso NO es un detalle de implementacion.
	//
	// La Main lo usa para decidir si puede borrar arriba lo que aqui sobra: solo se atreve si su
	// marcapaginas llega hasta aqui, porque entonces ya ha visto todo lo que hay en esta foto y
	// una fila que le falte no puede ser "algo de la Handy que aun no me ha llegado".
	//
	// Leyendolo ANTES, una escritura que entrara a mitad de la lectura acabaria en la foto con
	// un Seq mayor del que se apunto: la Main se creeria al dia y borraria una comanda que
	// acaban de abrir. Leyendolo al final, el numero es siempre >= al de cualquier fila que
	// viaje, asi que la comparacion falla del lado que no destruye nada.
	const r = await volcarLaVentanaQueQuepa(lector, tablas, candidatas, topes, (desde) =>
		lector.foto([...tablas.map((t) => sentenciaVolcado(t, desde)), SQL_SEQ], (rs) => {
			const e = new Escritor(topes.bytes);
			e.texto(`${cabecera(desde)},"ventana_omitida":false,"ventana":`);
			if (escribirTablas(e, tablas, rs, topes.filas) === null) return null;
			e.texto(`,"hasta_seq":${seqDe(siguiente(rs))}}`);
			return e.cerrar();
		}),
	);
	if (r.volcado) return r.volcado;

	const hastaSeq = await lector.foto([SQL_SEQ], (rs) => seqDe(siguiente(rs)));
	return enBytes(`${cabecera(candidatas[0])},"ventana_omitida":true,"ventana":[],"hasta_seq":${hastaSeq}}`);
}

syncRoutes.post("/verificar", async (c) => {
	return enJson(await fotoDeVerificacion(lectorDe(c), c.req.header("x-client-now")));
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
