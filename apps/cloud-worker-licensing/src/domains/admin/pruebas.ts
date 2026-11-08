// src/domains/admin/pruebas.ts
//
// Los negocios que deja el E2E. Cada tanda emite una licencia de pruebas y la activa, y activarla
// crea su base en Turso. Al acabar, esto las retira para que no se acumulen en el panel: borra la
// base, da el negocio por borrado y anula la licencia.
//
// Sólo toca lo emitido como de pruebas (`origin = 'pruebas'`) y lo que el E2E emitía antes de que
// existiera esa marca: licencias manuales con su correo, que es de un dominio `.test` y no puede
// ser de nadie. Un negocio que tenga además cualquier otra licencia no se toca nunca.

import type { Client } from "@libsql/client/web";

import type { Env } from "../../env";
import { enTransaccion, exec, rowsAffected } from "../../server/db";
import { tursoDeleteDatabase } from "../../server/db/tenantDb";

/** El correo con el que el E2E emite sus licencias (`apps/tpv-main/e2e/helpers/licencias.ts`). */
export const CORREO_DE_PRUEBAS = "e2e@altarialights.test";

/** ¿Es de pruebas la licencia `alias`? El correo va en `?1`. */
function dePruebas(alias: string): string {
	return `(${alias}.origin = 'pruebas' OR (${alias}.origin = 'manual' AND ${alias}.customer_email = ?1))`;
}

/** Un negocio cuyas licencias son todas de pruebas. */
const SOLO_DE_PRUEBAS = `NOT EXISTS (
	SELECT 1 FROM licenses o WHERE o.tenant_id = l.tenant_id AND NOT ${dePruebas("o")}
)`;

export type Retirada = {
	/** Negocios dados por borrados. */
	negocios: number;
	/** Bases borradas en Turso (las que ya no existían cuentan como negocio, no como base). */
	bases: number;
	/** Licencias de pruebas anuladas. */
	licencias: number;
	/** Los negocios que no se pudieron retirar; se quedan como estaban para el siguiente intento. */
	fallos: { tenantId: string; error: string }[];
};

/**
 * Retira todos los negocios de pruebas que queden. Repetirlo no hace nada: lo ya retirado no vuelve
 * a salir, y lo que falló se reintenta.
 */
export async function retirarNegociosDePrueba(
	db: Client,
	env: Pick<Env, "TURSO_PLATFORM_TOKEN" | "TURSO_ORG_SLUG">,
): Promise<Retirada> {
	const retirada: Retirada = { negocios: 0, bases: 0, licencias: 0, fallos: [] };

	const pendientes = await exec(
		db,
		`SELECT DISTINCT l.tenant_id AS tenant_id, d.turso_db_name AS turso_db_name
		   FROM licenses l
		   LEFT JOIN tenant_databases d ON d.tenant_id = l.tenant_id
		   LEFT JOIN tenants t ON t.tenant_id = l.tenant_id
		  WHERE l.tenant_id IS NOT NULL AND ${dePruebas("l")} AND ${SOLO_DE_PRUEBAS}
		    AND (d.tenant_id IS NOT NULL OR t.status IS NOT 'deleted');`,
		[CORREO_DE_PRUEBAS],
	);

	for (const fila of pendientes.rows as any[]) {
		const tenantId = String(fila.tenant_id);
		const base = fila.turso_db_name ? String(fila.turso_db_name) : null;
		try {
			// La base primero: si Turso falla, el negocio se queda como estaba y el siguiente
			// intento la vuelve a encontrar. Al revés, se perdería la fila que dice cuál borrar.
			if (base && (await tursoDeleteDatabase(env, base)) === "borrada") retirada.bases++;
			await enTransaccion(db, async (tx) => {
				await exec(tx, `DELETE FROM tenant_databases WHERE tenant_id = ?;`, [tenantId]);
				await exec(
					tx,
					`UPDATE tenants SET status = 'deleted', updated_at_ms = ? WHERE tenant_id = ?;`,
					[Date.now(), tenantId],
				);
			});
			retirada.negocios++;
		} catch (e: any) {
			retirada.fallos.push({ tenantId, error: String(e?.message || e) });
		}
	}

	// Las licencias, también las que nunca se activaron. Las de un negocio que no se pudo retirar se
	// anulan igual: anular no borra nada y no tiene por qué esperar a Turso.
	const anuladas = await exec(
		db,
		`UPDATE licenses SET status = 'revoked', disabled = 1, updated_at_ms = ?2
		  WHERE license_id IN (
		    SELECT l.license_id FROM licenses l
		     WHERE ${dePruebas("l")} AND l.status <> 'revoked'
		       AND (l.tenant_id IS NULL OR ${SOLO_DE_PRUEBAS})
		  );`,
		[CORREO_DE_PRUEBAS, Date.now()],
	);
	retirada.licencias = rowsAffected(anuladas);

	return retirada;
}
