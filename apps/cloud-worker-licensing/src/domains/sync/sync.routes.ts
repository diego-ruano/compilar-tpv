// src/domains/sync/sync.routes.ts
//
// Catch-up de la sincronización nube → Main. Cuando el WebSocket de la Main se reconecta tras
// un corte, la Main pide las operaciones que se perdió desde su último checkpoint (`Seq`). El
// DO ya registra cada escritura aplicada en `Sync_Changes` (Op_Id, Statements_Json resueltas,
// Seq monotono); aquí solo se sirven en orden.
//
// Solo la Main (rol tpv) consume este endpoint: es quien tiene la BD local que mantener al día.

import type { Client } from "@libsql/client/web";
import { Hono } from "hono";
import { capturarError } from "../../observability/errors";
import { bytesUtf8 } from "../../lib/texto";
import { PURGADO_HASTA, serializarCambios, type CambioGuardado } from "./cambiosJson";

import type { Env } from "../../env";
import { tenantQuery } from "../../lib/tenantClient";
import { cuerpoTolerante } from "../../lib/validacion";
import { reportarSaludDeSync as emitirSalud } from "../../observability/axiom";
import { soloLaMain, tenantAuth, type TenantVars } from "../../middleware/tenant";
import { alHub } from "../../lib/enElHub";
import { gzipSiSeAcepta } from "../../lib/gzip";
import { getDb } from "../../server/db";
import { provisionTenantDatabase } from "../licensing/licensing.helpers";
import {
	TRANSACCIONALES,
	esTransaccional,
	sentenciaVolcado,
	ventanasCandidatas,
} from "./bootstrap.ventana";
import { SQL_SEQ, contadorDeVentanas, leerPuntoDePartida, seqDe } from "./puntoDePartida";
import { cubosValidos } from "./resumenCubos";
import {
	esTablaVerificable,
	filasDeLosCubos,
	filasPorClave,
	paginaDeClaves,
	resumenDeVerificacion,
} from "./verificar";
import {
	Escritor,
	HISTORICO_MAX_BYTES,
	VOLCADO_MAX_BYTES,
	enBytes,
	escribirTablas,
	lectorDe,
	primerValor,
	siguiente,
	type Lector,
} from "./volcado";
import {
	changesSchema,
	historicoSchema,
	saludSyncSchema,
	verificarClavesPorPaginasSchema,
	verificarFilasSchema,
	verificarPorClaveSchema,
	verificarResumenSchema,
} from "./sync.schemas";

type Ctx = { Bindings: Env; Variables: TenantVars };

export const syncRoutes = new Hono<Ctx>();

// Las respuestas que crecen con el negocio salen comprimidas si la Main lo acepta (`lib/gzip.ts`).
// Va delante de `alHub`: comprime el Worker lo que vuelve del TenantHub, no el TenantHub.
syncRoutes.use("/changes", gzipSiSeAcepta);
syncRoutes.use("/bootstrap", gzipSiSeAcepta);
syncRoutes.use("/historico", gzipSiSeAcepta);
syncRoutes.use("/verificar/*", gzipSiSeAcepta);

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

/**
 * Lo más que ocupa una página de `/v1/sync/changes`, en bytes de las sentencias de sus cambios y de
 * lo que lleva alrededor cada uno (`BYTES_POR_CAMBIO`). Va además del tope de cambios (`limit`,
 * hasta 1.000): mil cambios pequeños caben de sobra, pero un cambio puede llevar cientos de
 * sentencias (un plano entero, un cobro de cien líneas), y mil de esos eran cientos de megas que el
 * TenantHub montaba en memoria con el hilo del negocio ocupado y que la Main tenía que bajar entera.
 *
 * La página se corta antes de pasar de aquí, y nunca sin al menos un cambio: uno que solo ya pase
 * viaja igual (partirlo no se puede, y dejarlo fuera atascaría a la Main en él). Una página cortada
 * lleva su `nextSince`, el `Seq` de su último cambio, igual que una completa, y la Main sigue pidiendo
 * desde ahí hasta que una llega vacía (`use_cases/replicacion.rs::catch_up`): no necesita saber que
 * se ha cortado, y una Main anterior a esto tampoco.
 */
export const CAMBIOS_MAX_BYTES = 4 * 1024 * 1024;

/** Lo que añade un cambio a sus sentencias en la respuesta: `seq`, `opId`, `command`, `deviceId`… */
const BYTES_POR_CAMBIO = 256;

