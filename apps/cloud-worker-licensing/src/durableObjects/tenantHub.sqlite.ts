// src/durableObjects/tenantHub.sqlite.ts
//
// La base del negocio vive en el SQLite del propio TenantHub.
//
// El motor, las rutas y los tests hablan con la base a través de una `Base` (`lib/sql.ts`:
// `execute`, `batch`). Aquí se sirve sobre `ctx.storage.sql`, para que las doscientas consultas del
// worker no dependan de dónde vive la base: es `clienteLocal`, que usan las rutas (que se ejecutan
// dentro del DO, `lib/enElHub.ts`) y el motor. Desde fuera del DO no se lee por aquí: la agenda y la
// API pública de la reserva piden una lectura entera (`domains/reservas_web/lecturasDeLaWeb.ts`).
//
// Lo que es igual en cualquier SQLite de un DO (`changes()`, filas por posición, claves foráneas,
// migraciones) está en `sqliteDelObjeto.ts`. Lo propio de la base del negocio, aquí:
//
// - Los argumentos se convierten sin exigir nada: `undefined` es NULL y un booleano, 1 o 0.
// - Una clave foránea aplazada (`defer_foreign_keys`) que sigue rota al confirmar no lanza: el
//   runtime **resetea el Durable Object entero** a su último estado bueno (comprobado en
//   `test/sondaSqliteDo.test.ts`). Ver `loteEnBruto`.
// - Las guardas de los pasos `guard` de un lote (SYNC-30) y su tope de escritura (AUD-36).

import { MIGRATIONS } from "../server/tenantMigrations";
import { HubError } from "../lib/errorHttp";
import type { Base, Sentencia } from "../lib/sql";
import type { Guarda } from "./tenantHub.types";
import { operacionDemasiadoGrande, type TopeDeOperacion } from "./tenantHub.presupuesto";
import { aResultado, ejecutarEnBruto, migrarBase, type FilasEnBruto } from "./sqliteDelObjeto";

/** Una sentencia de la base del negocio. En un lote (`loteEnBruto`) puede llevar además la `guarda` de un paso `guard` (SYNC-30). */
type SentenciaDelNegocio = Sentencia | { sql: string; args?: unknown[]; guarda?: Guarda };

const VACIO: FilasEnBruto = { columns: [], rows: [], rowsAffected: 0, lastInsertRowid: null };

const APLAZAR_FK = /^\s*PRAGMA\s+defer_foreign_keys\s*=\s*(ON|1|TRUE|YES)\s*;?\s*$/i;

function partes(s: SentenciaDelNegocio): { texto: string; args: unknown[] } {
	if (typeof s === "string") return { texto: s, args: [] };
	const args = s.args ?? [];
	if (!Array.isArray(args)) {
		// Ninguna consulta del negocio usa argumentos con nombre. Si llega una, que se vea aquí y no
		// como un `?1` sin valor.
		throw new Error("tenantHub.sqlite: los argumentos con nombre no están soportados");
	}
	return { texto: s.sql, args };
}

/**
 * Un argumento para `sql.exec`, sin exigir nada: `undefined` es NULL, un booleano es 1 o 0 y un
 * `bigint`, un número. Lo demás pasa tal cual.
 */
function valorParaExec(v: unknown): unknown {
	if (v === undefined) return null;
	if (typeof v === "boolean") return v ? 1 : 0;
	if (typeof v === "bigint") return Number(v);
	return v;
}

/** Ejecuta una sentencia de la base del negocio y devuelve sus filas en bruto. */
export function ejecutarDelNegocio(sql: SqlStorage, s: SentenciaDelNegocio): FilasEnBruto {
	const { texto, args } = partes(s);
	if (APLAZAR_FK.test(texto)) {
		// Fuera de un lote no hay transacción que la acote: el aplazamiento seguiría vivo hasta el
		// commit implícito del evento y una FK rota reseteará el DO. Sólo `loteEnBruto` la honra.
		return VACIO;
	}
	return ejecutarEnBruto(sql, texto, args.map(valorParaExec));
}

function esFkRota(e: unknown): boolean {
	return /FOREIGN KEY constraint failed/i.test(String((e as Error)?.message ?? e));
}

/**
 * Un lote todo-o-nada (`Base.batch`).
 *
 * La Main confirma cada transacción con `defer_foreign_keys` (db.rs), así que sus operaciones pueden
 * escribir una hija antes que su padre, y el motor manda ese mismo PRAGMA al aplicarlas. Aquí no se
 * puede dejar que una FK aplazada llegue rota al commit, porque el runtime resetea el DO en vez de
 * lanzar. Así que:
 *
 * 1. Primero se prueba SIN aplazar. Si entra, el resultado es el mismo que aplazando (aplazar sólo
 *    cambia CUÁNDO se comprueba) y no cuesta nada más.
 * 2. Si falla por una FK, se repite como lo hizo la Main, aplazando, y antes de cerrar se mira
 *    `PRAGMA foreign_key_check`. Si queda alguna rota se lanza un error normal: la transacción se
 *    deshace y el motor lo clasifica como rechazo permanente.
 *
 * Una sentencia con `guarda` (SYNC-30) se comprueba en cuanto se ejecuta, en cualquiera de las dos
 * pasadas: si no se cumple, `GuardaIncumplida` sale de la transacción y no queda nada del lote. No es
 * una FK rota, así que no se repite aplazando.
 *
 * El paso 2 recorre las tablas con FK (unos 230 ms con 250.000 líneas), pero sólo lo paga quien
 * necesita el aplazamiento o trae una FK rota de verdad. Quien aplica varios lotes en un mismo turno
 * (`MotorTenantHub.aplicarLote`) pone tope a ese trabajo con `alAplazar`: se le pregunta justo antes
 * de repetir aplazando, y si dice que no se lanza `HaceFaltaAplazar` con la base como estaba.
 */
