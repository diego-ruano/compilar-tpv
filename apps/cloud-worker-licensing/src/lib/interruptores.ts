// src/lib/interruptores.ts
//
// PROD-06 · Interruptores remotos de emergencia.
//
// Si una tarea automática se pone a hacer daño en los equipos de los clientes —la remisión a la
// AEAT manda XML roto, la reparación por estado pisa filas buenas, el volcado satura Turso—, la
// única forma de pararla era publicar una versión y esperar a que cada TPV se actualizara. Esto
// deja apagarla desde aquí, en minutos, con una fila en la tabla `interruptores` de la base
// central (su estructura está en `docs/sql/control-plane/esquema-actual.sql`).
//
// Reglas al tocar esto:
//
//   · **La lista es cerrada** (`Interruptor` en `tpv-contracts`) y la valida el zod de abajo, con
//     drift-guard contra el contrato. La tabla no lleva `CHECK` a propósito: añadir un interruptor
//     no puede obligar a rehacerla en Turso.
//   · **Todo interruptor caduca.** `expires_at_ms` es obligatorio: uno olvidado se enciende solo.
//     Si hace falta más tiempo, se vuelve a apagar.
//   · **Si no se puede leer, todo está encendido.** Esto es un freno de mano, no una dependencia:
//     una caída de la base central no puede convertirse en «el TPV deja de remitir a la AEAT».
//   · **Se cachea por isolate y poco tiempo**, como la licencia (`licenciaEnUso.ts`): el TPV
//     pregunta cada pocos minutos y el DO en cada vuelta de su cola.

import * as z from "zod";
import type { Interruptor, InterruptorApagado } from "@tpv/contracts";

import { compararVersiones } from "../domains/updates/updates.routes";
import type { Sql } from "../server/db";
import type { Assert } from "./typeGuards";

export const INTERRUPTORES = [
	"verifactu_remitir",
	"reparacion_nube",
	"volcado_atraso",
	"cola_do",
	"backfill_historico",
	"cifrado_pii",
	"imagenes",
] as const;

export const zInterruptor = z.enum(INTERRUPTORES);

// Las dos direcciones: un interruptor nuevo en Rust que no esté aquí, o uno de aquí que Rust no
// conozca, dejan de compilar.
type _MismoCatalogo = Assert<
	[z.infer<typeof zInterruptor>] extends [Interruptor]
		? [Interruptor] extends [z.infer<typeof zInterruptor>]
			? true
			: false
		: false
>;

/** El tope general de un apagado. Lo que tenga que durar más se vuelve a apagar a conciencia. */
export const MAX_HORAS = 7 * 24;

/**
 * La remisión a la AEAT es una obligación tributaria: pararla vale para no generar rechazos
 * mientras sale un arreglo, no para dejarla parada. Por eso su tope es mucho más corto.
 */
export const MAX_HORAS_POR_INTERRUPTOR: Partial<Record<Interruptor, number>> = {
	verifactu_remitir: 24,
};

export function maxHoras(i: Interruptor): number {
	return MAX_HORAS_POR_INTERRUPTOR[i] ?? MAX_HORAS;
}

/** Una fila de la tabla, ya leída. */
export type FilaInterruptor = {
	interruptor_id: string;
	interruptor: string;
	tenant_id: string;
	version_desde: string | null;
	version_hasta: string | null;
	motivo: string;
	expires_at_ms: number;
	created_at_ms: number;
};

/** Todo tenant. Un literal y no `NULL` para que la columna pueda ser `NOT NULL`. */
export const TODOS = "*";

/**
 * ¿Esta fila aplica a esta versión?
 *
 * Sin versión conocida sólo aplican las filas sin rango: un apagado «sólo en la 1.4.2» no puede
 * alcanzar a quien no dice qué versión es. Los límites son inclusivos.
 */