/**
 * Los cambios con `Seq > since`, en orden, hasta `limit` y sin pasar de `maxBytes` (`CAMBIOS_MAX_BYTES`),
 * con el final del log (`highWater`) y lo purgado (`purgadoHasta`, AUD-19), todo de la misma foto.
 *
 * El corte por bytes lo hace la propia sentencia, con la suma acumulada de lo que ocupa cada cambio:
 * lo que no cabe no llega a salir de la base, ni a montarse como texto.
 */
export async function leerPaginaDeCambios(
	db: Pick<Client, "batch">,
	since: number,
	limit: number,
	maxBytes: number = CAMBIOS_MAX_BYTES,
): Promise<{ items: CambioGuardado[]; highWater: number; purgadoHasta: number }> {
	// Items, high-water y lo purgado en la misma transacción de lectura. La recuperación sólo
	// desbloquea cuando el checkpoint local alcanza exactamente una foto conocida del final del
	// log. AUD-19: y lo purgado tiene que ser de la misma foto que los items; leído aparte, una
	// purga entre medias escondería el tramo que se lleva. Cada lectura es de una fila: los
	// extremos del log por su clave (un `MIN` o un `MAX` solo, sin recorrerlo), la marca por la
	// del checkpoint.
	//
	// Los cambios: los `limit` siguientes por su clave y, de ellos, los que caben en `maxBytes`
	// contando lo que ocupa cada uno (sus sentencias, en bytes de UTF-8, y lo de alrededor); el
	// primero, siempre. La suma acumulada crece con el `Seq`, así que lo que cabe es un principio de
	// la página, sin huecos.
	const [rs, rsFinal, rsPrimero, rsPurgado] = await db.batch(
		[
			{
				sql: `
				SELECT Seq, Op_Id, Command_Name, Statements_Json, Device_Id, Created_At_Ms, Statements_Type
				FROM (
					SELECT Seq, Op_Id, Command_Name, Statements_Json, Device_Id, Created_At_Ms,
					       CASE WHEN json_valid(Statements_Json) THEN json_type(Statements_Json) ELSE 'invalid' END AS Statements_Type,
					       ROW_NUMBER() OVER (ORDER BY Seq) AS Orden,
					       SUM(COALESCE(length(CAST(Statements_Json AS BLOB)), 0) + ?3)
					           OVER (ORDER BY Seq ROWS UNBOUNDED PRECEDING) AS Bytes_Hasta_Aqui
					FROM (SELECT * FROM Sync_Changes WHERE Seq > ?1 ORDER BY Seq ASC LIMIT ?2)
				)
				WHERE Orden = 1 OR Bytes_Hasta_Aqui <= ?4
				ORDER BY Seq ASC;
			`,
				args: [since, limit, BYTES_POR_CAMBIO, maxBytes],
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
}

// POST /v1/sync/changes  { since?: number, limit?: number }
// Devuelve las operaciones con Seq > since en orden ascendente, hasta `limit` y sin pasar de
// `CAMBIOS_MAX_BYTES`, el final del log (`highWater`) y el mayor Seq que ya se purgó
// (`purgadoHasta`, AUD-19).
syncRoutes.post("/changes", cuerpoTolerante(changesSchema), async (c) => {
	const { since, limit } = c.req.valid("json");

	const { items, highWater, purgadoHasta } = await tenantQuery(c, (db) => leerPaginaDeCambios(db, since, limit));

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
					bytes += bytesUtf8(JSON.stringify(fila)) + 1;
					n++;
				}
				const fijo = bytesUtf8(JSON.stringify({ nombre, columnas, parcial: true, filas: [] })) + 1;
				pesos.set(nombre, { fijo, porFila: n ? bytes / n : 0 });
			}
			return pesos;
		},
	);
}

/** Lo que mide una ventana antes de volcarla: sus filas, contadas, y sus bytes, estimados. */
type Medida = { filas: number; bytes: number };

/**
 * Mide ventanas de una misma base: cuenta EXACTAMENTE las filas que entrarían
 * (`contadorDeVentanas`) y estima sus bytes con el peso de cada tabla.
 */
