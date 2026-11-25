// src/durableObjects/baseCentral.guardas.ts
//
// Lo que la `BaseCentral` comprueba antes de tocar su base.
//
// - **Si tiene algo a medias.** Una restauración desde una copia que no ha terminado
//   (`baseCentral.restaurar.ts`) o una vuelta a un instante preparada y sin aplicar
//   (`baseCentral.instante.ts`) dejan su marca en el almacenamiento del objeto. Mientras esté, no
//   atiende, y es lo primero que se mira: las filas de una restauración a medias no las ve nadie, y lo
//   que se escribiera antes de volver a un instante se perdería al volver.
// - **Qué sentencias ejecuta.** Sólo lecturas y escrituras de filas, una por llamada. Su esquema sólo
//   lo cambian sus migraciones (`server/central/migraciones.ts`), y lo que cambia el comportamiento
//   de la conexión (un PRAGMA), abre o cierra transacciones por su cuenta, adjunta otra base o
//   borra y reinserta filas (`REPLACE` y `OR REPLACE`, que disparan las cascadas) no entra nunca.
// - **Cómo está la conexión.** Un PRAGMA lanzado a mano (desde Data Studio, por ejemplo) se queda
//   puesto para todo lo que venga detrás en el objeto: con las claves foráneas apagadas quedarían
//   hijas huérfanas, y con `ignore_check_constraints` entrarían filas que violan los CHECK. Al
//   empezar cada llamada se mira, se corrige y se avisa.

import { capturarError } from "../observability/errors";
import type { FalloDeLaCentral, MarcaDeRestauracion, MarcaDeVuelta, MarcasDeLaCentral } from "./baseCentral.rpc";
import { fkActivas, ponerFk, verboDe } from "./sqliteDelObjeto";

/** Dónde deja su marca una restauración desde una copia mientras no termina. */
export const CLAVE_RESTAURACION_EN_CURSO = "restauracion-en-curso";
/** Dónde deja su marca una vuelta a un instante preparada, hasta que el objeto se reinicia. */
export const CLAVE_VUELTA_EN_CURSO = "vuelta-en-curso";

/** Lo que el objeto tiene a medias, según las marcas de su almacenamiento. */
export function marcasDe(storage: DurableObjectStorage): MarcasDeLaCentral {
	return {
		restauracion: storage.kv.get<MarcaDeRestauracion>(CLAVE_RESTAURACION_EN_CURSO) ?? null,
		vuelta: storage.kv.get<MarcaDeVuelta>(CLAVE_VUELTA_EN_CURSO) ?? null,
	};
}

/** Por qué no atiende el objeto por lo que tiene a medias, o `null` si no tiene nada. */
export function falloPorLasMarcas(marcas: MarcasDeLaCentral): FalloDeLaCentral | null {
	const { restauracion, vuelta } = marcas;
	if (restauracion) {
		return {
			ok: false,
			error: "central_restauracion_a_medias",
			detalle: `La restauración desde ${restauracion.clave}, empezada el ${new Date(restauracion.desdeMs).toISOString()}, no terminó: vuelve a restaurar desde una copia.`,
		};
	}
	if (vuelta) {
		return {
			ok: false,
			error: "central_vuelta_en_curso",
			detalle: `La vuelta a ${vuelta.destino} está preparada desde el ${new Date(vuelta.desdeMs).toISOString()}: se aplica al reiniciar el objeto.`,
		};
	}
	return null;
}

/** Los verbos de lo único que ejecuta la central: leer y escribir filas. */
const VERBOS = new Set(["SELECT", "INSERT", "UPDATE", "DELETE", "WITH"]);

/**
 * El texto de la sentencia sin los literales ni los comentarios, y si lleva algo detrás de su `;`:
 * otra sentencia, u otro `;`, o un comentario (que el SQLite de un DO toma por una sentencia vacía y
 * rechaza). Los identificadores entre comillas (`"tabla"`, `` `tabla` ``, `[tabla]`) se quedan: son
 * nombres.
 */
