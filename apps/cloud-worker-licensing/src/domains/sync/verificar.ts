// src/domains/sync/verificar.ts
//
// El contraste de la nube con la Main, por resúmenes (`docs/arquitectura/sincronizacion.md`).
//
// La Main comprueba cada día que su base y la de la nube dicen lo mismo. Bajarse la ventana para
// compararla fila a fila no escala: la de un bar con mucho movimiento no cabe en una respuesta, y
// entonces sólo se comparaban los conteos. Aquí no viaja ninguna fila que no haga falta:
//
//   /v1/sync/verificar/resumen   por tabla: cuántas filas tiene, la sentencia de su ventana y el
//                                resumen por cubos de esa ventana (`resumenCubos.ts`). La Main
//                                ejecuta la misma sentencia en su base y compara los resúmenes.
//   /v1/sync/verificar/filas     las filas de los cubos que no cuadran, por páginas.
//   /v1/sync/verificar/por-clave unas filas por su clave, dentro o fuera de la ventana: las que la
//                                Main tiene en un cubo que no cuadra y no le han llegado con él.
//   /v1/sync/verificar/claves    las claves de una tabla, por páginas y en orden de clave: para lo
//                                que no cuadra fuera de la ventana, donde sólo hay conteos.
//
// Tres reglas:
//
// - **El resumen es una foto.** Se calcula de una vez, sin esperar a nada, y lleva el `Seq` del final
//   del log (`hasta_seq`). Cada página de filas o de claves lleva el suyo: si no es el mismo, algo se
//   ha escrito entre medias y la Main deja la pasada para luego.
// - **La definición de la ventana vive aquí y sólo aquí** (`bootstrap.ventana.ts`). La Main no la
//   reproduce: recibe la sentencia de cada tabla y la ejecuta tal cual.
// - **El coste de cada respuesta tiene techo.** El resumen no pasa de `RESUMEN_MAX_FILAS` filas
//   leídas (si el mes no cabe, la ventana se encoge como en la recuperación) y ocupa del orden de
//   100 KB; una página de filas o de claves, sus bytes.

import { bytesUtf8 } from "../../lib/texto";
import { PURGADO_HASTA } from "./cambiosJson";
import { esTablaDeNegocio, sentenciaVolcado, ventanasCandidatas } from "./bootstrap.ventana";
import { SQL_SEQ, contadorDeVentanas, leerPuntoDePartida, seqDe } from "./puntoDePartida";
import { FiltroDeCubos, Resumidor, cubosPara, type ResumenCubos } from "./resumenCubos";
import {
	Escritor,
	enBytes,
	primerValor,
	siguiente,
	type Lector,
	type Resultado,
	type Sentencia,
} from "./volcado";

/**
 * Lo más que lee un resumen, en filas. Resumir es leer cada fila de la ventana y hacerle su hash, sin
 * soltar el hilo del TenantHub: es CPU del objeto, y mientras dura no atiende a nadie más.
 *
 * Medido en local (`test/verificarVolumen.test.ts`) con el mes de un bar de mil comandas diarias,
 * 690.000 filas: 2,6 s sólo leerlas y 3,9 s el resumen entero, con sus conteos; unos 6 microsegundos
 * por fila. Un millón deja entrar ese mes con holgura y acota el peor caso a unos segundos; un
 * negocio mayor resume una ventana más estrecha.
 */
export const RESUMEN_MAX_FILAS = 1_000_000;

/**
 * Lo mismo con el lector de un cliente, que sólo usa un router montado suelto en un test
 * (`tenantQuery` de mentira, `volcado.ts`): allí las filas no se leen del cursor del DO, sino que
 * llegan enteras en memoria antes de escribir nada. A unos 180 bytes por fila, cien mil quedan muy
 * por debajo de lo que eso aguanta.
 */
const RESUMEN_MAX_FILAS_CON_UN_CLIENTE = 100_000;

/**
 * Lo que tiene que llevar quieta la base para resumirla. Con una escritura reciente el negocio está
 * trabajando: la foto caducaría antes de que la Main la comparase, y el resumen ocuparía el hilo
 * que atiende a las Handy.
 */
