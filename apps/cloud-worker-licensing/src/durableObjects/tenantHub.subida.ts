// src/durableObjects/tenantHub.subida.ts
//
// DO-SUBIDA · La Main sube su base entera a una nube que soporte le ha devuelto en modo «main».
//
// Soporte puede dar a un negocio una base vacía, su copia de R2 o devolver la suya a un instante
// (`tenantHub.instante.ts`, `tenantHub.restaurar.ts`). Con `--modo main` la Main es la buena y sigue
// con su base; sin esto sólo subía su outbox, y lo que la nube no tenía y la Main ya había subido lo
// iba reparando el contraste por tandas, en sus momentos tranquilos y con sus topes por pasada.
// Mientras, las Handy veían una nube a medias.
//
// Aquí está lo que el objeto hace de su parte:
//
// - **La petición** (`_Subida_Completa`, una fila en el SQL del objeto: sobrevive a la hibernación y
//   a los reinicios). La apunta `abrirLogTrasVolver` en la misma transacción que abre el log, sin
//   dueño: la primera Main vigente que salude (comprobada contra la base central) se la queda. No se
//   ata a `_Main_Vigente`: tras volver a un instante, esa tabla también ha vuelto y nombraría a la Main
//   de entonces.
//   Una vuelta en modo «nube» la borra. La copia de R2 no la trae (empieza por `_`), y `vaciarObjeto`
//   se la lleva.
// - **El saludo** (`subidaParaElSaludo`): el `hello_ok` de esa Main lleva `subida: {id, estado,
//   origen}`. A una Handy no se le dice nunca. Si saluda como Main vigente OTRO dispositivo (un
//   traslado a mitad), la petición queda `huerfana` y se avisa.
// - **Los pasos** (`ejecutarPasoDeSubida`), que llegan por el socket (`{type: "subida"}`): `plan`,
//   `tramos`, `huellas`, `filas`, `sobrantes` y `fin`. Llevan **datos, no SQL**: el objeto casa la
//   tabla y las columnas con su propio esquema y construye él la sentencia, un `INSERT … SELECT …
//   FROM json_each(?1) … ON CONFLICT(clave) DO UPDATE … WHERE algo cambia` con la lista en un solo
//   parámetro (DO-01). Nunca `REPLACE` y nunca borra: los borrados van por el outbox, como cualquier
//   reparación (AUD-36 sigue mirándolos). Un registro de facturación sólo se inserta, y el
//   contador de una serie sólo sube.
// - **Lo ajeno manda**: una página de filas no entra si en el log hay algo de otro dispositivo por
//   encima del checkpoint con el que la Main la leyó (`aplazada`): la Main baja eso antes y la
//   vuelve a leer.
// - **Su propio presupuesto** (AUD-36): las páginas no gastan `_Presupuesto_Escritura`, así que el
//   outbox de la Main y las Handy siguen como siempre. Gastan el de la petición: por hora y un techo
//   total ligado a lo que la Main declaró que iba a subir. Pasado el techo, la petición queda
//   `agotada` y sólo la reabre la administración.
// - **No toca el log**: ni `Sync_Changes`, ni `Applied_Operations`, ni difusión de filas. Al acabar
//   cada tabla se avisa a las Handy (`datos_subidos`) para que relean.
//
// Sin estado de instancia (SYNC-16): funciones libres sobre el SQL del objeto.

import { HubError } from "../lib/errorHttp";
import { esTablaDeNegocio, esTransaccional, sentenciaVolcado, VENTANA_DIAS } from "../domains/sync/bootstrap.ventana";
import { Canonico, hex64, SumaDeTramo } from "../domains/sync/resumenCubos";
import { esFalloPasajero } from "./tenantHub.errores";
import { parseClientNow, serverNowFixed } from "./tenantHub.tiempo";

type Almacen = DurableObjectStorage;

export type OrigenDeSubida = "instante" | "copia" | "base_vacia";
export type EstadoDeSubida = "esperando" | "terminada" | "caducada" | "agotada" | "huerfana";

const HORA_MS = 60 * 60 * 1000;
const DIA_MS = 24 * HORA_MS;
const MIB = 1024 * 1024;

/**
 * Lo que tiene la Main para empezar la subida desde que se pide (o se reabre). Si no la ha empezado
 * para entonces, `caducada`; una empezada no caduca (`caducarSiToca`).
 */
export const PLAZO_DE_SUBIDA_MS = 14 * DIA_MS;

/** Sin ninguna página en este tiempo desde que se pidió, la alarma diaria avisa una vez. */
export const AVISO_SIN_EMPEZAR_MS = DIA_MS;

/**
 * Lo que puede escribir una subida (AUD-36). Por hora, para que no se coma el objeto; en total, para
 * que una Main (o quien tenga su licencia) no pueda reescribir la base sin fin con la exención. El
 * total es el menor entre `filasTotales` y `factorDeclaradas` veces lo que la Main dijo que iba a
 * subir, con un suelo: las filas escritas (`rowsWritten`) cuentan también las de los índices y los
 * triggers, unas cuatro o cinco por fila en las tablas con más índices.
 */
export type LimitesDeSubida = {
	filasPorHora: number;
	bytesPorHora: number;
	filasTotales: number;
	factorDeclaradas: number;
	sueloTotal: number;
	bytesTotales: number;
};

export const LIMITES_DE_SUBIDA: LimitesDeSubida = {
	filasPorHora: 10_000_000,
	bytesPorHora: 2048 * MIB,
	filasTotales: 60_000_000,
	factorDeclaradas: 10,
	sueloTotal: 1_000_000,
	bytesTotales: 6144 * MIB,
};

/** Lo que cabe en una página de filas. Una más grande se contesta `subida_pagina_demasiado_grande`. */
export const FILAS_POR_PAGINA = 5_000;
export const BYTES_POR_PAGINA = 1.5 * MIB;
/** Lo que cabe en un paso de comparación. */
export const HUELLAS_POR_PASO = 5_000;
export const TRAMOS_POR_PASO = 200;
export const CLAVES_POR_SOBRANTES = 20_000;
/** Las claves vivas que se mandan con el plan, entre todas las tablas. */
export const CLAVES_VIVAS_MAX = 20_000;

/** Lo fiscal sólo se inserta: un registro de facturación no se modifica nunca. */
const SOLO_INSERTAR: ReadonlySet<string> = new Set(["Registros_Facturacion"]);

