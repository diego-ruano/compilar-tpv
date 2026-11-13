// src/lib/basePerdida.ts
//
// DO-PERDIDA · Un negocio que ya nació y no tiene base no es un negocio sin estrenar.
//
// La base de un negocio vive en el SQLite de su TenantHub, y un objeto vacío no dice por qué lo
// está: puede ser un negocio que todavía no ha nacido, o uno cuya base está en otro objeto (el
// despliegue apunta a otro espacio de nombres o a otra jurisdicción, y el mismo nombre da otro
// objeto) o se borró por error. Tratar lo segundo como lo primero es ofrecerle a la Main «crear una
// base nueva y vacía» y, si acepta, dejar al negocio con una nube en blanco y su equipo
// descargándola, con los datos de verdad en otro sitio.
//
// Quién ha nacido lo dice la base central, sin tocar su esquema: **un negocio nace cuando se activa
// su primera licencia**, y la activación crea la base ANTES de apuntar la licencia
// (`/v1/license/activate`: `provisionTenantDatabase` y después `activateLicenseFirstTime`, que es
// quien pone `tenant_id`, `main_device_id` y `activated_at_ms` en la fila). Así que una licencia de
// ese negocio con `activated_at_ms` es la prueba de que su base llegó a existir. No dice si la base
// guardaba ventas o sólo el administrador inicial: eso la base central no lo sabe, y por eso la
// regla no depende de ello.
//
// Lo que sale de ahí, en un solo sitio cada cosa:
//
// - **Una base sólo se crea para un negocio que no ha nacido** (`provisionTenantDatabase`, por
//   donde pasan la activación y `/v1/sync/initialize-empty`). Para uno que ya nació y no la tiene,
//   `tenant_db_perdida`: no se crea nada.
// - **Una ruta autenticada que se encuentra sin base** contesta `tenant_db_perdida` (503) y no
//   `tenant_db_not_provisioned`, que es el código con el que la Main ofrece empezar de cero
//   (`app.onError`).
// - **Se avisa** (Sentry y Axiom): es una avería que no se arregla sola ni desde el equipo.
//
// El socket de la Main no pasa por aquí: su `apply` sigue recibiendo `tenant_db_not_provisioned`,
// que para su outbox es pasajero (`tenantHub.errores.ts`) y no ofrece nada a nadie.

import type { Env } from "../env";
import type { Sql } from "../server/db";
import { HubError } from "./errorHttp";
import { ingestToAxiom } from "../observability/axiom";
import { capturarError } from "../observability/errors";

/** El rechazo. Para quien lo recibe es la nube sin disponibilidad (`external`), no un fallo suyo. */
export function errorDeBasePerdida(): HubError {
	return new HubError("tenant_db_perdida", 503);
}

export function esBasePerdida(error: unknown): boolean {
	return (error as { code?: unknown } | null)?.code === errorDeBasePerdida().code;
}

/**
 * ¿Ha nacido este negocio? Es decir: ¿llegó a activarse alguna licencia suya? Cuenta también la
 * que después se anuló o caducó: su base existió igual.
 *
 * Lanza si la base central no contesta. Quien llama no puede tomar eso por un «no»: sin saberlo
 * no se crea ninguna base ni se ofrece crearla.
 */
export async function negocioNacido(db: Sql, tenantId: string): Promise<boolean> {
	if (!tenantId) return false;
	const r = await db.execute({
		sql: `SELECT 1 FROM licenses WHERE tenant_id = ? AND activated_at_ms IS NOT NULL LIMIT 1;`,
		args: [tenantId],
	});
	return (r.rows?.length ?? 0) > 0;
}

/** Cada cuánto, como mucho, se avisa del mismo negocio desde un isolate. */
const AVISO_CADA_MS = 10 * 60 * 1000;
// Como la caché de licencias (`licenciaEnUso.ts`): acotado, y al pasarse se vacía entero. Esto
// también corre dentro del TenantHub (`app.onError`), y ahí no mezcla negocios: cada uno tiene su
// clave, y sólo decide si se avisa otra vez. Lo que se contesta no depende de él, y perderlo (al
// hibernar, al vaciarse) sólo adelanta el siguiente aviso.
const AVISOS_MAX = 500;
const avisados = new Map<string, number>();

/**
 * Avisa de que un negocio que debería tener base no la tiene. Un equipo que se la encuentra así
 * repite la petición, y con un aviso basta: uno cada diez minutos por negocio e isolate.
 *
 * Devuelve la entrega a Axiom, que quien llama tiene que mantener viva (`waitUntil`).
 */
export function avisarBasePerdida(
	env: Env,
	campos: { tenant_id: string; device_id?: string; donde: string },
): Promise<unknown> {
	const ahora = Date.now();
	const ultimo = avisados.get(campos.tenant_id);
	if (ultimo !== undefined && ahora - ultimo < AVISO_CADA_MS) return Promise.resolve();
	if (avisados.size >= AVISOS_MAX) avisados.clear();
	avisados.set(campos.tenant_id, ahora);

	// Un error propio y no el `HubError` del rechazo: aquél es un 503 que `capturarError` da por ya
	// avisado, justo porque quien avisa es esto.
	capturarError(new Error("La base de un negocio que ya nació no está en su TenantHub"), "tenant_db.perdida");

	const dataset = env.AXIOM_DATASET_SYNC || env.AXIOM_DATASET;
	if (!env.AXIOM_TOKEN || !dataset) return Promise.resolve();
	return ingestToAxiom(env, dataset, [
		{ _time: new Date().toISOString(), service: "tpv-api", event: "tenant_db_perdida", ...campos },
	]);
}

/** Sólo para los tests: un isolate de vitest se reutiliza entre casos. */
export function olvidarAvisosDeBasePerdida(): void {
	avisados.clear();
}