export const CALMA_PARA_RESUMIR_MS = 2 * 60 * 1000;

/** Lo que se le dice a la Main que espere cuando lo que falta es que le lleguen cambios. */
const ESPERA_SI_VA_POR_DETRAS_S = 60;

/** Techo de una página de filas, en bytes de JSON. */
const FILAS_MAX_BYTES = 4 * 1024 * 1024;

/** Techo de una página de claves, en bytes de JSON. Sus topes de filas, en `sync.schemas.ts`. */
const CLAVES_MAX_BYTES = 2 * 1024 * 1024;

/**
 * Lo más que recorre de la ventana una página de filas. La sentencia de la ventana lleva su
 * `LIMIT … OFFSET …`: lo que se salta lo salta SQLite, sin cruzar a JavaScript, y lo que viene detrás
 * no se lee (un `desde` que no es el del resumen no recorre años de histórico). Al llegar, la página
 * se corta con su cursor aunque no lleve ninguna fila.
 */
const FILAS_RECORRIDAS_POR_PAGINA = RESUMEN_MAX_FILAS;

/** Lo que ocupa el final de una página, sin contar el cursor de claves: el `Seq` y la sintaxis. */
const CIERRE_DE_PAGINA = 256;

/** Quién pide el resumen, y cuándo. */
type QuienPregunta = {
	/** El checkpoint de la Main: hasta qué `Seq` ha aplicado lo de los demás. `null` si no lo dice. */
	checkpoint: number | null;
	/** Su dispositivo: lo que escribió ella no le falta. */
	deviceId: string;
	/** Su hora (`X-Client-Now`): de ella sale la ventana. */
	clientNow: unknown;
	/** La hora de la nube, en milisegundos: con ella se mide la calma. */
	ahoraMs: number;
};

type Aplazado = { motivo: "actividad" | "por_delante" | "desfase"; reintentarEnS: number };

/* ===== ¿Es el momento? ===== */

/**
 * Las cuatro lecturas que dicen si se puede resumir ahora, cada una de una fila: la última escritura
 * del log, si hay algo ajeno por encima del checkpoint de quien pregunta, y hasta dónde se ha
 * purgado el log (la marca de la purga y su primer `Seq` conservado, como en `/v1/sync/changes`).
 */
function sentenciasDelMomento(quien: QuienPregunta): Sentencia[] {
	return [
		{ sql: "SELECT Seq, Created_At_Ms FROM Sync_Changes ORDER BY Seq DESC LIMIT 1;", args: [] },
		{
			// `IS NOT` y no `<>`: un cambio sin dispositivo (lo que escribe la propia nube) es ajeno.
			sql: "SELECT 1 FROM Sync_Changes WHERE Seq > ?1 AND Device_Id IS NOT ?2 LIMIT 1;",
			args: [quien.checkpoint ?? 0, quien.deviceId],
		},
		{ sql: "SELECT MIN(Seq) AS primero FROM Sync_Changes;", args: [] },
		{ sql: "SELECT Last_Seq AS purgado FROM Sync_Main_Checkpoints WHERE Device_Id = ?1;", args: [PURGADO_HASTA] },
	];
}

function primeraFila(r: Resultado): unknown[] | null {
	for (const fila of r.filas) return fila;
	return null;
}

/**
 * Lee las cuatro lecturas de `sentenciasDelMomento` y dice si hay que aplazar.
 *
 * - `actividad`: se ha escrito hace menos de `CALMA_PARA_RESUMIR_MS`.
 * - `por_delante`: por encima del checkpoint de la Main hay cambios que no son suyos. Todavía no
 *   los ha aplicado, así que su base no es la de esta foto: compararlas daría por descuadre lo que
 *   está de camino.
 * - `desfase`: su checkpoint y el log no casan. O va por delante del final del log, o por debajo de
 *   lo purgado: entre medias pudo haber cambios ajenos que ya no están para mirarlos.
 *
 * Lo que la Main escribió ella misma no cuenta: su checkpoint sólo avanza con lo que le llega de
 * los demás, así que tras un día de ventas propias va por detrás del final del log sin que le falte
 * nada. Que no le quede nada suyo por subir lo comprueba ella, con su outbox.
 */
