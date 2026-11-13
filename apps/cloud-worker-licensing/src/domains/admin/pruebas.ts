// src/domains/admin/pruebas.ts
//
// Los negocios que deja el E2E. Cada tanda emite una licencia de pruebas y la activa, y activarla
// crea su base en el TenantHub del negocio. Al acabar, esto las retira para que no se acumulen en el
// panel: borra todo lo que el negocio guarda en la nube (su base, su agenda de reservas web y sus
// imágenes), lo da por borrado y anula la licencia.
//
// Sólo toca lo emitido como de pruebas (`origin = 'pruebas'`) y lo que el E2E emitía antes de que
// existiera esa marca: licencias manuales con su correo, que es de un dominio `.test` y no puede
// ser de nadie. Un negocio que tenga además cualquier otra licencia no se toca nunca, y tampoco uno
// al que se le haya canjeado una clave que no sea de pruebas.

import type { Client } from "@libsql/client/web";

import type { Env } from "../../env";
import { agendaDe } from "../../durableObjects/agendaWeb";
import { exec, rowsAffected } from "../../server/db";
import { hubDe, type EntornoDelHub } from "../../lib/hub";
import { prefijoDelNegocio } from "../images/images.routes";

/** El correo con el que el E2E emite sus licencias (`apps/tpv-main/e2e/helpers/licencias.ts`). */
export const CORREO_DE_PRUEBAS = "e2e@altarialights.test";

/** ¿Es de pruebas la licencia `alias`? El correo va en `?1`. */
function dePruebas(alias: string): string {
	return `(${alias}.origin = 'pruebas' OR (${alias}.origin = 'manual' AND ${alias}.customer_email = ?1))`;
}

/**
 * Cuántos negocios retira una llamada. Cada uno son varias peticiones salientes (volver a mirar sus
 * licencias, su TenantHub, su agenda, listar y borrar sus imágenes, y darlo por borrado), y un
 * Worker tiene un tope de peticiones por llamada (50 en el plan gratuito): sin techo, una purga
 * grande se quedaba a medias con «Too many subrequests». Lo que no cabe sale en `quedan`.
 */
export const NEGOCIOS_POR_LLAMADA = 7;

/**
 * Un negocio de pruebas: todas sus licencias lo son, y ninguna clave que no lo sea se ha canjeado
 * sobre una de ellas. Una clave canjeada no lleva negocio (`tenant_id` nulo): le suma su tiempo a la
 * licencia que apunta (REV-13), así que hay que seguirla hasta el negocio de ésa.
 */
function soloDePruebas(negocio: string): string {
	return `(
	NOT EXISTS (
		SELECT 1 FROM licenses o WHERE o.tenant_id = ${negocio} AND NOT ${dePruebas("o")}
	) AND NOT EXISTS (
		SELECT 1 FROM licenses c JOIN licenses d ON d.license_id = c.redeemed_into_license_id
		 WHERE d.tenant_id = ${negocio} AND NOT ${dePruebas("c")}
	)
)`;
}

export type Retirada = {
	/** Negocios dados por borrados. */
	negocios: number;
	/** Bases borradas (la de cada negocio retirado, en su TenantHub). */
	bases: number;
	/** Imágenes borradas del bucket, de los negocios retirados. */
	imagenes: number;
	/** Licencias de pruebas anuladas. */
	licencias: number;
	/** Los negocios que no se pudieron retirar; se quedan como estaban para el siguiente intento. */
	fallos: { tenantId: string; error: string }[];
	/** Si quedan más negocios por retirar que los de esta llamada. */
	quedan: boolean;
};

/** Lo que hace falta del entorno para retirar un negocio: sus dos objetos y el bucket de imágenes. */
export type EntornoDeRetirada = EntornoDelHub & Pick<Env, "AgendaWeb" | "IMAGES">;

/**
 * Borra las imágenes de un negocio: todo lo que cuelga de su carpeta en el bucket
 * (`{tenantId}/…`, ver `images.routes.ts`). Devuelve cuántas.
 *
 * La carpeta acaba en `/`, así que la de un negocio no es el principio de la de otro. Un id vacío o
 * con una barra no nombra una carpeta de negocio: no se borra nada.
 */
export async function borrarImagenesDelNegocio(bucket: R2Bucket, tenantId: string): Promise<number> {
	if (!tenantId || tenantId.includes("/")) throw new Error("tenant_id_invalido");
	const prefix = prefijoDelNegocio(tenantId);
	let borradas = 0;
	let cursor: string | undefined;
	do {
		const pagina = await bucket.list({ prefix, cursor, limit: 1000 });
		const claves = pagina.objects.map((o) => o.key);
		if (claves.length) {
			await bucket.delete(claves);
			borradas += claves.length;
		}
		cursor = pagina.truncated ? pagina.cursor : undefined;
	} while (cursor);
	return borradas;
}

/**
 * Retira los negocios de pruebas que queden, `NEGOCIOS_POR_LLAMADA` como mucho. Repetirlo no hace
 * nada: lo ya retirado no vuelve a salir, y lo que falló se reintenta.
 */
export async function retirarNegociosDePrueba(
	db: Client,
	env: EntornoDeRetirada,
): Promise<Retirada> {
	const retirada: Retirada = { negocios: 0, bases: 0, imagenes: 0, licencias: 0, fallos: [], quedan: false };

	const pendientes = await exec(
		db,
		`SELECT DISTINCT l.tenant_id AS tenant_id
		   FROM licenses l
		   LEFT JOIN tenants t ON t.tenant_id = l.tenant_id
		  WHERE l.tenant_id IS NOT NULL AND ${dePruebas("l")} AND ${soloDePruebas("l.tenant_id")}
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
			// Lo que viene ahora no se deshace, así que se vuelve a mirar justo antes: entre la lista de
			// arriba y este negocio pudo activarse o canjearse sobre él una licencia que no es de pruebas.
			const sigue = await exec(
				db,
				`SELECT 1 AS si WHERE EXISTS (SELECT 1 FROM licenses l WHERE l.tenant_id = ?2 AND ${dePruebas("l")})
				    AND ${soloDePruebas("?2")};`,
				[CORREO_DE_PRUEBAS, tenantId],
			);
			if (!sigue.rows.length) continue;

			// La base primero: si algo falla, el negocio se queda como estaba y el siguiente intento lo
			// vuelve a encontrar. Borrar dos veces cualquiera de las tres cosas no hace nada.
			await hubDe(env, tenantId).borrarTodo();
			retirada.bases++;
			await agendaDe(env, tenantId).borrarTodo();
			retirada.imagenes += await borrarImagenesDelNegocio(env.IMAGES, tenantId);
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
		       AND (l.tenant_id IS NULL OR ${soloDePruebas("l.tenant_id")})
		  );`,
		[CORREO_DE_PRUEBAS, Date.now()],
	);
	retirada.licencias = rowsAffected(anuladas);

	return retirada;
}