/**
 * Los contadores: sólo suben. `Serie_Facturacion.Ultimo` es el último número de su serie, y la Main
 * lo sube en cada cobro con `Ultimo = Ultimo + 1`: si la subida no lo pusiera al día, la nube de una
 * copia se quedaría para siempre los cobros que perdió por detrás. Nunca baja.
 */
const MONOTONAS: Readonly<Record<string, readonly string[]>> = { Serie_Facturacion: ["Ultimo"] };

/** Lo que la subida hace con una fila que ya está arriba. Lo fiscal no se borra nunca (sin sobrantes). */
export type PoliticaDeSubida = "upsert" | "solo_insertar" | "monotono";

function politicaDe(tabla: string): PoliticaDeSubida {
	if (SOLO_INSERTAR.has(tabla)) return "solo_insertar";
	if (MONOTONAS[tabla]) return "monotono";
	return "upsert";
}

/** Lo que tiene un nombre de tabla o de columna que se acepta mirar en el esquema. */
const NOMBRE = /^[A-Za-z0-9_]{1,64}$/;

/** Una petición de subida, como está en su fila. */
export type PeticionDeSubida = {
	id: string;
	origen: OrigenDeSubida;
	mainDeviceId: string | null;
	inicioSeq: number;
	estado: EstadoDeSubida;
	desdeMs: number;
	hastaMs: number;
	filasDeclaradas: number | null;
	primeraPaginaMs: number | null;
	/** El primer paso de su Main desde que se pidió o se reabrió: desde ahí ya no caduca. */
	empezadaMs: number | null;
	terminadaMs: number | null;
	filasEscritas: number;
	bytesCrecidos: number;
	paginas: number;
	avisoSinEmpezarMs: number | null;
};

function asegurarTabla(sql: SqlStorage): void {
	// Ninguna columna lleva una hora por defecto: la pone quien escribe.
	sql.exec(`
		CREATE TABLE IF NOT EXISTS _Subida_Completa (
			Id INTEGER PRIMARY KEY CHECK (Id = 1),
			Id_Subida TEXT NOT NULL,
			Origen TEXT NOT NULL,
			Main_Device_Id TEXT,
			Inicio_Seq INTEGER NOT NULL,
			Estado TEXT NOT NULL,
			Desde_Ms INTEGER NOT NULL,
			Hasta_Ms INTEGER NOT NULL,
			Filas_Declaradas INTEGER,
			Primera_Pagina_Ms INTEGER,
			Empezada_Ms INTEGER,
			Terminada_Ms INTEGER,
			Filas_Escritas INTEGER NOT NULL DEFAULT 0,
			Bytes_Crecidos INTEGER NOT NULL DEFAULT 0,
			Paginas INTEGER NOT NULL DEFAULT 0,
			Hora_Ms INTEGER,
			Filas_Hora INTEGER,
			Bytes_Hora INTEGER,
			Aviso_Sin_Empezar_Ms INTEGER
		);
	`);
}

function existeLaTabla(sql: SqlStorage): boolean {
	return sql.exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '_Subida_Completa';").toArray().length > 0;
}

/**
 * Apunta la petición (o la sustituye por una nueva, con sus contadores a cero). La llama
 * `abrirLogTrasVolver` dentro de la transacción que abre el log.
 */
export function pedirSubida(
	sql: SqlStorage,
	p: { id: string; origen: OrigenDeSubida; mainDeviceId: string | null; inicioSeq: number; ahoraMs: number },
): void {
	asegurarTabla(sql);
	sql.exec(
		`INSERT INTO _Subida_Completa (Id, Id_Subida, Origen, Main_Device_Id, Inicio_Seq, Estado, Desde_Ms, Hasta_Ms,
		   Filas_Declaradas, Primera_Pagina_Ms, Empezada_Ms, Terminada_Ms, Filas_Escritas, Bytes_Crecidos, Paginas,
		   Hora_Ms, Filas_Hora, Bytes_Hora, Aviso_Sin_Empezar_Ms)
		 VALUES (1, ?1, ?2, ?3, ?4, 'esperando', ?5, ?6, NULL, NULL, NULL, NULL, 0, 0, 0, NULL, NULL, NULL, NULL)
		 ON CONFLICT(Id) DO UPDATE SET
		   Id_Subida = excluded.Id_Subida, Origen = excluded.Origen, Main_Device_Id = excluded.Main_Device_Id,
		   Inicio_Seq = excluded.Inicio_Seq, Estado = 'esperando', Desde_Ms = excluded.Desde_Ms,
		   Hasta_Ms = excluded.Hasta_Ms, Filas_Declaradas = NULL, Primera_Pagina_Ms = NULL, Empezada_Ms = NULL, Terminada_Ms = NULL,
		   Filas_Escritas = 0, Bytes_Crecidos = 0, Paginas = 0, Hora_Ms = NULL, Filas_Hora = NULL, Bytes_Hora = NULL,
		   Aviso_Sin_Empezar_Ms = NULL;`,
		p.id,
		p.origen,
		p.mainDeviceId,
		p.inicioSeq,
		p.ahoraMs,
		p.ahoraMs + PLAZO_DE_SUBIDA_MS,
	);
}

/** Quita la petición: la nube vuelve en modo «nube», y las Main se traen la nube. */
export function olvidarSubida(sql: SqlStorage): void {
	if (existeLaTabla(sql)) sql.exec("DELETE FROM _Subida_Completa;");
}

/** La petición, o `null` si no hay. No crea la tabla. */
export function leerSubida(sql: SqlStorage): PeticionDeSubida | null {
	if (!existeLaTabla(sql)) return null;
	const f = sql.exec("SELECT * FROM _Subida_Completa WHERE Id = 1;").toArray()[0] as Record<string, unknown> | undefined;
	if (!f) return null;
	const n = (v: unknown) => (v === null || v === undefined ? null : Number(v));
	return {
		id: String(f.Id_Subida),
		origen: String(f.Origen) as OrigenDeSubida,
		mainDeviceId: f.Main_Device_Id === null ? null : String(f.Main_Device_Id),
		inicioSeq: Number(f.Inicio_Seq),
		estado: String(f.Estado) as EstadoDeSubida,
		desdeMs: Number(f.Desde_Ms),
		hastaMs: Number(f.Hasta_Ms),
		filasDeclaradas: n(f.Filas_Declaradas),
		primeraPaginaMs: n(f.Primera_Pagina_Ms),
		empezadaMs: n(f.Empezada_Ms),
		terminadaMs: n(f.Terminada_Ms),
		filasEscritas: Number(f.Filas_Escritas ?? 0),
		bytesCrecidos: Number(f.Bytes_Crecidos ?? 0),
		paginas: Number(f.Paginas ?? 0),
		avisoSinEmpezarMs: n(f.Aviso_Sin_Empezar_Ms),
	};
}

