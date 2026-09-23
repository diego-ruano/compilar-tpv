// src/server/salud.ts
//
// El veredicto de `/health`, que es lo único que mira la monitorización externa (PROD-01).
//
// Antes devolvía `{ ok: true }` sin tocar nada, o sea que sólo demostraba que el isolate arranca.
// Un worker desplegado con las credenciales de Turso caducadas —que deja tiradas a todas las Handy
// y detiene la replicación de todos los negocios— contestaba ese 200 igual de sano, así que el
// monitor se quedaba verde durante la avería entera. Aquí se toca la base CENTRAL, que es la
// dependencia por la que pasa todo. No se toca ninguna base de tenant: eso es por negocio y
// exigiría autenticación, y este endpoint es público a propósito.
//
// El veredicto viaja en el CÓDIGO DE ESTADO (200/503) y no en una palabra del cuerpo: leer el
// cuerpo es una opción de pago en la monitorización, y siendo nuestro el endpoint no hay razón
// para no decirlo por donde sabe leer cualquier sonda.

import type { Sql } from "./db";

/**
 * Lo que se recuerda un veredicto. El endpoint es público y sin autenticar, así que sin caché es
 * un generador gratuito de consultas contra la base central para cualquiera que lo descubra. Con
 * sondas cada 3 minutos, 30 s no retrasa nada que importe.
 */
export const CACHE_MS = 30_000;

export type Salud = { ok: boolean; db: "ok" | "inalcanzable" };

// Caché POR ISOLATE. Aquí una variable de módulo sí es legítima —al contrario que en los módulos
// del TenantHub (§9), donde el isolate se comparte entre instancias y guardar algo así le serviría
// a un negocio lo que guardó otro—: esto es la base central, que es una sola para todos. Es el
// mismo patrón que el veto de licencia cacheado 60 s.
let recordado: { ms: number; salud: Salud } | null = null;

/** Para los tests: el caché vive lo que el isolate, así que sin esto un caso contamina al siguiente. */
export function olvidarSalud(): void {
	recordado = null;
}

/**
 * `abrir` es un thunk y no una conexión ya hecha para que resolver las credenciales entre también
 * en el `try`: un worker desplegado sin `TURSO_AUTH_TOKEN` está igual de roto que uno cuya base no
 * contesta, y las dos averías tienen que salir por el mismo sitio.
 */
export async function comprobarSalud(
	abrir: () => Sql,
	ahoraMs: number = Date.now(),
): Promise<Salud> {
	if (recordado && ahoraMs - recordado.ms < CACHE_MS) return recordado.salud;

	let salud: Salud;
	try {
		await abrir().execute("SELECT 1");
		salud = { ok: true, db: "ok" };
	} catch (err) {
		// El cuerpo de `/health` lo lee cualquiera: el error de libsql puede llevar dentro la URL
		// de la base y el motivo exacto, y eso no se le cuenta a quien pregunte. El diagnóstico va
		// al log, que sí es nuestro.
		console.error("[health] la base central no responde:", (err as any)?.message || err);
		salud = { ok: false, db: "inalcanzable" };
	}

	recordado = { ms: ahoraMs, salud };
	return salud;
}