function mirarElMomento(rs: Iterator<Resultado>, quien: QuienPregunta): { hastaSeq: number; aplazar: Aplazado | null } {
	const ultima = primeraFila(siguiente(rs));
	const hayAjeno = primerValor(siguiente(rs)) !== null;
	const primero = primerValor(siguiente(rs));
	const marca = Number(primerValor(siguiente(rs)) ?? 0);

	const hastaSeq = Number(ultima?.[0] ?? 0);
	if (ultima) {
		const edad = quien.ahoraMs - Number(ultima[1] ?? 0);
		if (edad < CALMA_PARA_RESUMIR_MS) {
			// Una escritura fechada por delante del reloj cuenta como recién hecha.
			const falta = Math.min(CALMA_PARA_RESUMIR_MS, CALMA_PARA_RESUMIR_MS - edad);
			return { hastaSeq, aplazar: { motivo: "actividad", reintentarEnS: Math.max(1, Math.ceil(falta / 1000)) } };
		}
	}
	if (quien.checkpoint !== null) {
		if (hayAjeno) return { hastaSeq, aplazar: { motivo: "por_delante", reintentarEnS: ESPERA_SI_VA_POR_DETRAS_S } };
		const purgadoHasta = Math.max(marca, primero == null ? 0 : Number(primero) - 1);
		if (quien.checkpoint > hastaSeq || quien.checkpoint < purgadoHasta) {
			return { hastaSeq, aplazar: { motivo: "desfase", reintentarEnS: ESPERA_SI_VA_POR_DETRAS_S } };
		}
	}
	return { hastaSeq, aplazar: null };
}

function respuestaAplazada(hastaSeq: number, a: Aplazado): Uint8Array<ArrayBuffer> {
	return enBytes(
		JSON.stringify({ ok: true, aplazar: true, motivo: a.motivo, reintentar_en_s: a.reintentarEnS, hasta_seq: hastaSeq }),
	);
}

/* ===== El resumen ===== */

/** Las columnas de la clave primaria de una tabla, en el orden de la clave. */
function sqlClaves(tabla: string): Sentencia {
	return { sql: "SELECT name FROM pragma_table_info(?1) WHERE pk > 0 ORDER BY pk;", args: [tabla] };
}

function leerClaves(r: Resultado): string[] {
	return [...r.filas].map((f) => String(f[0] ?? ""));
}

/**
 * Dónde está, en las columnas de la tabla, cada columna de su clave. `null` si la tabla no tiene
 * clave primaria: sin ella una fila no tiene cubo ni se puede buscar en el otro lado.
 */
function posicionesDeLaClave(columnas: string[], claves: string[]): number[] | null {
	if (!claves.length) return null;
	const posiciones = claves.map((k) => columnas.indexOf(k));
	return posiciones.every((p) => p >= 0) ? posiciones : null;
}

/**
 * El límite inferior de la ventana que se resume: la más ancha de las candidatas cuyas filas no
 * pasan de `maxFilas`, o `null` si no cabe ni la más estrecha.
 *
 * Con todo el negocio por debajo del tope —lo normal— no hay nada que medir: la ventana no puede
 * tener más filas que las tablas enteras.
 */
async function ventanaQueSeResume(
	lector: Lector,
	tablas: string[],
	candidatas: string[],
	maxFilas: number,
): Promise<string | null> {
	const enteras = await lector.foto(
		tablas.map((t) => ({ sql: `SELECT COUNT(*) AS n FROM "${t}";`, args: [] })),
		(rs) => tablas.reduce((n) => n + Number(primerValor(siguiente(rs)) ?? 0), 0),
	);
	if (enteras <= maxFilas) return candidatas[0];

	const contar = contadorDeVentanas(lector, tablas);
	for (const desde of candidatas) {
		let filas = 0;
		for (const n of (await contar(desde)).values()) filas += n;
		if (filas <= maxFilas) return desde;
	}
	return null;
}

/**
 * Lo que el resumen dice de una tabla. Con la ventana omitida sólo lleva `nombre` y `total`.
 */