function ponerEstado(sql: SqlStorage, estado: EstadoDeSubida): void {
	sql.exec("UPDATE _Subida_Completa SET Estado = ?1 WHERE Id = 1;", estado);
}

/**
 * La Main ya la ha empezado: ha dado algún paso (el plan, una página, una comparación) desde que se
 * pidió o se reabrió (`Empezada_Ms`). Desde entonces sigue por sus cursores cuando vuelve, aunque
 * pasen semanas con el equipo apagado o la subida pausada (`subida_nube`). No vale lo planeado
 * (`Filas_Declaradas`): reabrir lo conserva para el techo, y una reabierta cuya Main no vuelve tiene
 * que caducar a su plazo como cualquier otra.
 */
function empezada(p: PeticionDeSubida): boolean {
	return p.empezadaMs !== null;
}

/**
 * Si la petición lleva esperando más de su plazo sin que la Main la haya empezado, pasa a
 * `caducada`. Devuelve si ha caducado ahora. Una empezada no caduca: dejarla a medias por el plazo
 * dejaría la nube incompleta para siempre y soltaría las copias buenas a la poda.
 */
export function caducarSiToca(sql: SqlStorage, ahoraMs: number): boolean {
	const p = leerSubida(sql);
	if (!p || p.estado !== "esperando" || empezada(p) || ahoraMs <= p.hastaMs) return false;
	ponerEstado(sql, "caducada");
	return true;
}

/** Lo que lleva el `hello_ok` de la Main de la petición. */
export type SubidaEnElSaludo = { id: string; estado: "esperando" | "terminada"; origen: OrigenDeSubida };

/**
 * Lo que se le dice a un `tpv` que acaba de saludar como Main vigente (`atenderHelloSigned`, sin
 * esperas). Sin dueño, la petición se la queda él; con otro dueño, se queda `huerfana` (un traslado
 * de licencia a mitad: la base del equipo nuevo no es la que había que subir).
 */
export function subidaParaElSaludo(
	sql: SqlStorage,
	deviceId: string,
	ahoraMs: number,
): { subida: SubidaEnElSaludo | null; caducada: boolean; huerfana: PeticionDeSubida | null } {
	const caducada = caducarSiToca(sql, ahoraMs);
	const p = leerSubida(sql);
	if (!p) return { subida: null, caducada, huerfana: null };
	if (p.estado === "esperando") {
		if (p.mainDeviceId === null) {
			sql.exec("UPDATE _Subida_Completa SET Main_Device_Id = ?1 WHERE Id = 1;", deviceId);
			p.mainDeviceId = deviceId;
		} else if (p.mainDeviceId !== deviceId) {
			ponerEstado(sql, "huerfana");
			return { subida: null, caducada, huerfana: p };
		}
	}
	if ((p.estado === "esperando" || p.estado === "terminada") && p.mainDeviceId === deviceId) {
		return { subida: { id: p.id, estado: p.estado, origen: p.origen }, caducada, huerfana: null };
	}
	return { subida: null, caducada, huerfana: null };
}

/** Lo que enseña `negocio:estado`. Sin datos del negocio. */
export function estadoParaSoporte(sql: SqlStorage): Record<string, unknown> | null {
	const p = leerSubida(sql);
	if (!p) return null;
	return {
		estado: p.estado,
		origen: p.origen,
		mainDeviceId: p.mainDeviceId,
		desde: new Date(p.desdeMs).toISOString(),
		hasta: new Date(p.hastaMs).toISOString(),
		filasDeclaradas: p.filasDeclaradas,
		filasEscritas: p.filasEscritas,
		bytesCrecidos: p.bytesCrecidos,
		paginas: p.paginas,
		primeraPagina: p.primeraPaginaMs ? new Date(p.primeraPaginaMs).toISOString() : null,
		terminada: p.terminadaMs ? new Date(p.terminadaMs).toISOString() : null,
	};
}

/**
 * Vuelve a abrir una petición `agotada`, `caducada` o `huerfana` desde la administración: otra vez
 * esperando, con su plazo y su presupuesto a cero y sin dueño (la primera Main vigente que salude se
 * la queda). El aviso de «sin empezar» vuelve a contar desde aquí: si nadie la retoma en un día, la
 * alarma avisa otra vez. Devuelve el estado de antes, o `null` si no había nada que reabrir.
 *
 * Lo que dice lo planeado (`Filas_Declaradas`) se queda: la misma Main sigue por sus cursores, sin
 * volver a pedir el plan, y su techo total sale de ahí. Lo que la daba por empezada, no: sólo un
 * paso de su Main después de reabrirla la libra de caducar.
 */
export function reabrirSubida(sql: SqlStorage, ahoraMs: number): EstadoDeSubida | null {
	const p = leerSubida(sql);
	if (!p || p.estado === "esperando" || p.estado === "terminada") return null;
	sql.exec(
		`UPDATE _Subida_Completa SET Estado = 'esperando', Main_Device_Id = NULL, Hasta_Ms = ?1,
		   Filas_Escritas = 0, Bytes_Crecidos = 0, Hora_Ms = NULL, Filas_Hora = NULL, Bytes_Hora = NULL,
		   Primera_Pagina_Ms = NULL, Empezada_Ms = NULL, Aviso_Sin_Empezar_Ms = NULL
		 WHERE Id = 1;`,
		ahoraMs + PLAZO_DE_SUBIDA_MS,
	);
	return p.estado;
}

/**
 * La alarma diaria: si la petición lleva un día esperando sin ninguna página desde que se pidió (o se
 * reabrió: `Hasta_Ms` menos el plazo), se avisa una vez. Devuelve la petición si toca avisar ahora.
 */
