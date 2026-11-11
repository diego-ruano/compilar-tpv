// src/domains/admin/pruebas.ts
//
// Los negocios que deja el E2E. Cada tanda emite una licencia de pruebas y la activa, y activarla
// crea su base en el TenantHub del negocio. Al acabar, esto las retira para que no se acumulen en el
// panel: borra la base, da el negocio por borrado y anula la licencia.
//
// Sólo toca lo emitido como de pruebas (`origin = 'pruebas'`) y lo que el E2E emitía antes de que
// existiera esa marca: licencias manuales con su correo, que es de un dominio `.test` y no puede
// ser de nadie. Un negocio que tenga además cualquier otra licencia no se toca nunca.

import type { Client } from "@libsql/client/web";

import type { Env } from "../../env";
import { exec, rowsAffected } from "../../server/db";
import { hubDe } from "../../lib/hub";

/** El correo con el que el E2E emite sus licencias (`apps/tpv-main/e2e/helpers/licencias.ts`). */
export const CORREO_DE_PRUEBAS = "e2e@altarialights.test";

/** ¿Es de pruebas la licencia `alias`? El correo va en `?1`. */
function dePruebas(alias: string): string {
	return `(${alias}.origin = 'pruebas' OR (${alias}.origin = 'manual' AND ${alias}.customer_email = ?1))`;
}

/**
 * Cuántos negocios retira una llamada. Cada uno son dos peticiones salientes (su TenantHub y la base
 * central), y un Worker tiene un tope de peticiones por llamada (50 en el plan gratuito): sin techo,
 * una purga grande se quedaba a medias con «Too many subrequests». Lo que no cabe sale en `quedan`.
 */
export const NEGOCIOS_POR_LLAMADA = 10;

/** Un negocio cuyas licencias son todas de pruebas. */
const SOLO_DE_PRUEBAS = `NOT EXISTS (
	SELECT 1 FROM licenses o WHERE o.tenant_id = l.tenant_id AND NOT ${dePruebas("o")}
)`;

export type Retirada = {
	/** Negocios dados por borrados. */
	negocios: number;
	/** Bases borradas (la de cada negocio retirado, en su TenantHub). */
	bases: number;
	/** Licencias de pruebas anuladas. */
	licencias: number;
	/** Los negocios que no se pudieron retirar; se quedan como estaban para el siguiente intento. */
	fallos: { tenantId: string; error: string }[];
	/** Si quedan más negocios por retirar que los de esta llamada. */
	quedan: boolean;
};

/**
 * Retira los negocios de pruebas que queden, `NEGOCIOS_POR_LLAMADA` como mucho. Repetirlo no hace
 * nada: lo ya retirado no vuelve a salir, y lo que falló se reintenta.
 */
export async function retirarNegociosDePrueba(
	db: Client,
	env: Pick<Env, "TenantHub" | "JURISDICCION_DO">,
): Promise<Retirada> {
	const retirada: Retirada = { negocios: 0, bases: 0, licencias: 0, fallos: [], quedan: false };

	const pendientes = await exec(
		db,
		`SELECT DISTINCT l.tenant_id AS tenant_id
		   FROM licenses l
		   LEFT JOIN tenants t ON t.tenant_id = l.tenant_id
		  WHERE l.tenant_id IS NOT NULL AND ${dePruebas("l")} AND ${SOLO_DE_PRUEBAS}
		    AND t.status IS NOT 'deleted'
		  ORDER BY l.tenant_id
		  LIMIT ?2;`,
		[CORREO_DE_PRUEBAS, NEGOCIOS_POR_LLAMADA + 1],
	);
	const filas = pendientes.rows as any[];
	retirada.quedan = filas.length > NEGOCIOS_POR_LLAMADA;

	for (const fila of filas.slice(0, NEGOCIOS_POR_LLAMADA)) {
		const tenantId = String(fila.tenant_id);
		try {
			// La base primero: si falla, el negocio se queda como estaba y el siguiente intento lo
			// vuelve a encontrar. Borrarla dos veces no hace nada.
			await hubDe(env, tenantId).borrarTodo();
			retirada.bases++;
			await exec(db, `UPDATE tenants SET status = 'deleted', updated_at_ms = ? WHERE tenant_id = ?;`, [
				Date.now(),
				tenantId,
			]);
			retirada.negocios++;
		} catch (e: any) {
			retirada.fallos.push({ tenantId, error: String(e?.message || e) });
		}
	}

	// Las licencias, también las que nunca se activaron. Las de un negocio que no se pudo retirar se
	// anulan igual: anular no borra nada y no tiene por qué esperar a su base.
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