type TablaResumida = {
	nombre: string;
	/** Filas de la tabla ENTERA: lo único que ve lo que falta o sobra fuera de la ventana. */
	total: number;
	/** La sentencia de su ventana, con sus argumentos: la Main ejecuta esto mismo. */
	sql?: string;
	args?: unknown[];
	columnas?: string[];
	/** Las columnas de su clave primaria. Vacío: la tabla no se compara por valores. */
	claves?: string[];
	/** Filas de la ventana. */
	filas?: number;
} & Partial<ResumenCubos>;

/**
 * El resumen del negocio para contrastar: por tabla, sus filas, la sentencia de su ventana y el
 * resumen por cubos de lo que esa sentencia devuelve.
 *
 * La ventana es la de la fase 1 de la recuperación (`bootstrap.ventana.ts`): los maestros enteros y
 * los transaccionales de 30 días, estirados hasta el último cierre de caja. Si pasa de `maxFilas`
 * se encoge por los mismos escalones, y si no cabe ni lo imprescindible van los conteos solos, con
 * `ventana_omitida`.
 *
 * Todo lo que se compara sale de UNA foto: las cuatro lecturas del momento, los conteos, las filas
 * y el `Seq`. Dentro del TenantHub eso es un tramo sin esperas, y ninguna escritura se intercala.
 */
export async function resumenDeVerificacion(
	lector: Lector,
	quien: QuienPregunta,
	maxFilas: number = lector.paraAlEscribir ? RESUMEN_MAX_FILAS : RESUMEN_MAX_FILAS_CON_UN_CLIENTE,
): Promise<Uint8Array<ArrayBuffer>> {
	// Antes de medir nada: si no es el momento, la respuesta cuesta cuatro lecturas de una fila.
	const antes = await lector.foto(sentenciasDelMomento(quien), (rs) => mirarElMomento(rs, quien));
	if (antes.aplazar) return respuestaAplazada(antes.hastaSeq, antes.aplazar);

	const { tablas, ultimoCierre } = await leerPuntoDePartida(lector);
	const candidatas = ventanasCandidatas(quien.clientNow, ultimoCierre);
	const desde = await ventanaQueSeResume(lector, tablas, candidatas, maxFilas);

	const sentencias: Sentencia[] = sentenciasDelMomento(quien);
	const ventanas = new Map<string, Sentencia>();
	for (const t of tablas) {
		sentencias.push(sqlClaves(t), { sql: `SELECT COUNT(*) AS n FROM "${t}";`, args: [] });
		if (desde !== null) {
			const ventana = sentenciaVolcado(t, desde);
			ventanas.set(t, ventana);
			sentencias.push(ventana);
		}
	}
	sentencias.push(SQL_SEQ);

	return lector.foto(sentencias, (rs) => {
		// Otra vez, ya dentro de la foto: entre la primera mirada y ésta ha habido esperas.
		const momento = mirarElMomento(rs, quien);
		if (momento.aplazar) return respuestaAplazada(momento.hastaSeq, momento.aplazar);

		const resumidas: TablaResumida[] = [];
		for (const nombre of tablas) {
			const claves = leerClaves(siguiente(rs));
			const total = Number(primerValor(siguiente(rs)) ?? 0);
			const ventana = ventanas.get(nombre);
			if (!ventana) {
				resumidas.push({ nombre, total });
				continue;
			}

			const { columnas, filas } = siguiente(rs);
			const posiciones = posicionesDeLaClave(columnas, claves);
			const resumidor = new Resumidor();
			let n = 0;
			for (const fila of filas) {
				if (posiciones) resumidor.fila(fila, posiciones);
				n++;
			}
			resumidas.push({
				nombre,
				total,
				sql: ventana.sql,
				args: ventana.args,
				columnas,
				claves: posiciones ? claves : [],
				filas: n,
				// Sin clave no hay cubos: un resumen de un cubo vacío, que la Main no compara.
				...(posiciones ? resumidor.resumen() : { cubos: 1, cuentas: [0], sumas: ["0000000000000000"] }),
			});
		}

		return enBytes(
			JSON.stringify({
				ok: true,
				aplazar: false,
				// Por encima de este `Seq` no hay en el log nada que no sea de quien pregunta.
				checkpoint: quien.checkpoint,
				hasta_seq: seqDe(siguiente(rs)),
				desde: desde ?? candidatas[0],
				ventana_omitida: desde === null,
				tablas: resumidas,
			}),
		);
	});
}