export function sinEmpezarParaAvisar(sql: SqlStorage, ahoraMs: number): PeticionDeSubida | null {
	caducarSiToca(sql, ahoraMs);
	const p = leerSubida(sql);
	if (!p || p.estado !== "esperando" || p.primeraPaginaMs !== null || p.avisoSinEmpezarMs !== null) return null;
	if (ahoraMs - (p.hastaMs - PLAZO_DE_SUBIDA_MS) < AVISO_SIN_EMPEZAR_MS) return null;
	sql.exec("UPDATE _Subida_Completa SET Aviso_Sin_Empezar_Ms = ?1 WHERE Id = 1;", ahoraMs);
	return p;
}

/**
 * Desde cuándo no se podan las copias de R2: mientras la subida no ha terminado, las copias de antes
 * de la pérdida son las buenas, y las que se hacen después son de una base a medias.
 */
export function copiasProtegidasDesde(sql: SqlStorage): number | null {
	const p = leerSubida(sql);
	if (!p || (p.estado !== "esperando" && p.estado !== "agotada" && p.estado !== "huerfana")) return null;
	return p.desdeMs;
}

/* ===== Los pasos ===== */

type Clave = (string | number)[];

export type PasoDeSubida =
	| { accion: "plan"; id: string; clientNow: unknown; checkpoint: number; totales: Record<string, number> }
	| { accion: "tramos"; id: string; tabla: string; columnas: string[]; tramos: { desde: Clave | null; hasta: Clave; n: number; suma: string }[] }
	| { accion: "huellas"; id: string; tabla: string; columnas: string[]; huellas: { clave: Clave; huella: string }[] }
	| { accion: "filas"; id: string; tabla: string; columnas: string[]; filas: unknown[][]; checkpoint: number; ultimaDeLaTabla: boolean }
	| { accion: "sobrantes"; id: string; tabla: string; desde: Clave | null; hasta: Clave | null; claves: Clave[]; checkpoint: number }
	| { accion: "fin"; id: string; conteos: Record<string, number>; porRevisar: number };

const malFormada = () => new HubError("subida_mal_formada", 400);

function texto(v: unknown, max = 200): string {
	if (typeof v !== "string" || !v || v.length > max) throw malFormada();
	return v;
}

function entero(v: unknown): number {
	if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) throw malFormada();
	return v;
}

function nombre(v: unknown): string {
	const t = texto(v, 64);
	if (!NOMBRE.test(t)) throw malFormada();
	return t;
}

function columnasDe(v: unknown): string[] {
	if (!Array.isArray(v) || v.length === 0 || v.length > 200) throw malFormada();
	const cols = v.map(nombre);
	if (new Set(cols).size !== cols.length) throw malFormada();
	return cols;
}

/** Un valor de una fila: lo que la Main sabe mandar. Ni booleanos, ni objetos, ni números no finitos. */
function valorDeFila(v: unknown): unknown {
	if (v === null || typeof v === "string") return v;
	if (typeof v === "number" && Number.isFinite(v)) return v;
	throw malFormada();
}

function clave(v: unknown): Clave {
	if (!Array.isArray(v) || v.length === 0 || v.length > 8) throw malFormada();
	return v.map((x) => {
		if (typeof x === "string" && x.length <= 500) return x;
		if (typeof x === "number" && Number.isFinite(x)) return x;
		throw malFormada();
	});
}

function totales(v: unknown): Record<string, number> {
	if (!v || typeof v !== "object" || Array.isArray(v)) throw malFormada();
	const out: Record<string, number> = {};
	const entradas = Object.entries(v as Record<string, unknown>);
	if (entradas.length > 500) throw malFormada();
	for (const [k, n] of entradas) out[nombre(k)] = entero(n);
	return out;
}

/**
 * La forma de un paso, antes que nada: un paso mal hecho no cuesta una lectura de la base central
 * ni toca la base. Lanza `subida_mal_formada` (permanente) o `subida_pagina_demasiado_grande` (la
 * Main parte la página).
 */
export function formaDelPaso(msg: Record<string, unknown>): PasoDeSubida {
	const id = texto(msg.id);
	switch (msg.accion) {
		case "plan":
			return { accion: "plan", id, clientNow: msg.clientNow, checkpoint: entero(msg.checkpoint), totales: totales(msg.totales) };
		case "tramos": {
			if (!Array.isArray(msg.tramos) || msg.tramos.length === 0) throw malFormada();
			if (msg.tramos.length > TRAMOS_POR_PASO) throw new HubError("subida_pagina_demasiado_grande", 413);
			const tramos = msg.tramos.map((t: any) => {
				if (!t || typeof t !== "object") throw malFormada();
				const suma = texto(t.suma, 16);
				if (!/^[0-9a-f]{16}$/.test(suma)) throw malFormada();
				return { desde: t.desde === null ? null : clave(t.desde), hasta: clave(t.hasta), n: entero(t.n), suma };
			});
			return { accion: "tramos", id, tabla: nombre(msg.tabla), columnas: columnasDe(msg.columnas), tramos };
		}
		case "huellas": {
			if (!Array.isArray(msg.huellas) || msg.huellas.length === 0) throw malFormada();
			if (msg.huellas.length > HUELLAS_POR_PASO) throw new HubError("subida_pagina_demasiado_grande", 413);
			const huellas = msg.huellas.map((h: unknown) => {
				if (!Array.isArray(h) || h.length !== 2) throw malFormada();
				const huella = texto(h[1], 16);
				if (!/^[0-9a-f]{16}$/.test(huella)) throw malFormada();
				return { clave: clave(h[0]), huella };
			});
			return { accion: "huellas", id, tabla: nombre(msg.tabla), columnas: columnasDe(msg.columnas), huellas };
		}
		case "filas": {
			const columnas = columnasDe(msg.columnas);
			// Una lista vacía sólo para decir que la tabla ha acabado (y que se avise a las Handy).
			if (!Array.isArray(msg.filas) || (msg.filas.length === 0 && msg.ultimaDeLaTabla !== true)) throw malFormada();
			if (msg.filas.length > FILAS_POR_PAGINA) throw new HubError("subida_pagina_demasiado_grande", 413);
			const filas = msg.filas.map((f: unknown) => {
				if (!Array.isArray(f) || f.length !== columnas.length) throw malFormada();
				return f.map(valorDeFila);
			});
			return {
				accion: "filas",
				id,
				tabla: nombre(msg.tabla),
				columnas,
				filas,
				checkpoint: entero(msg.checkpoint),
				ultimaDeLaTabla: msg.ultimaDeLaTabla === true,
			};
		}
		case "sobrantes": {
			if (!Array.isArray(msg.claves) || msg.claves.length > CLAVES_POR_SOBRANTES) throw malFormada();
			return {
				accion: "sobrantes",
				id,
				tabla: nombre(msg.tabla),
				desde: msg.desde === null || msg.desde === undefined ? null : clave(msg.desde),
				hasta: msg.hasta === null || msg.hasta === undefined ? null : clave(msg.hasta),
				claves: msg.claves.map(clave),
				checkpoint: entero(msg.checkpoint),
			};
		}
		case "fin":
			return { accion: "fin", id, conteos: totales(msg.conteos), porRevisar: entero(msg.porRevisar) };
		default:
			throw malFormada();
	}
}

