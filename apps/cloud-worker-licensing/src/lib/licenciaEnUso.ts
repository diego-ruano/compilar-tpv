// src/lib/licenciaEnUso.ts
//
// ¿La licencia de este negocio deja trabajar a este dispositivo? (REV-12)
//
// La comprobación existía, pero sólo delante del ticket del WebSocket. El resto del worker se
// conformaba con el JWT, que dura 30 días y `/v1/license/status` **renueva cada seis horas**: con
// una licencia anulada o caducada, un dispositivo seguía teniendo un token válido y con él seguía
// enviando correo con nuestro dominio, subiendo imágenes a R2, descargándose el volcado completo de
// `/v1/sync/bootstrap` y leyendo todo lo de la Handy. El cliente se bloquea solo porque obedece la
// aserción firmada — o sea que lo único que lo impedía era la buena fe del cliente.
//
// Reglas al tocar esto:
//
//   · **`expiry_grace` PASA, a propósito.** Durante la gracia el TPV sigue vendiendo, y vender sin
//     poder replicar es la peor combinación posible: acumula un outbox que quizá no suba nunca.
//   · **Va en `tenantAuth`**, que es por donde pasan todas las rutas de negocio, y no en una lista
//     de las que parecen delicadas: la siguiente que alguien añada tiene que quedar cubierta sola.
//   · **Se cachea por isolate y por poco tiempo.** Sin caché serían dos consultas más al
//     control-plane en CADA petición. Con ella, el peor retraso en enterarse de una anulación es de
//     un minuto — y la anulación ya no depende de esto para llegar rápido: `revoke` le pide al
//     TenantHub que cierre el socket del equipo en el acto (§9).

import {
	computeLicenseState,
	stateAllowsUse,
} from "../domains/licensing/licensing.helpers";
import { getDb } from "../server/db";
import { getLicenseByHash } from "../server/licenseStore";

/**
 * Lo que hace falta del contexto, y sólo eso: se lee con `get`, así que un contexto con más
 * variables encaja igual. Escribirlo como el `TenantVars` completo ataría este módulo al
 * middleware, y lo usan los dos.
 */
type ContextoLicencia = {
	env: any;
	get: (clave: "tenantId" | "deviceId" | "licHash") => string;
};

/** Identificador del rechazo, o `null` si puede operar. */
export type VetoLicencia = "license_not_found" | "license_revoked" | "license_expired" | "device_replaced";

const CACHE_MS = 60_000;
// Tope del mapa: un isolate longevo con muchos tenants no puede crecer sin fin. Al pasarse se
// vacía entero en vez de buscar el más viejo — es una caché, no un índice.
const CACHE_MAX = 500;

const cache = new Map<string, { hasta: number; veto: VetoLicencia | null }>();

/**
 * Comprueba la licencia del tenant para ESTE dispositivo.
 *
 * El `deviceId` importa: un dispositivo con rol `tpv` que ya no es el `main_device_id` de su
 * licencia es una Main desplazada (la licencia se activó en otro equipo) y tiene que dejar de
 * escribir, o dos Mains replicarían a la vez sobre el mismo tenant. A una Handy eso no se le puede
 * aplicar —nunca es, ni puede ser, el `main_device_id`—, y por eso el estado se calcula con el
 * `main_device_id` de la licencia cuando quien pregunta no lo es.
 */
export async function vetoDeLicencia(c: ContextoLicencia): Promise<VetoLicencia | null> {
	const licHash = c.get("licHash");
	const tenantId = c.get("tenantId");
	const deviceId = c.get("deviceId");

	const clave = `${licHash}|${tenantId}|${deviceId}`;
	const ahora = Date.now();
	const guardado = cache.get(clave);
	if (guardado && guardado.hasta > ahora) return guardado.veto;

	const veto = await calcular(c, licHash, tenantId, deviceId);

	if (cache.size >= CACHE_MAX) cache.clear();
	cache.set(clave, { hasta: ahora + CACHE_MS, veto });
	return veto;
}

async function calcular(
	c: ContextoLicencia,
	licHash: string,
	tenantId: string,
	deviceId: string,
): Promise<VetoLicencia | null> {
	const db = getDb(c.env);

	const lic = await getLicenseByHash(db, licHash);
	if (!lic) return "license_not_found";

	const esMain = lic.main_device_id === deviceId;
	const rs = await db.execute({
		sql: `SELECT role FROM devices WHERE tenant_id=? AND device_id=? LIMIT 1;`,
		args: [tenantId, deviceId],
	});
	const rol = String((rs.rows?.[0] as any)?.role || "").toLowerCase();

	if (rol === "tpv" && !esMain) return "device_replaced";

	const estado = computeLicenseState(
		lic,
		esMain ? deviceId : (lic.main_device_id ?? deviceId),
		Date.now(),
	);
	if (stateAllowsUse(estado)) return null;

	return estado === "revoked" ? "license_revoked" : "license_expired";
}

/** Sólo para los tests: un isolate de vitest se reutiliza entre casos. */
export function olvidarLicenciasCacheadas(): void {
	cache.clear();
}