/* ===== Las filas de los cubos que no cuadran ===== */

type PedidoDeFilas = {
	tabla: string;
	/** El límite inferior de la ventana, el `desde` del resumen. */
	desde: string;
	/** En cuántos cubos venía resumida la tabla. */
	cubos: number;
	/** Los cubos que se piden. */
	pedir: readonly unknown[];
	/** Cuántas filas de la ventana se han recorrido ya: el `siguiente_cursor` de la página anterior. */
	cursor: number;
};

/** Una fila como viaja. Un blob no tiene forma en JSON: va como `{"blob": "<hex>"}`. */
function filaEnJson(fila: unknown[]): string {
	return JSON.stringify(fila, (_clave, v) => {
		if (!(v instanceof ArrayBuffer)) return v;
		let hex = "";
		for (const b of new Uint8Array(v)) hex += b.toString(16).padStart(2, "0");
		return { blob: hex };
	});
}

/**
 * Una página de las filas de `tabla` que caen en los cubos pedidos, ya en JSON.
 *
 * Recorre la ventana con la MISMA sentencia que el resumen, con su `LIMIT … OFFSET …`, y se queda con
 * las filas cuyo cubo se pide. El cursor es cuántas filas de la ventana lleva recorridas: la página
 * siguiente vuelve a ejecutar la sentencia desde ahí, con el mismo plan y por tanto el mismo orden.
 * Sólo vale mientras la base no cambie, y por eso cada página lleva su `hasta_seq`: la Main lo compara
 * con el del resumen y, si no es el mismo, tira lo que lleva.
 *
 * Se corta antes de pasar de `maxBytes`, y nunca sin al menos una fila: una fila que sola pasa del
 * techo viaja igual, como en el histórico, porque rechazarla dejaría su cubo sin comparar para
 * siempre. También se corta, con o sin filas, al recorrer `FILAS_RECORRIDAS_POR_PAGINA` filas de la
 * ventana. De una tabla sin clave primaria —o que este negocio no tiene— no hay filas que dar: no
 * tienen cubo.
 */
export async function filasDeLosCubos(
	lector: Lector,
	{ tabla, desde, cubos, pedir, cursor }: PedidoDeFilas,
	maxBytes: number = FILAS_MAX_BYTES,
	maxRecorridas: number = FILAS_RECORRIDAS_POR_PAGINA,
): Promise<Uint8Array<ArrayBuffer>> {
	const cabecera = `{"ok":true,"tabla":${JSON.stringify(tabla)}`;
	const claves = await lector.foto([sqlClaves(tabla)], (rs) => leerClaves(siguiente(rs)));
	if (!claves.length) {
		const hastaSeq = await lector.foto([SQL_SEQ], (rs) => seqDe(siguiente(rs)));
		return enBytes(`${cabecera},"columnas":[],"filas":[],"siguiente_cursor":null,"hasta_seq":${hastaSeq}}`);
	}

	// La ventana, desde el cursor y con una fila más que el tope: si llega, hay más detrás.
	const ventana = sentenciaVolcado(tabla, desde);
	const n = ventana.args.length;
	const tramo: Sentencia = {
		sql: `${ventana.sql.replace(/;\s*$/, "")} LIMIT ?${n + 1} OFFSET ?${n + 2};`,
		args: [...ventana.args, maxRecorridas + 1, cursor],
	};

	// El `Seq` va delante de la ventana: así se lee aunque la página se corte a mitad de ella.
	return lector.foto([SQL_SEQ, tramo], (rs) => {
		const hastaSeq = seqDe(siguiente(rs));
		const { columnas, filas } = siguiente(rs);
		const posiciones = posicionesDeLaClave(columnas, claves);
		const filtro = new FiltroDeCubos(cubos, pedir);

		const e = new Escritor(maxBytes);
		e.texto(`${cabecera},"columnas":${JSON.stringify(columnas)},"filas":[`);
		let vistas = cursor;
		let escritas = 0;
		let siguienteCursor: number | null = null;
		if (posiciones) {
			for (const fila of filas) {
				const i = vistas++;
				if (i - cursor >= maxRecorridas) {
					siguienteCursor = i;
					break;
				}
				if (!filtro.pide(fila, posiciones)) continue;
				const texto = filaEnJson(fila);
				if (escritas > 0 && e.ocupado + bytesUtf8(texto) + 1 + CIERRE_DE_PAGINA > maxBytes) {
					siguienteCursor = i;
					break;
				}
				e.texto(escritas ? `,${texto}` : texto);
				escritas++;
			}
		}
		e.texto(`],"siguiente_cursor":${JSON.stringify(siguienteCursor)},"hasta_seq":${hastaSeq}}`);
		return e.todo();
	});
}