function leer(texto: string): { codigo: string; varias: boolean } {
	let codigo = "";
	let cerrada = false;
	let varias = false;
	const n = texto.length;
	let i = 0;
	while (i < n) {
		const c = texto[i];
		const siguiente = texto[i + 1];
		if ((c === "-" && siguiente === "-") || (c === "/" && siguiente === "*")) {
			if (cerrada) varias = true;
			const linea = c === "-";
			const fin = texto.indexOf(linea ? "\n" : "*/", i + 2);
			i = fin === -1 ? n : fin + (linea ? 1 : 2);
			codigo += " ";
			continue;
		}
		if (c === "'" || c === '"' || c === "`" || c === "[") {
			const cierre = c === "[" ? "]" : c;
			let j = i + 1;
			// Dentro, la comilla se escribe doble ('', ""); los corchetes no tienen escape.
			while (j < n && !(texto[j] === cierre && !(cierre !== "]" && texto[j + 1] === cierre))) {
				j += texto[j] === cierre ? 2 : 1;
			}
			if (cerrada) varias = true;
			codigo += c === "'" ? " '' " : texto.slice(i, j + 1);
			i = j + 1;
			continue;
		}
		if (cerrada && (c === ";" || !/\s/.test(c))) varias = true;
		if (c === ";") cerrada = true;
		codigo += c;
		i++;
	}
	return { codigo, varias };
}

/**
 * Por qué la central no ejecuta esta sentencia, o `null` si la ejecuta. Lo que se devuelve es para
 * quien la escribió: sale en el `detalle` de `central_sentencia_prohibida`.
 *
 * El verbo es la primera palabra del texto, la misma que decide cómo se cuentan sus filas
 * (`sqliteDelObjeto.ts`): una sentencia que empieza por un comentario no tiene verbo y no entra.
 */
export function motivoDeRechazo(texto: string): string | null {
	const verbo = verboDe(texto);
	if (!VERBOS.has(verbo)) {
		return `La base central sólo ejecuta SELECT, INSERT, UPDATE, DELETE y WITH, y la sentencia empieza por «${verbo || texto.trimStart().slice(0, 20)}».`;
	}
	const { codigo, varias } = leer(texto);
	if (varias) return "La base central ejecuta una sola sentencia por llamada.";
	// La cláusula de conflicto va justo detrás de INSERT o UPDATE, y un REPLACE puede ir detrás de un
	// WITH. Un `OR replace(…)` de un WHERE es la función, y entra.
	if (/\b(INSERT|UPDATE)\s+OR\s+(REPLACE|ROLLBACK)\b/i.test(codigo) || /\bREPLACE\s+INTO\b/i.test(codigo)) {
		return "La base central no ejecuta REPLACE ni OR REPLACE (borran y reinsertan, y disparan las cascadas) ni OR ROLLBACK (deshace por su cuenta).";
	}
	if (/\b_migrations\b/i.test(codigo)) return "La tabla de migraciones de la base central sólo la toca su objeto.";
	return null;
}

function checksIgnorados(sql: SqlStorage): boolean {
	return Number((sql.exec("PRAGMA ignore_check_constraints;").toArray()[0] as any)?.ignore_check_constraints) !== 0;
}

/**
 * Que la conexión tenga las claves foráneas activas y los CHECK en vigor. Si no, se corrige y se
 * avisa a Sentry. Encenderlas puede tener que esperar a que lo escrito esté confirmado (`ponerFk`):
 * quien llama no lee nada de la base hasta después.
 */
export async function reafirmarPragmas(storage: DurableObjectStorage): Promise<void> {
	const sql = storage.sql;
	const corregidos: string[] = [];
	if (checksIgnorados(sql)) {
		sql.exec("PRAGMA ignore_check_constraints = OFF;");
		if (checksIgnorados(sql)) throw new Error("No se han podido volver a encender los CHECK de la base central");
		corregidos.push("ignore_check_constraints");
	}
	if (!fkActivas(sql)) {
		await ponerFk(storage, true);
		corregidos.push("foreign_keys");
	}
	if (corregidos.length > 0) {
		capturarError(
			new Error(`La base central tenía cambiado ${corregidos.join(" y ")}; se ha vuelto a poner como debe.`),
			"central.pragmas",
		);
	}
}
