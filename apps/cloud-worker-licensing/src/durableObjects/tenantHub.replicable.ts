// src/durableObjects/tenantHub.replicable.ts
//
// AUD-36 · Lo que la Main puede mandar por el socket (`apply_lote`), y nada más.
//
// La Main sube su outbox como SQL crudo: cada operación es una transacción con un paso `execute` por
// sentencia que capturó `WriteGuard` (`replicacion.rs::operacion`). `WriteGuard` sólo captura una
// escritura (`is_write_sql`: lo que empieza por `INSERT`, `UPDATE`, `DELETE` o `REPLACE`), de una
// sentencia, sobre una tabla del negocio, y el SQL del negocio no usa CTE recursivas, `zeroblob` ni
// `randomblob`. El DO ejecutaba cualquier cosa: un `CREATE TABLE`, un `INSERT … SELECT` que genera
// millones de filas con una CTE recursiva, `zeroblob` para llenar la base, dos sentencias en un
// mismo texto (el `exec` del SQLite del DO las corre todas) o una escritura en sus propias tablas
// (`Applied_Operations`, `Sync_Changes`, las que empiezan por `_`, como `_Main_Vigente`).
//
// Lo que no tiene esa forma no lo ha escrito la Main: se rechaza como permanente
// (`sentencia_no_admitida`, `tenantHub.errores.ts`), y la Main lo aparta. La Main vigila lo mismo al
// capturar (`db.rs::no_la_admite_la_nube`), y los dos lados leen los mismos casos
// (`crates/tpv-infra-sqlite/src/replicable_casos.json`): una sentencia que la nube rechazaría revienta
// en los tests de la Main, que es donde se arregla, y no acaba en cuarentena en el equipo de nadie.

import { HubError } from "../lib/errorHttp";
import type { InternalApplyCommand } from "./tenantHub.types";

/** Por qué no es una sentencia que suba la Main. Los mismos códigos en la Main. */
export type MotivoNoReplicable = "no_es_escritura" | "varias_sentencias" | "construccion_no_admitida" | "tabla_no_replicable";

/** Funciones y palabras que el SQL replicable no usa y que fabrican volumen de la nada. */
const PROHIBIDAS: ReadonlySet<string> = new Set(["RECURSIVE", "ZEROBLOB", "RANDOMBLOB"]);

/** Las tablas del propio DO que no tienen `_` delante. */
const TABLAS_DEL_DO: ReadonlySet<string> = new Set(["APPLIED_OPERATIONS", "SYNC_CHANGES"]);

type Pieza = { tipo: "palabra" | "nombre" | "simbolo"; texto: string };

/**
 * Las piezas de una sentencia: palabras (sin comillas), nombres entre comillas dobles, corchetes o
 * acentos graves (sin ellas), y símbolos sueltos. Los literales de texto y los comentarios no
 * cuentan: un nombre de cliente que diga «recursive» no es una CTE. `null` si queda algo detrás del
 * primer `;` que no sea espacio o comentario.
 */
function piezas(sql: string): Pieza[] | null {
	const salida: Pieza[] = [];
	let i = 0;
	let cerrada = false;
	const n = sql.length;
	while (i < n) {
		const c = sql[i];
		// El espacio de SQLite: el mismo que `is_ascii_whitespace` en la Main.
		if (/[ \t\n\f\r]/.test(c)) { i++; continue; }
		if (c === "-" && sql[i + 1] === "-") {
			const fin = sql.indexOf("\n", i);
			i = fin < 0 ? n : fin + 1;
			continue;
		}
		if (c === "/" && sql[i + 1] === "*") {
			const fin = sql.indexOf("*/", i + 2);
			i = fin < 0 ? n : fin + 2;
			continue;
		}
		if (cerrada) return null;
		if (c === ";") { cerrada = true; i++; continue; }
		if (c === "'" || c === '"' || c === "`" || c === "[") {
			const cierre = c === "[" ? "]" : c;
			let j = i + 1;
			let texto = "";
			for (;;) {
				if (j >= n) break;
				if (sql[j] === cierre) {
					// Una comilla doblada es una comilla dentro (no en los corchetes).
					if (cierre !== "]" && sql[j + 1] === cierre) { texto += cierre; j += 2; continue; }
					break;
				}
				texto += sql[j++];
			}
			if (c !== "'") salida.push({ tipo: "nombre", texto });
			i = j + 1;
			continue;
		}
		if (/[A-Za-z_]/.test(c)) {
			let j = i + 1;
			while (j < n && /[A-Za-z0-9_$]/.test(sql[j])) j++;
			salida.push({ tipo: "palabra", texto: sql.slice(i, j) });
			i = j;
			continue;
		}
		salida.push({ tipo: "simbolo", texto: c });
		i++;
	}
	return salida;
}