/** Lo que el esquema del objeto dice de una tabla que se acepta subir. */
type TablaDeSubida = { tabla: string; columnas: string[]; clave: string[] };

/**
 * La tabla, si es una del negocio que existe aquí como tabla (ni una vista, ni lo que empieza por
 * `_`, ni el andamiaje de la réplica, ni los intentos de PIN). Lanza `subida_tabla_no_admitida`.
 */
function tablaAdmitida(sql: SqlStorage, tabla: string): TablaDeSubida {
	if (!esTablaDeNegocio(tabla) || tabla.startsWith("Sync_")) throw new HubError("subida_tabla_no_admitida", 400);
	const existe = sql.exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1;", tabla).toArray().length > 0;
	if (!existe) throw new HubError("subida_tabla_no_admitida", 400);
	const info = sql.exec("SELECT name, pk FROM pragma_table_info(?1) ORDER BY cid;", tabla).toArray() as { name: string; pk: number }[];
	const columnas = info.map((c) => String(c.name));
	const claveDe = info.filter((c) => Number(c.pk) > 0).sort((a, b) => Number(a.pk) - Number(b.pk)).map((c) => String(c.name));
	if (!claveDe.length) throw new HubError("subida_tabla_no_admitida", 400);
	return { tabla, columnas, clave: claveDe };
}

/**
 * Las columnas que manda la Main, casadas con las de aquí: todas existen, sin repetir, y entre ellas
 * la clave entera. Lanza `subida_columnas_desconocidas`. Devuelve dónde está cada columna de la clave.
 */
function casarColumnas(t: TablaDeSubida, columnas: string[]): number[] {
	const aqui = new Set(t.columnas);
	if (columnas.some((c) => !aqui.has(c))) throw new HubError("subida_columnas_desconocidas", 400);
	const posiciones = t.clave.map((k) => columnas.indexOf(k));
	if (posiciones.some((p) => p < 0)) throw new HubError("subida_columnas_desconocidas", 400);
	return posiciones;
}

/** Un nombre ya casado con el esquema, entre comillas dobles. */
const cita = (n: string) => `"${n.replaceAll('"', '""')}"`;

/** `(c1, c2) > (?n, ?n+1)` para recorrer por clave, con sus argumentos al final de `args`. */
function comparaClave(clave: string[], op: ">" | "<=", valores: Clave, args: unknown[]): string {
	const marcas = valores.map((v) => {
		args.push(v);
		return `?${args.length}`;
	});
	return `(${clave.map(cita).join(", ")}) ${op} (${marcas.join(", ")})`;
}

/** La huella de una fila: el FNV-1a de su forma canónica, en las columnas pedidas y en su orden. */
function huellaDe(c: Canonico, fila: unknown[]): { alto: number; bajo: number } {
	c.vaciar();
	for (const v of fila) c.valor(v);
	c.hash();
	return { alto: c.alto, bajo: c.bajo };
}

/** La clave de una fila como texto, para casarla: el JSON de sus valores. */
const textoDeClave = (valores: unknown[]) => JSON.stringify(valores);

export type NoEntro = { clave: Clave; motivo: "unico" | "foranea" | "check" | "fiscal" | "otro" };

/** De qué clase es lo que no deja entrar una fila. Sin datos de la fila. */
function claseDeFallo(e: unknown): NoEntro["motivo"] {
	const t = String((e as Error)?.message ?? e).toLowerCase();
	if (t.includes("unique constraint failed")) return "unico";
	if (t.includes("foreign key constraint failed")) return "foranea";
	if (t.includes("check constraint failed") || t.includes("not null constraint failed") || t.includes("ri48:") || t.includes("asig_")) {
		return "check";
	}
	return "otro";
}

/** La sentencia de una página: un upsert con la lista en un solo parámetro (DO-01). */
export function sentenciaDeSubida(tabla: string, columnas: string[], claveDe: string[], politica: PoliticaDeSubida): string {
	const lista = columnas.map(cita).join(", ");
	const valores = columnas.map((_, i) => `json_extract(value, '$[${i}]')`).join(", ");
	const resto = columnas.filter((c) => !claveDe.includes(c));
	const conflicto = `ON CONFLICT(${claveDe.map(cita).join(", ")})`;
	// Un contador sólo sube: `MAX` de lo de arriba y lo que llega, y sólo si lo que llega es mayor.
	const monotonas = politica === "monotono" ? resto.filter((c) => MONOTONAS[tabla]?.includes(c)) : [];
	const alChocar =
		politica === "monotono" && monotonas.length
			? `${conflicto} DO UPDATE SET ${monotonas.map((c) => `${cita(c)} = MAX(${cita(c)}, excluded.${cita(c)})`).join(", ")}
			   WHERE ${monotonas.map((c) => `excluded.${cita(c)} > ${cita(c)}`).join(" OR ")}`
			: politica !== "upsert" || resto.length === 0
				? `${conflicto} DO NOTHING`
				: `${conflicto} DO UPDATE SET ${resto.map((c) => `${cita(c)} = excluded.${cita(c)}`).join(", ")}
			   WHERE NOT (${resto.map((c) => `${cita(c)} IS excluded.${cita(c)}`).join(" AND ")})`;
	// El `WHERE 1` no sobra: sin él, SQLite lee el `ON` del `ON CONFLICT` como el de un `JOIN`.
	return `INSERT INTO ${cita(tabla)} (${lista}) SELECT ${valores} FROM json_each(?1) WHERE 1 ${alChocar}`;
}

/** Lo que cuesta una página: las filas escritas (con índices y triggers) y lo que crece la base. */
type Medida = { filas: number };

/**
 * Aplica unas filas con su sentencia. Si algo no entra (un único, una foránea, un `CHECK` o un
 * trigger que rechaza), parte las filas por la mitad, cada mitad con su propia lista, hasta aislar
 * las que no entran, que vuelven con su clase. Lo pasajero (la base ocupada, llena) sale tal cual.
 */