export function loteEnBruto(
	storage: DurableObjectStorage,
	sentencias: SentenciaDelNegocio[],
	opciones: { alAplazar?: () => boolean; tope?: TopeDeOperacion } = {},
): FilasEnBruto[] {
	const sql = storage.sql;
	const { tope } = opciones;
	const pideAplazar = sentencias.some((s) => APLAZAR_FK.test(partes(s).texto));

	const correr = (aplazar: boolean): FilasEnBruto[] =>
		storage.transactionSync(() => {
			if (aplazar) sql.exec("PRAGMA defer_foreign_keys = ON;");
			// AUD-36: lo que lleva escrito este intento, para pararlo en cuanto se pasa de su tope.
			const tamanoAntes = tope ? sql.databaseSize : 0;
			let filasDelIntento = 0;
			try {
				const salida = sentencias.map((s) => {
					if (APLAZAR_FK.test(partes(s).texto)) return VACIO;
					const filas = ejecutarDelNegocio(sql, s);
					if (tope) {
						const escritas = filas.filasEscritas ?? 0;
						filasDelIntento += escritas;
						tope.medida.filas += escritas;
						if (filasDelIntento > tope.filas || sql.databaseSize - tamanoAntes > tope.bytes) {
							throw operacionDemasiadoGrande();
						}
					}
					if (typeof s !== "string" && "guarda" in s && s.guarda) exigirGuarda(s.guarda, filas);
					return filas;
				});
				if (aplazar) {
					const rota = sql.exec("PRAGMA foreign_key_check;").toArray()[0] as
						| { table?: string; parent?: string }
						| undefined;
					if (rota) {
						throw new Error(
							`FOREIGN KEY constraint failed: ${rota.table ?? "?"} → ${rota.parent ?? "?"} (aplazada)`,
						);
					}
				}
				return salida;
			} finally {
				// El aplazamiento es de la conexión, no de la transacción: deshacer el lote no lo apaga.
				if (aplazar) sql.exec("PRAGMA defer_foreign_keys = OFF;");
			}
		});

	if (!pideAplazar) return correr(false);
	try {
		return correr(false);
	} catch (e) {
		if (!esFkRota(e)) throw e;
		if (opciones.alAplazar && !opciones.alAplazar()) throw new HaceFaltaAplazar();
		return correr(true);
	}
}

/**
 * SYNC-30 · La guarda de un paso `guard` no se cumple: la escritura no se aplica y contesta el error
 * de negocio de la guarda. Es un `HubError` (lo que lleva el resultado del RPC `aplicar`) y no un
 * fallo: el motor no lo anota como tal.
 */
export class GuardaIncumplida extends HubError {
	constructor(guarda: Guarda) {
		super(guarda.error, guarda.status);
		this.name = "GuardaIncumplida";
	}
}

/**
 * ¿Se cumple la guarda? Su consulta da una fila cuyo primer valor es un número distinto de 0. Sin
 * fila, con `NULL` o con otra cosa, no se cumple. Lanzar aquí, dentro de `transactionSync`, deshace
 * todo lo que el lote llevaba hecho.
 */
function exigirGuarda(guarda: Guarda, filas: FilasEnBruto): void {
	const valor = filas.rows[0]?.[0];
	const cumple = typeof valor === "number" ? valor !== 0 : false;
	if (!cumple) throw new GuardaIncumplida(guarda);
}

/**
 * El lote sólo entra aplazando las claves foráneas (o trae una rota de verdad) y quien lo aplica no
 * ha querido pagar ahora esa comprobación (`loteEnBruto`, `alAplazar`). No dice nada de la
 * operación: no se ha aplicado nada y se puede volver a mandar.
 */
export class HaceFaltaAplazar extends Error {
	constructor() {
		super("hace_falta_aplazar");
	}
}

/** La base del negocio sobre el SQLite del propio Durable Object. */
export function clienteLocal(storage: DurableObjectStorage): Base {
	return {
		async execute(sentencia) {
			return aResultado(ejecutarDelNegocio(storage.sql, sentencia));
		},
		async batch(sentencias) {
			return loteEnBruto(storage, sentencias).map(aResultado);
		},
	};
}

/**
 * Pone al día el esquema de la base del negocio con sus migraciones (`server/tenantMigrations.ts`).
 * Quien llama lo hace dentro de `blockConcurrencyWhile` (`MotorTenantHub.migrarEnExclusiva`): ver
 * `migrarBase`.
 */
export function migrarBaseLocal(storage: DurableObjectStorage): Promise<void> {
	return migrarBase(storage, MIGRATIONS);
}
