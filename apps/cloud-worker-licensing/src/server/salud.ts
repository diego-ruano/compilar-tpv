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
import { cifrar, descifrar, type ClavesOClave } from "./crypto";

/**
 * Lo que se recuerda un veredicto. El endpoint es público y sin autenticar, así que sin caché es
 * un generador gratuito de consultas contra la base central para cualquiera que lo descubra. Con
 * sondas cada 3 minutos, 30 s no retrasa nada que importe.
 */
export const CACHE_MS = 30_000;

/**
 * RI-73 · El canario de `LICENSE_STORE_KEY`: un texto fijo cifrado con ella en `canario_cifrado`.
 *
 * El 27/09 se regeneraron los secretos del worker y todo lo cifrado antes —las DEK, los tokens de
 * Turso, las claves de licencia— dejó de poder leerse. `/health` siguió en verde, porque sólo tocaba
 * la base, y nos enteramos con la primera activación que falló. Ahora `/health` descifra esta fila:
 * con una clave equivocada contesta 503 en minutos, antes de que le pase a un cliente.
 *
 * La fila la crea el propio `/health` la primera vez que no la encuentra, con la clave de ese
 * momento. Si la tabla no existe todavía (falta el cambio a mano en Turso), no se comprueba —y se
 * dice—, pero la base sigue contando como viva: no es esa la avería que mide `db`.
 */
export const TEXTO_CANARIO = "tpv-api: LICENSE_STORE_KEY";

export type Salud = {
	ok: boolean;
	db: "ok" | "inalcanzable";
	cifrado: "ok" | "falla" | "sin_comprobar";
};

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
	claves?: ClavesOClave,
): Promise<Salud> {
	if (recordado && ahoraMs - recordado.ms < CACHE_MS) return recordado.salud;

	let salud: Salud;
	try {
		const db = abrir();
		await db.execute("SELECT 1");
		const cifrado = claves ? await comprobarCanario(db, claves, ahoraMs) : "sin_comprobar";
		salud = { ok: cifrado !== "falla", db: "ok", cifrado };
	} catch (err) {
		// El cuerpo de `/health` lo lee cualquiera: el error de libsql puede llevar dentro la URL
		// de la base y el motivo exacto, y eso no se le cuenta a quien pregunte. El diagnóstico va
		// al log, que sí es nuestro.
		console.error("[health] la base central no responde:", (err as any)?.message || err);
		salud = { ok: false, db: "inalcanzable", cifrado: "sin_comprobar" };
	}

	recordado = { ms: ahoraMs, salud };
	return salud;
}

/** Descifra el canario (o lo crea si no lo hay). Ver `TEXTO_CANARIO`. */
async function comprobarCanario(
	db: Sql,
	claves: ClavesOClave,
	ahoraMs: number,
): Promise<Salud["cifrado"]> {
	let guardado: string | null;
	try {
		const r = await db.execute("SELECT valor FROM canario_cifrado WHERE id = 1;");
		guardado = r.rows?.[0] ? String((r.rows[0] as any).valor) : null;
	} catch (err) {
		console.error("[health] no se puede leer canario_cifrado:", (err as any)?.message || err);
		return "sin_comprobar";
	}

	try {
		if (guardado === null) {
			await db.execute({
				sql: "INSERT INTO canario_cifrado (id, valor, creado_ms) VALUES (1, ?, ?) ON CONFLICT(id) DO NOTHING;",
				args: [await cifrar(claves, TEXTO_CANARIO), ahoraMs],
			});
			return "ok";
		}
		const { texto, recifrado } = await descifrar(claves, guardado);
		if (texto !== TEXTO_CANARIO) return "falla";
		// En plena rotación: se queda ya con la clave actual, como todo lo demás.
		if (recifrado) {
			await db.execute({
				sql: "UPDATE canario_cifrado SET valor = ? WHERE id = 1 AND valor = ?;",
				args: [recifrado, guardado],
			});
		}
		return "ok";
	} catch (err) {
		console.error("[health] LICENSE_STORE_KEY no descifra el canario:", (err as any)?.message || err);
		return "falla";
	}
}