function aplicarConParticion(
	storage: Almacen,
	sentencia: string,
	filas: unknown[][],
	posiciones: number[],
	medida: Medida,
	presupuestoDeIntentos: { quedan: number },
): { escritas: number; noEntraron: NoEntro[] } {
	const sql = storage.sql;
	const claveDeFila = (f: unknown[]) => posiciones.map((p) => f[p]) as Clave;
	const intentar = (trozo: unknown[][]): { escritas: number; noEntraron: NoEntro[] } => {
		presupuestoDeIntentos.quedan--;
		try {
			const escritas = storage.transactionSync(() => {
				const cursor = sql.exec(sentencia, JSON.stringify(trozo));
				cursor.toArray();
				medida.filas += cursor.rowsWritten;
				return Number((sql.exec("SELECT changes() AS c;").one() as { c: number }).c);
			});
			return { escritas, noEntraron: [] };
		} catch (e) {
			// Lo que se deshizo también lo escribió el SQLite del DO.
			medida.filas += trozo.length;
			if (esFalloPasajero(e)) throw e;
			if (trozo.length === 1 || presupuestoDeIntentos.quedan <= 0) {
				const motivo = trozo.length === 1 ? claseDeFallo(e) : "otro";
				return { escritas: 0, noEntraron: trozo.map((f) => ({ clave: claveDeFila(f), motivo })) };
			}
			const mitad = Math.ceil(trozo.length / 2);
			const a = intentar(trozo.slice(0, mitad));
			const b = intentar(trozo.slice(mitad));
			return { escritas: a.escritas + b.escritas, noEntraron: [...a.noEntraron, ...b.noEntraron] };
		}
	};
	return intentar(filas);
}

/** Las filas de aquí de unas claves, por su clave en texto. Una consulta, con la lista en un parámetro. */
function filasPorClave(sql: SqlStorage, t: TablaDeSubida, columnas: string[], claves: Clave[]): Map<string, unknown[]> {
	const out = new Map<string, unknown[]>();
	if (!claves.length) return out;
	const extraer = t.clave.map((_, i) => `json_extract(value, '$[${i}]')`).join(", ");
	const lista = columnas.map(cita).join(", ");
	const enLista = `(${t.clave.map(cita).join(", ")}) IN (SELECT ${extraer} FROM json_each(?1))`;
	const posiciones = t.clave.map((k) => columnas.indexOf(k));
	for (const f of sql.exec(`SELECT ${lista} FROM ${cita(t.tabla)} WHERE ${enLista};`, JSON.stringify(claves)).raw()) {
		const fila = f as unknown[];
		out.set(textoDeClave(posiciones.map((p) => fila[p])), fila);
	}
	return out;
}

/** ¿Hay en el log algo de otro dispositivo por encima de `checkpoint`? Devuelve hasta dónde, o `null`. */
function ajenoPorEncima(sql: SqlStorage, checkpoint: number, deviceId: string): number | null {
	const f = sql
		.exec("SELECT MAX(Seq) AS s FROM Sync_Changes WHERE Seq > ?1 AND Device_Id IS NOT ?2;", checkpoint, deviceId)
		.one() as { s: number | null };
	return f.s === null ? null : Number(f.s);
}

const horaDe = (ms: number) => Math.floor(ms / HORA_MS) * HORA_MS;

/** El techo total de la petición. */
function techoTotal(p: PeticionDeSubida, l: LimitesDeSubida): number {
	const declaradas = p.filasDeclaradas ?? 0;
	return Math.min(l.filasTotales, Math.max(l.sueloTotal, l.factorDeclaradas * declaradas));
}

/** ¿Puede entrar otra página? Lanza el error de su presupuesto. */
function exigirPresupuesto(sql: SqlStorage, p: PeticionDeSubida, ahoraMs: number, l: LimitesDeSubida): void {
	if (p.filasEscritas >= techoTotal(p, l) || p.bytesCrecidos >= l.bytesTotales) {
		ponerEstado(sql, "agotada");
		throw new HubError("subida_presupuesto_superado", 429);
	}
	const f = sql.exec("SELECT Hora_Ms, Filas_Hora, Bytes_Hora FROM _Subida_Completa WHERE Id = 1;").one() as {
		Hora_Ms: number | null;
		Filas_Hora: number | null;
		Bytes_Hora: number | null;
	};
	if (Number(f.Hora_Ms) === horaDe(ahoraMs) && (Number(f.Filas_Hora ?? 0) >= l.filasPorHora || Number(f.Bytes_Hora ?? 0) >= l.bytesPorHora)) {
		throw new HubError("presupuesto_de_subida_agotado", 429);
	}
}

function apuntarGastoDeSubida(sql: SqlStorage, ahoraMs: number, filas: number, bytes: number): void {
	const hora = horaDe(ahoraMs);
	const f = Math.max(0, Math.floor(filas));
	const b = Math.max(0, Math.floor(bytes));
	sql.exec(
		`UPDATE _Subida_Completa SET
		   Filas_Escritas = Filas_Escritas + ?2,
		   Bytes_Crecidos = Bytes_Crecidos + ?3,
		   Paginas = Paginas + 1,
		   Primera_Pagina_Ms = COALESCE(Primera_Pagina_Ms, ?4),
		   Filas_Hora = CASE WHEN Hora_Ms = ?1 THEN COALESCE(Filas_Hora, 0) + ?2 ELSE ?2 END,
		   Bytes_Hora = CASE WHEN Hora_Ms = ?1 THEN COALESCE(Bytes_Hora, 0) + ?3 ELSE ?3 END,
		   Hora_Ms = ?1
		 WHERE Id = 1;`,
		hora,
		f,
		b,
		ahoraMs,
	);
}

/** Lo que contesta un paso. Lo que sale mal lanza un `HubError` (o el fallo de la base). */
export type RespuestaDePaso = { ok: true; [campo: string]: unknown } | { ok: false; aplazada: true; hastaSeq: number };

/** Lo que el motor tiene que hacer después de un paso: avisar a las Handy, contar. */
export type EfectosDelPaso = { tablaSubida?: string; terminada?: boolean; empezada?: boolean; aplazada?: boolean; rechazadas?: number };

