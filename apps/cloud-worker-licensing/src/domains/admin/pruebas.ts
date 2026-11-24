// src/domains/admin/pruebas.ts
//
// Los negocios que deja el E2E. Cada tanda emite una licencia de pruebas y la activa, y activarla
// crea su base en el TenantHub del negocio. Al acabar, esto las retira para que no se acumulen en el
// panel: anula sus licencias, borra todo lo que el negocio guarda en la nube (su base, su agenda de
// reservas web y sus imágenes) y lo da por borrado.
//
// Sólo toca lo emitido como de pruebas (`origin = 'pruebas'`) y lo que el E2E emitía antes de que
// existiera esa marca: licencias manuales con su correo, que es de un dominio `.test` y no puede
// ser de nadie. Un negocio que tenga además cualquier otra licencia no se toca nunca, y tampoco uno
// al que se le haya canjeado una clave que no sea de pruebas.

import type { Base } from "../../lib/sql";

import type { Env } from "../../env";
import { agendaDe } from "../../durableObjects/agendaWeb";
import { exec } from "../../server/db";
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
 * Se lleva también el PDF de sus facturas (`{tenantId}/facturas/`), que ninguna ruta borra: es un
 * negocio de pruebas, y retirarlo es no dejar nada suyo en la nube.
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
	db: Base,
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

	// Las licencias se anulan ANTES de borrar nada, y es lo que cierra la puerta. Una clave de verdad
	// se canjea sobre la licencia viva de la Main del negocio, y el canje lo comprueba dentro de su
	// transacción (`sigueSiendoLaLicenciaDelEquipo`, AUD-01). Esta sentencia anula, de una vez, las
	// de los negocios que en ese instante son sólo de pruebas: un canje que entró antes deja a su
	// negocio fuera de ella, con su licencia viva, y uno que llegue después ya no tiene licencia a la
	// que sumar y no gasta la clave. Anulando al final, entre volver a mirar un negocio y borrarlo
	// cabía un canje, y el negocio se quedaba con tiempo pagado y sin sus datos.
	//
	// También las que nunca se activaron, y las de un negocio que luego no se pueda retirar: anular no
	// borra nada y no tiene por qué esperar a su base.
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
	retirada.licencias = anuladas.rowsAffected;

	for (const fila of filas.slice(0, NEGOCIOS_POR_LLAMADA)) {
		const tenantId = String(fila.tenant_id);
		try {
			// Lo que viene ahora no se deshace, así que se vuelve a mirar: entre la lista de arriba y
			// la anulación pudo canjearse sobre él una clave que no es de pruebas, o emitirse para él
			// una licencia de verdad. Con sus licencias ya anuladas, lo que se ve aquí no lo cambia
			// un canje.
			//
			// Y sólo se borra si TODAS sus licencias siguen anuladas. Desanular una desde
			// administración (`/unrevoke`) mientras se retira le devuelve una licencia viva sobre la
			// que sí cabe un canje: ese negocio se deja como está, y la siguiente llamada vuelve a
			// anular y a mirar. Entre esta lectura y el borrado de abajo no queda nada que lo sujete:
			// desanular una licencia de pruebas justo ahí es cosa de quien administra.
			const sigue = await exec(
				db,
				`SELECT 1 AS si WHERE EXISTS (SELECT 1 FROM licenses l WHERE l.tenant_id = ?2 AND ${dePruebas("l")})
				    AND ${soloDePruebas("?2")}
				    AND NOT EXISTS (SELECT 1 FROM licenses v WHERE v.tenant_id = ?2 AND v.status <> 'revoked');`,
				[CORREO_DE_PRUEBAS, tenantId],
			);
			if (!sigue.rows.length) continue;

			// La base primero: si algo falla, el negocio se queda como estaba y el siguiente intento lo
			// vuelve a encontrar. Borrar dos veces cualquiera de las tres cosas no hace nada.
			await hubDe(env, tenantId).borrarTodo();
			retirada.bases++;
			await agendaDe(env, tenantId).borrarTodo();
			retirada.imagenes += await borrarImagenesDelNegocio(env.IMAGES, tenantId);
			// Con su fila aunque no la tenga: una clave sin estrenar lleva el negocio que le reservó una
			// activación (AUD-09), y si ésta se cortó antes de crearlo, sin fila `deleted` volvería a
			// salir en cada llamada.
			const ahora = Date.now();
			await exec(
				db,
				`INSERT INTO tenants (tenant_id, status, created_at_ms, updated_at_ms) VALUES (?, 'deleted', ?, ?)
				 ON CONFLICT(tenant_id) DO UPDATE SET status = 'deleted', updated_at_ms = excluded.updated_at_ms;`,
				[tenantId, ahora, ahora],
			);
			retirada.negocios++;
		} catch (e: any) {
			retirada.fallos.push({ tenantId, error: String(e?.message || e) });
		}
	}

	return retirada;
}