function medidorDeVentanas(lector: Lector, tablas: string[], pesos: Map<string, Peso>): (desde: string) => Promise<Medida> {
	const contar = contadorDeVentanas(lector, tablas);
	return async (desde) => {
		const medida: Medida = { filas: 0, bytes: 0 };
		for (const [t, n] of await contar(desde)) {
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
 *   (Sólo donde escribir para a tiempo, `paraAlEscribir`: con el lector de un cliente, intentarlo es
 *   traer todas las filas antes de escribir, así que allí la estimación sí descarta.)
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
	maxBytes: number = HISTORICO_MAX_BYTES,
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
				if (n > 0 && e.ocupado + bytesUtf8(texto) + 1 + CIERRE_DE_PAGINA > maxBytes) {
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
// Crea la base de un negocio que no la tiene **y que no ha nacido**. La acción es explícita desde
// la UI y jamás se usa como fallback de un timeout, un 500 o una migración rota.
//
// DO-PERDIDA: que el objeto esté vacío no basta. Si alguna licencia del negocio llegó a activarse,
// su base existió y no está donde se la busca: `provisionTenantDatabase` lanza
// `tenant_db_perdida` y aquí no se crea nada (`lib/basePerdida.ts`). Como la activación crea la
// base antes de apuntar la licencia, eso es lo que encuentra cualquier equipo que llega con su
// token; la ruta queda para un negocio cuya licencia no conste como activada.
//
// Corre dentro del TenantHub del negocio, como todo este router: la base se mira y se crea con el
// DO de al lado (`hubLocal`), no llamando por RPC al mismo objeto que está atendiendo la petición.
syncRoutes.post("/initialize-empty", async (c) => {
	const { reused } = await provisionTenantDatabase(getDb(c.env), c.env, c.get("tenantId"));
	if (reused) {
		return c.json(
			{ ok: false, code: "conflict", error: "tenant_db_already_provisioned" },
			409,
		);
	}
	return c.json({ ok: true });
});

/* ===== El contraste por resúmenes (`verificar.ts`) ===== */

// POST /v1/sync/verificar/resumen  { checkpoint?: number }
// El resumen por cubos de la ventana, o `{ aplazar: true }` si no es el momento: el negocio está
// escribiendo, o a la Main le falta por aplicar algo de lo que hay en el log.
syncRoutes.post("/verificar/resumen", cuerpoTolerante(verificarResumenSchema), async (c) => {
	const { checkpoint } = c.req.valid("json");
	return enJson(
		await resumenDeVerificacion(lectorDe(c), {
			checkpoint,
			deviceId: c.get("deviceId"),
			clientNow: c.req.header("x-client-now"),
			ahoraMs: Date.now(),
		}),
	);
});

// POST /v1/sync/verificar/filas  { tabla, desde, cubos, pedir: number[], cursor?: number }
// Las filas de los cubos que a la Main no le cuadran, por páginas.
syncRoutes.post("/verificar/filas", cuerpoTolerante(verificarFilasSchema), async (c) => {
	const pedido = c.req.valid("json");
	// El nombre de tabla se interpola en el SQL: sólo una tabla de negocio, como en `/historico`.
	if (!esTablaVerificable(pedido.tabla)) {
		return c.json({ ok: false, code: "validation", error: "tabla_no_verificable" }, 400);
	}
	if (!cubosValidos(pedido.cubos)) {
		return c.json({ ok: false, code: "validation", error: "cubos_no_validos" }, 400);
	}
	return enJson(await filasDeLosCubos(lectorDe(c), pedido));
});

// POST /v1/sync/verificar/por-clave  { tabla, claves: unknown[][] }
// Unas filas por su clave primaria, estén o no en la ventana.
syncRoutes.post("/verificar/por-clave", cuerpoTolerante(verificarPorClaveSchema), async (c) => {
	const pedido = c.req.valid("json");
	if (!esTablaVerificable(pedido.tabla)) {
		return c.json({ ok: false, code: "validation", error: "tabla_no_verificable" }, 400);
	}
	const filas = await filasPorClave(lectorDe(c), pedido);
	if (!filas) return c.json({ ok: false, code: "validation", error: "claves_no_validas" }, 400);
	return enJson(filas);
});

// POST /v1/sync/verificar/claves  { tabla, cursor?: unknown[], limite?: number }
// Las claves primarias de una tabla entera, por páginas y en orden de clave.
syncRoutes.post("/verificar/claves", cuerpoTolerante(verificarClavesPorPaginasSchema), async (c) => {
	const pedido = c.req.valid("json");
	if (!esTablaVerificable(pedido.tabla)) {
		return c.json({ ok: false, code: "validation", error: "tabla_no_verificable" }, 400);
	}
	const pagina = await paginaDeClaves(lectorDe(c), pedido);
	if (!pagina) return c.json({ ok: false, code: "validation", error: "cursor_no_valido" }, 400);
	return enJson(pagina);
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
			borradas: datos.borradas,
			aplazado: datos.aplazado,
			filas_examinadas: datos.filas_examinadas,
			tablas_sin_comparar: datos.tablas_sin_comparar,
			ventana_omitida: datos.ventana_omitida,
			reparacion_apagada: datos.reparacion_apagada,
		}),
	);

	return c.json({ ok: true });
});
