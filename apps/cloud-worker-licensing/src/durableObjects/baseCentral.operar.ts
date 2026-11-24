// src/durableObjects/baseCentral.operar.ts
//
// Cómo corre una operación de la base central (`server/central/operaciones/registro.ts`): entera
// dentro de un `transactionSync`, que la deshace si lanza, sobre una base sin esperas (`SqlSync`)
// con el mismo enlace de valores y las mismas guardas de sentencias que `ejecutar`.
//
// Lo que se vigila aquí:
//
// - **Que sea síncrona de verdad.** Una operación `async` empieza dentro de la transacción, pero lo
//   que hace después de su primer `await` ya no estaría en ella. Si devuelve algo con `then`, se
//   rechaza (`central_operacion_fallida`) y lo que llevaba escrito se deshace. Y su base se cierra
//   en cuanto acaba la transacción, así que lo que intentara escribir después lanza en vez de
//   entrar suelto. Ese rechazo se recoge aquí: no sale como «unhandled rejection».
// - **Que lo que devuelve sea un dato.** El RPC lo serializa cuando la transacción ya está
//   confirmada: si no pudiera (una instancia de una clase propia, una función), lo escrito se
//   quedaría y quien la pidió recibiría un error, y la repetiría. Así que se mira antes de
//   confirmar, y si no lo es, también se deshace.

import type { Resultado, SqlSync } from "../lib/sql";
import { enlazar } from "../server/central/enlace";
import type { Operacion } from "../server/central/operaciones/registro";
import type { RespuestaDeLaCentral } from "./baseCentral.rpc";
import { motivoDeRechazo } from "./baseCentral.guardas";
import { aResultado, ejecutarEnBruto } from "./sqliteDelObjeto";

/** Una base sin esperas sobre el SQLite del objeto, que deja de servir al cerrarla. */
function baseSincrona(sql: SqlStorage): { base: SqlSync; cerrar: () => void } {
	let abierta = true;
	return {
		base: {
			execute(sentencia): Resultado {
				if (!abierta) throw new Error("La operación de la base central ya ha terminado: no puede ejecutar nada más.");
				const { sql: texto, args } = enlazar(sentencia);
				const motivo = motivoDeRechazo(texto);
				if (motivo) throw new Error(motivo);
				return aResultado(ejecutarEnBruto(sql, texto, args));
			},
		},
		cerrar: () => {
			abierta = false;
		},
	};
}

function esPromesa(valor: unknown): valor is PromiseLike<unknown> {
	return (
		(typeof valor === "object" || typeof valor === "function") &&
		valor !== null &&
		typeof (valor as { then?: unknown }).then === "function"
	);
}

/**
 * ¿Es `valor` un dato, que el RPC devuelve tal cual? `null`, `undefined`, booleanos, números,
 * textos, `ArrayBuffer`, y arrays y objetos literales de datos. Una fila de un `Resultado` lo es:
 * sus columnas son sus únicas propiedades enumerables.
 */
function esDato(valor: unknown, vistos = new Set<object>()): boolean {
	if (valor === null || valor === undefined) return true;
	const tipo = typeof valor;
	if (tipo === "boolean" || tipo === "number" || tipo === "string") return true;
	if (tipo !== "object") return false;
	const objeto = valor as object;
	if (objeto instanceof ArrayBuffer || vistos.has(objeto)) return true;
	vistos.add(objeto);
	if (Array.isArray(objeto)) return objeto.every((v) => esDato(v, vistos));
	const prototipo = Object.getPrototypeOf(objeto);
	if (prototipo !== Object.prototype && prototipo !== null) return false;
	return Object.values(objeto).every((v) => esDato(v, vistos));
}

/**
 * Ejecuta la operación `nombre` de `operaciones` con sus `datos`, todo o nada. Lo que devuelve (su
 * resultado de negocio) viaja como valor; si lanza, no queda nada escrito y contesta
 * `central_operacion_fallida` con el motivo, que quien la pidió lanza en su lado.
 */
export function ejecutarOperacion(
	storage: DurableObjectStorage,
	operaciones: Readonly<Record<string, Operacion>>,
	nombre: string,
	datos: unknown,
): RespuestaDeLaCentral<unknown> {
	const operacion = Object.hasOwn(operaciones, nombre) ? operaciones[nombre] : undefined;
	if (!operacion) return { ok: false, error: "central_operacion_desconocida", detalle: nombre };

	const { base, cerrar } = baseSincrona(storage.sql);
	try {
		const valor = storage.transactionSync(() => {
			const resultado = operacion(base, datos);
			if (esPromesa(resultado)) {
				resultado.then(undefined, () => {});
				throw new Error(`La operación '${nombre}' de la base central ha devuelto una promesa: tiene que ser síncrona.`);
			}
			if (!esDato(resultado)) {
				throw new Error(
					`La operación '${nombre}' de la base central ha devuelto algo que no es un dato (una instancia, una función): no puede volver por el RPC.`,
				);
			}
			return resultado;
		});
		return { ok: true, valor };
	} catch (error) {
		return { ok: false, error: "central_operacion_fallida", detalle: String((error as Error)?.message ?? error) };
	} finally {
		cerrar();
	}
}