export function aplicaAVersion(
	fila: Pick<FilaInterruptor, "version_desde" | "version_hasta">,
	version: string | null,
): boolean {
	const desde = fila.version_desde?.trim() || null;
	const hasta = fila.version_hasta?.trim() || null;
	if (!desde && !hasta) return true;
	if (!version) return false;
	if (desde && compararVersiones(version, desde) < 0) return false;
	if (hasta && compararVersiones(version, hasta) > 0) return false;
	return true;
}

/**
 * Reduce las filas vigentes a un apagado por interruptor. Si hay varias para el mismo (una global
 * y otra del tenant, por ejemplo), gana la que dura más: apagar es la decisión conservadora.
 * Las filas con un interruptor que esta versión del worker no conoce se ignoran.
 */
export function reducir(
	filas: FilaInterruptor[],
	tenantId: string,
	version: string | null,
	ahoraMs: number,
): InterruptorApagado[] {
	const porNombre = new Map<Interruptor, InterruptorApagado>();
	for (const f of filas) {
		const nombre = zInterruptor.safeParse(f.interruptor);
		if (!nombre.success) continue;
		if (Number(f.expires_at_ms) <= ahoraMs) continue;
		if (f.tenant_id !== TODOS && f.tenant_id !== tenantId) continue;
		if (!aplicaAVersion(f, version)) continue;

		const previo = porNombre.get(nombre.data);
		const hasta = Number(f.expires_at_ms);
		if (!previo || hasta > previo.hasta_ms) {
			porNombre.set(nombre.data, {
				interruptor: nombre.data,
				motivo: String(f.motivo ?? ""),
				hasta_ms: hasta,
			});
		}
	}
	return [...porNombre.values()];
}

/** Las filas vigentes que pueden tocar a este tenant. */
export async function leerVigentes(db: Sql, tenantId: string, ahoraMs: number): Promise<FilaInterruptor[]> {
	const rs = await db.execute({
		sql: `SELECT interruptor_id, interruptor, tenant_id, version_desde, version_hasta, motivo,
		             expires_at_ms, created_at_ms
		        FROM interruptores
		       WHERE expires_at_ms > ? AND tenant_id IN (?, ?);`,
		args: [ahoraMs, TODOS, tenantId],
	});
	return (rs.rows ?? []) as unknown as FilaInterruptor[];
}

const CACHE_MS = 60_000;
const CACHE_MAX = 500;
const cache = new Map<string, { hasta: number; filas: FilaInterruptor[] }>();

/**
 * Lo que está apagado para este tenant y esta versión. **Nunca lanza**: si la base central no
 * contesta, devuelve lista vacía — todo encendido, que es como funcionaba antes de existir esto.
 */
export async function apagadosPara(
	db: () => Sql,
	tenantId: string,
	version: string | null,
): Promise<InterruptorApagado[]> {
	const ahora = Date.now();
	let filas: FilaInterruptor[];

	const guardado = cache.get(tenantId);
	if (guardado && guardado.hasta > ahora) {
		filas = guardado.filas;
	} else {
		try {
			filas = await leerVigentes(db(), tenantId, ahora);
		} catch (e: any) {
			console.warn("interruptores: no se pudieron leer, todo encendido:", String(e?.message || e));
			return [];
		}
		if (cache.size >= CACHE_MAX) cache.clear();
		cache.set(tenantId, { hasta: ahora + CACHE_MS, filas });
	}

	return reducir(filas, tenantId, version, ahora);
}

/** ¿Está apagado este interruptor para este tenant? Mismo fallo hacia «encendido». */
export async function estaApagado(
	db: () => Sql,
	tenantId: string,
	interruptor: Interruptor,
	version: string | null = null,
): Promise<InterruptorApagado | null> {
	const lista = await apagadosPara(db, tenantId, version);
	return lista.find((a) => a.interruptor === interruptor) ?? null;
}

/**
 * Tras apagar o encender desde administración. Sólo vacía la caché de ESTE isolate: el resto se
 * entera en menos de un minuto, que es el retraso asumido.
 */
export function olvidarInterruptoresCacheados(): void {
	cache.clear();
}