/** Las tablas del negocio de este objeto, en el orden del esquema. */
function tablasDelNegocio(sql: SqlStorage): string[] {
	return (sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY rowid;").toArray() as { name: string }[])
		.map((f) => String(f.name))
		.filter((t) => esTablaDeNegocio(t) && !t.startsWith("Sync_"));
}

/**
 * Las claves de lo que sigue vivo aquí (lo que una recuperación se lleva sin ventana: comandas
 * abiertas con todo lo suyo, el último cierre sin reabrir, las notificaciones activas, los pedidos en
 * borrador, los fichajes abiertos): la Main sube su versión de cada una y pide borrar, por el outbox,
 * las que ya no tiene. Lo fiscal, no: no se borra nunca.
 */
function clavesVivas(sql: SqlStorage, ahora: string): { vivos: Record<string, Clave[]>; incompletos: boolean } {
	const vivos: Record<string, Clave[]> = {};
	let total = 0;
	let incompletos = false;
	for (const tabla of tablasDelNegocio(sql)) {
		if (!esTransaccional(tabla) || politicaDe(tabla) !== "upsert") continue;
		const t = tablaAdmitida(sql, tabla);
		const { sql: texto, args } = sentenciaVolcado(tabla, ahora);
		const cursor = sql.exec(texto, ...args);
		const posiciones = t.clave.map((k) => cursor.columnNames.indexOf(k));
		const claves: Clave[] = [];
		for (const f of cursor.raw()) {
			if (total >= CLAVES_VIVAS_MAX) {
				incompletos = true;
				break;
			}
			claves.push(posiciones.map((p) => (f as unknown[])[p]) as Clave);
			total++;
		}
		if (claves.length) vivos[tabla] = claves;
	}
	return { vivos, incompletos };
}

/**
 * Un paso de la subida, entero y sin esperas: el motor lo llama dentro del turno del log, después de
 * mirar que la sesión es la de la Main. `deviceId` es el de esa sesión.
 */
export function ejecutarPasoDeSubida(
	storage: Almacen,
	params: { deviceId: string; paso: PasoDeSubida; ahoraMs: number; limites?: LimitesDeSubida },
): { respuesta: RespuestaDePaso; efectos: EfectosDelPaso } {
	const sql = storage.sql;
	const { deviceId, paso, ahoraMs } = params;
	const limites = params.limites ?? LIMITES_DE_SUBIDA;
	caducarSiToca(sql, ahoraMs);
	const p = leerSubida(sql);

	// `fin` repetido sobre una subida ya terminada contesta lo mismo y no cambia nada.
	if (paso.accion === "fin" && p && p.estado === "terminada" && p.id === paso.id && p.mainDeviceId === deviceId) {
		return { respuesta: { ok: true, conteos: conteosDeAqui(sql), yaTerminada: true }, efectos: {} };
	}
	if (!p || p.estado !== "esperando" || p.id !== paso.id || p.mainDeviceId !== deviceId) {
		throw new HubError("subida_no_pedida", 409);
	}
	// Desde el primer paso de su Main (aunque se aplace o no entre), la petición ya no caduca.
	if (p.empezadaMs === null) sql.exec("UPDATE _Subida_Completa SET Empezada_Ms = ?1 WHERE Id = 1;", ahoraMs);

	switch (paso.accion) {
		case "plan": {
			const hasta = ajenoPorEncima(sql, paso.checkpoint, deviceId);
			if (hasta !== null) return { respuesta: { ok: false, aplazada: true, hastaSeq: hasta }, efectos: { aplazada: true } };
			const declaradas = Object.values(paso.totales).reduce((a, n) => a + n, 0);
			sql.exec("UPDATE _Subida_Completa SET Filas_Declaradas = ?1 WHERE Id = 1;", declaradas);
			const tablas = tablasDelNegocio(sql).map((tabla) => {
				const t = tablaAdmitida(sql, tabla);
				const v = sentenciaVolcado(tabla, "?");
				return {
					tabla,
					columnas: t.columnas,
					clave: t.clave,
					// La de la recuperación (`bootstrap.ventana.ts`), sin el `;`: la Main la ejecuta con su
					// propio límite de ventana en `?1`.
					sql: v.sql.replace(/;\s*$/, ""),
					parametrizada: v.args.length > 0,
					parcial: esTransaccional(tabla),
					politica: politicaDe(tabla),
				};
			});
			const ahora = parseClientNow(paso.clientNow) ?? serverNowFixed();
			const { vivos, incompletos } = clavesVivas(sql, ahora);
			const hastaSeq = Number((sql.exec("SELECT COALESCE(MAX(Seq), 0) AS s FROM Sync_Changes;").one() as { s: number }).s);
			return {
				// `dispositivo`: cómo nombra el log a esta Main. Sus borrados (lo vivo, los sobrantes) no
				// los frena lo que ella misma escribe, sólo lo de otro. `inicioSeq`: el cambio vacío que
				// abrió el log al volver (`abrirLogTrasVolver`). Lo de una cuarentena de la Main numerado
				// por debajo se perdió con una base vacía; lo de encima se escribió en la nube devuelta.
				respuesta: {
					ok: true,
					ventanaDias: VENTANA_DIAS,
					tablas,
					vivos,
					vivosIncompletos: incompletos,
					hastaSeq,
					dispositivo: deviceId,
					inicioSeq: p.inicioSeq,
				},
				efectos: { empezada: true },
			};
		}

		case "huellas": {
			const t = tablaAdmitida(sql, paso.tabla);
			casarColumnas(t, paso.columnas);
			if (paso.huellas.some((h) => h.clave.length !== t.clave.length)) throw malFormada();
			const aqui = filasPorClave(sql, t, paso.columnas, paso.huellas.map((h) => h.clave));
			const c = new Canonico();
			const distintas: Clave[] = [];
			const faltan: Clave[] = [];
			for (const h of paso.huellas) {
				const fila = aqui.get(textoDeClave(h.clave));
				if (!fila) {
					distintas.push(h.clave);
					faltan.push(h.clave);
					continue;
				}
				const { alto, bajo } = huellaDe(c, fila);
				if (hex64(alto, bajo) !== h.huella) distintas.push(h.clave);
			}
			return { respuesta: { ok: true, distintas, faltan }, efectos: {} };
		}

		case "tramos": {
			const t = tablaAdmitida(sql, paso.tabla);
			casarColumnas(t, paso.columnas);
			const lista = paso.columnas.map(cita).join(", ");
			const orden = t.clave.map(cita).join(", ");
			const distintos: number[] = [];
			paso.tramos.forEach((tr, i) => {
				if ((tr.desde && tr.desde.length !== t.clave.length) || tr.hasta.length !== t.clave.length) throw malFormada();
				const args: unknown[] = [];
				const donde = [tr.desde ? comparaClave(t.clave, ">", tr.desde, args) : null, comparaClave(t.clave, "<=", tr.hasta, args)]
					.filter(Boolean)
					.join(" AND ");
				const suma = new SumaDeTramo();
				for (const f of sql.exec(`SELECT ${lista} FROM ${cita(t.tabla)} WHERE ${donde} ORDER BY ${orden};`, ...args).raw()) {
					suma.fila(f as unknown[]);
				}
				if (suma.n !== tr.n || suma.suma !== tr.suma) distintos.push(i);
			});
			return { respuesta: { ok: true, distintos }, efectos: {} };
		}

		case "filas": {
			const t = tablaAdmitida(sql, paso.tabla);
			const posiciones = casarColumnas(t, paso.columnas);
			if (bytesDe(paso.filas) > BYTES_POR_PAGINA) throw new HubError("subida_pagina_demasiado_grande", 413);
			// Lo ajeno manda: lo que una Handy ha escrito por encima de lo que la Main tenía al leer la
			// página no se pisa con lo de la Main. Lo baja antes y la vuelve a leer.
			const hasta = ajenoPorEncima(sql, paso.checkpoint, deviceId);
			if (hasta !== null) return { respuesta: { ok: false, aplazada: true, hastaSeq: hasta }, efectos: { aplazada: true } };
			exigirPresupuesto(sql, p, ahoraMs, limites);

			const politica = politicaDe(t.tabla);
			const soloInsertar = politica === "solo_insertar";
			const noEntraron: NoEntro[] = [];
			let filas = paso.filas;
			let iguales = 0;
			if (soloInsertar) {
				// Lo fiscal no se modifica: lo que ya está y es distinto no entra, y se dice.
				const aqui = filasPorClave(sql, t, paso.columnas, filas.map((f) => posiciones.map((i) => f[i]) as Clave));
				const c = new Canonico();
				filas = filas.filter((f) => {
					const ya = aqui.get(textoDeClave(posiciones.map((i) => f[i])));
					if (!ya) return true;
					const a = huellaDe(c, ya);
					const b = huellaDe(c, f);
					if (a.alto === b.alto && a.bajo === b.bajo) iguales++;
					else noEntraron.push({ clave: posiciones.map((i) => f[i]) as Clave, motivo: "fiscal" });
					return false;
				});
			}

			const medida: Medida = { filas: 0 };
			const tamanoAntes = sql.databaseSize;
			let escritas = 0;
			try {
				if (filas.length) {
					const r = aplicarConParticion(
						storage,
						sentenciaDeSubida(t.tabla, paso.columnas, t.clave, politica),
						filas,
						posiciones,
						medida,
						{ quedan: filas.length * 4 + 8 },
					);
					escritas = r.escritas;
					noEntraron.push(...r.noEntraron);
				}
			} finally {
				apuntarGastoDeSubida(sql, ahoraMs, medida.filas, Math.max(0, sql.databaseSize - tamanoAntes));
			}
			iguales += filas.length - escritas - noEntraron.filter((x) => x.motivo !== "fiscal").length;
			return {
				respuesta: { ok: true, escritas, iguales: Math.max(0, iguales), noEntraron },
				efectos: { tablaSubida: paso.ultimaDeLaTabla ? t.tabla : undefined, rechazadas: noEntraron.length },
			};
		}

		case "sobrantes": {
			const t = tablaAdmitida(sql, paso.tabla);
			if (paso.claves.some((k) => k.length !== t.clave.length)) throw malFormada();
			// Lo que la Main pida borrar con esto tiene que ser lo de la nube que ella ya ha visto.
			const ajeno = ajenoPorEncima(sql, paso.checkpoint, deviceId);
			if (ajeno !== null) return { respuesta: { ok: false, aplazada: true, hastaSeq: ajeno }, efectos: { aplazada: true } };
			const args: unknown[] = [];
			const donde = [
				paso.desde ? comparaClave(t.clave, ">", paso.desde, args) : null,
				paso.hasta ? comparaClave(t.clave, "<=", paso.hasta, args) : null,
			].filter(Boolean);
			const suyas = new Set(paso.claves.map(textoDeClave));
			const orden = t.clave.map(cita).join(", ");
			const sobran: Clave[] = [];
			let incompleto = false;
			const texto = `SELECT ${orden} FROM ${cita(t.tabla)}${donde.length ? ` WHERE ${donde.join(" AND ")}` : ""} ORDER BY ${orden};`;
			for (const f of sql.exec(texto, ...args).raw()) {
				const k = f as unknown[];
				if (suyas.has(textoDeClave(k))) continue;
				if (sobran.length >= CLAVES_POR_SOBRANTES) {
					incompleto = true;
					break;
				}
				sobran.push(k as Clave);
			}
			const hastaSeq = Number((sql.exec("SELECT COALESCE(MAX(Seq), 0) AS s FROM Sync_Changes;").one() as { s: number }).s);
			return { respuesta: { ok: true, sobran, incompleto, hastaSeq }, efectos: {} };
		}

		case "fin": {
			sql.exec("UPDATE _Subida_Completa SET Estado = 'terminada', Terminada_Ms = ?1 WHERE Id = 1;", ahoraMs);
			const conteos = conteosDeAqui(sql);
			const diferencias = Object.entries(paso.conteos).filter(([k, n]) => conteos[k] !== undefined && conteos[k] !== n).length;
			return { respuesta: { ok: true, conteos, diferencias }, efectos: { terminada: true } };
		}
	}
}

/** Lo que ocupa en UTF-8 la lista de filas tal como va en el parámetro. */
function bytesDe(filas: unknown[][]): number {
	return new TextEncoder().encode(JSON.stringify(filas)).byteLength;
}

/** `COUNT(*)` de cada tabla del negocio. */
function conteosDeAqui(sql: SqlStorage): Record<string, number> {
	const out: Record<string, number> = {};
	for (const t of tablasDelNegocio(sql)) {
		out[t] = Number((sql.exec(`SELECT COUNT(*) AS n FROM ${cita(t)};`).one() as { n: number }).n);
	}
	return out;
}