/* ===== Las claves de una tabla, por páginas ===== */

type PedidoDeClaves = {
	tabla: string;
	/** La última clave de la página anterior, o `null` para empezar. */
	cursor: readonly unknown[] | null;
	limite: number;
};

const comillas = (nombre: string) => `"${nombre.replace(/"/g, '""')}"`;

/** Un valor de clave que se puede enlazar como cursor: un texto o un número. */
function valorDeCursor(v: unknown): v is string | number {
	return typeof v === "string" || (typeof v === "number" && Number.isFinite(v));
}

/**
 * Una página de las claves primarias de `tabla`, en orden de clave y ya en JSON. `null` si el
 * cursor no es una clave de esa tabla.
 *
 * Sobre la tabla ENTERA: es para lo que no cuadra fuera de la ventana, donde lo único que hay son
 * los conteos. Va por páginas y en orden de clave para que la Main reste los dos conjuntos tramo a
 * tramo, sin tener ninguno entero en memoria: de cada página lee en su base las claves del mismo
 * tramo, que ordena el mismo SQLite con el mismo esquema.
 *
 * La página lleva hasta `limite` claves y no pasa de `maxBytes`. Si queda algo detrás, su
 * `siguiente_cursor` es la última clave que lleva.
 */
export async function paginaDeClaves(
	lector: Lector,
	{ tabla, cursor, limite }: PedidoDeClaves,
	maxBytes: number = CLAVES_MAX_BYTES,
): Promise<Uint8Array<ArrayBuffer> | null> {
	const claves = await lector.foto([sqlClaves(tabla)], (rs) => leerClaves(siguiente(rs)));
	const cabecera = `{"ok":true,"tabla":${JSON.stringify(tabla)},"columnas":${JSON.stringify(claves)},"claves":[`;
	if (!claves.length) {
		// Sin clave primaria (o sin tabla, en un negocio con el esquema por detrás) no hay nada que listar.
		const hastaSeq = await lector.foto([SQL_SEQ], (rs) => seqDe(siguiente(rs)));
		return enBytes(`${cabecera}],"siguiente_cursor":null,"hasta_seq":${hastaSeq}}`);
	}
	if (cursor !== null && (cursor.length !== claves.length || !cursor.every(valorDeCursor))) return null;

	const columnas = claves.map(comillas).join(", ");
	const desde = cursor ? ` WHERE (${columnas}) > (${cursor.map((_, i) => `?${i + 1}`).join(", ")})` : "";
	const listar: Sentencia = {
		sql: `SELECT ${columnas} FROM "${tabla}"${desde} ORDER BY ${columnas} LIMIT ?${(cursor?.length ?? 0) + 1};`,
		args: [...(cursor ?? []), limite],
	};

	return lector.foto([SQL_SEQ, listar], (rs) => {
		const hastaSeq = seqDe(siguiente(rs));
		const e = new Escritor(maxBytes);
		e.texto(cabecera);
		let n = 0;
		let ultima: unknown[] | null = null;
		let cortada = false;
		for (const clave of siguiente(rs).filas) {
			const texto = JSON.stringify(clave);
			// La clave cuenta dos veces: si es la última que entra, es también el cursor.
			if (n > 0 && e.ocupado + 2 * bytesUtf8(texto) + 1 + CIERRE_DE_PAGINA > maxBytes) {
				cortada = true;
				break;
			}
			e.texto(n ? `,${texto}` : texto);
			ultima = clave;
			n++;
		}
		// Una página que se llena, o que se corta por tamaño, puede tener más detrás.
		const siguienteCursor = cortada || n === limite ? ultima : null;
		e.texto(`],"siguiente_cursor":${JSON.stringify(siguienteCursor)},"hasta_seq":${hastaSeq}}`);
		return e.todo();
	});
}