const esPalabra = (p: Pieza | undefined, ...cuales: string[]) =>
	p?.tipo === "palabra" && cuales.includes(p.texto.toUpperCase());

/** La tabla en la que escribe la sentencia: lo que va tras `INTO`, `UPDATE [OR …]` o `FROM`. */
function tablaEscrita(ps: Pieza[]): string | null {
	const verbo = ps[0].texto.toUpperCase();
	let i = 1;
	if ((verbo === "INSERT" || verbo === "UPDATE") && esPalabra(ps[i], "OR")) i += 2;
	if (verbo === "INSERT" || verbo === "REPLACE") {
		if (!esPalabra(ps[i], "INTO")) return null;
		i++;
	}
	if (verbo === "DELETE") {
		if (!esPalabra(ps[i], "FROM")) return null;
		i++;
	}
	const nombre = (p: Pieza | undefined) => (p && p.tipo !== "simbolo" ? p.texto : null);
	const primero = nombre(ps[i]);
	if (primero === null) return null;
	// `esquema.tabla`: sólo el esquema del negocio.
	if (ps[i + 1]?.tipo === "simbolo" && ps[i + 1].texto === ".") {
		if (primero.toLowerCase() !== "main") return null;
		return nombre(ps[i + 2]);
	}
	return primero;
}

/**
 * AUD-36 · Por qué la Main no puede haber mandado esta sentencia, o `null` si puede: una escritura
 * (`INSERT`, `UPDATE`, `DELETE`, `REPLACE`), una sola, sobre una tabla del negocio, sin CTE
 * recursivas, `zeroblob` ni `randomblob`.
 */
export function motivoNoReplicable(sql: string): MotivoNoReplicable | null {
	const ps = piezas(String(sql ?? ""));
	if (ps === null) return "varias_sentencias";
	if (!esPalabra(ps[0], "INSERT", "UPDATE", "DELETE", "REPLACE")) return "no_es_escritura";
	if (ps.some((p) => p.tipo === "palabra" && PROHIBIDAS.has(p.texto.toUpperCase()))) return "construccion_no_admitida";
	const tabla = tablaEscrita(ps);
	if (
		tabla === null ||
		tabla.startsWith("_") ||
		tabla.toLowerCase().startsWith("sqlite_") ||
		TABLAS_DEL_DO.has(tabla.toUpperCase())
	) {
		return "tabla_no_replicable";
	}
	return null;
}

/**
 * AUD-36 · Una operación del lote de la Main tiene la forma que genera la Main
 * (`replicacion.rs::operacion`): una transacción de pasos `execute`, cada uno una sentencia
 * replicable. Si no, `sentencia_no_admitida`, permanente: la Main la aparta y la repara por estado.
 */
export function exigirOperacionDeLaMain(cmd: InternalApplyCommand): void {
	if (cmd.type !== "tenantDb.transaction") throw new HubError("sentencia_no_admitida", 400);
	const pasos = Array.isArray(cmd.payload?.steps) ? cmd.payload.steps : [];
	for (const paso of pasos) {
		if (paso?.kind !== "execute") throw new HubError("sentencia_no_admitida", 400);
		const motivo = motivoNoReplicable(paso.sql);
		if (motivo) throw new HubError("sentencia_no_admitida", 400, motivo);
	}
}