/* ===== Unas filas por su clave ===== */

type PedidoPorClave = {
	tabla: string;
	/** Las claves primarias de las filas que se piden, cada una con sus valores en el orden de la clave. */
	claves: readonly unknown[][];
};

/**
 * Las filas de `tabla` con esas claves primarias, estén o no en la ventana, ya en JSON. `null` si
 * alguna no es una clave de esa tabla.
 *
 * Es para lo que la Main tiene en la ventana y no ha venido en su cubo: o falta arriba, o está
 * arriba fuera de la ventana (la de una comanda depende de sus cobros, por ejemplo), y sólo
 * comparándola se sabe si además es distinta. Una fila que no viene no está.
 *
 * Se corta antes de pasar de `maxBytes`, nunca sin al menos una fila, y lo dice (`cortada`): las que
 * no han cabido se vuelven a pedir.
 */
export async function filasPorClave(
	lector: Lector,
	{ tabla, claves: pedidas }: PedidoPorClave,
	maxBytes: number = FILAS_MAX_BYTES,
): Promise<Uint8Array<ArrayBuffer> | null> {
	const claves = await lector.foto([sqlClaves(tabla)], (rs) => leerClaves(siguiente(rs)));
	const cabecera = `{"ok":true,"tabla":${JSON.stringify(tabla)}`;
	if (pedidas.some((k) => !Array.isArray(k) || k.length !== claves.length || !k.every(valorDeCursor))) return null;
	if (!claves.length || !pedidas.length) {
		const hastaSeq = await lector.foto([SQL_SEQ], (rs) => seqDe(siguiente(rs)));
		return enBytes(`${cabecera},"columnas":[],"filas":[],"cortada":false,"hasta_seq":${hastaSeq}}`);
	}

	// Las claves van en UN parámetro, como JSON: el SQLite del DO no admite más de cien por
	// sentencia, y una tanda de la Main son quinientas.
	const columnas = claves.map(comillas).join(", ");
	const valores = claves.map((_, i) => `json_extract(value, '$[${i}]')`).join(", ");
	const buscar: Sentencia = {
		sql:
			claves.length === 1
				? `SELECT * FROM "${tabla}" WHERE ${columnas} IN (SELECT json_extract(value, '$[0]') FROM json_each(?1));`
				: `SELECT * FROM "${tabla}" WHERE (${columnas}) IN (SELECT ${valores} FROM json_each(?1));`,
		args: [JSON.stringify(pedidas)],
	};

	return lector.foto([SQL_SEQ, buscar], (rs) => {
		const hastaSeq = seqDe(siguiente(rs));
		const { columnas: nombres, filas } = siguiente(rs);
		const e = new Escritor(maxBytes);
		e.texto(`${cabecera},"columnas":${JSON.stringify(nombres)},"filas":[`);
		let escritas = 0;
		let cortada = false;
		for (const fila of filas) {
			const texto = filaEnJson(fila);
			if (escritas > 0 && e.ocupado + bytesUtf8(texto) + 1 + CIERRE_DE_PAGINA > maxBytes) {
				cortada = true;
				break;
			}
			e.texto(escritas ? `,${texto}` : texto);
			escritas++;
		}
		e.texto(`],"cortada":${cortada},"hasta_seq":${hastaSeq}}`);
		return e.todo();
	});
}

/** ¿Es `tabla` una tabla de negocio por la que se puede preguntar? Su nombre se interpola en el SQL. */
export function esTablaVerificable(tabla: unknown): tabla is string {
	return typeof tabla === "string" && /^[A-Za-z0-9_]{1,64}$/.test(tabla) && esTablaDeNegocio(tabla);
}
