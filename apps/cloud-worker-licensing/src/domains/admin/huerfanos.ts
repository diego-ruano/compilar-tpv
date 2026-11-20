// src/domains/admin/huerfanos.ts
//
// AUD-09 · Los negocios que ninguna licencia apunta.
//
// La primera activación crea el negocio y su base en el TenantHub ANTES de apuntar la licencia (la
// base va antes, DO-PERDIDA). Hasta AUD-09 cada petición estrenaba su propio negocio, así que una
// ráfaga de activaciones de la misma clave, o cada reintento tras un fallo, dejaba negocios con su
// base aprovisionada que la licencia no apuntaba: sólo uno ganaba. Ahora el negocio se reserva en la
// licencia antes de crear nada (`reservarNegocioDeLaClave`) y ya no salen así, pero los que quedaron
// siguen ahí, y uno nuevo puede quedar todavía si la clave reservada se canjea sobre otra licencia
// (el canje suelta la reserva) después de que una activación cortada creara el negocio.
//
// Esto los encuentra y, si se le pide expresamente (`borrar`), vacía su TenantHub y los da por
// borrados. **Por defecto sólo los lista.**
//
// Huérfano es: sin retirar (`status <> 'deleted'`) y sin NINGUNA licencia que lo apunte, esté como
// esté. Lo que no atrapa:
//
// - el negocio de una licencia, viva, caducada, anulada o trasladada a otro equipo (un traslado
//   conserva el negocio);
// - el que una clave sin estrenar tiene reservado: ahí nacerá cuando se active, y ya puede tener su
//   base de un intento anterior;
// - los del E2E: llevan su licencia de pruebas hasta que `pruebas.ts` los retira;
// - uno recién creado (`MARGEN_MS`): es lo que deja, mientras dura, una activación en curso que haya
//   empezado antes de este arreglo, o la de una clave que se esté canjeando a la vez.
//
// Ningún otro camino crea negocios (sólo `/v1/license/activate`), así que un negocio sin licencia
// sólo sale de una activación que no la ganó, o de que alguien borrase a mano en la base central la
// licencia de uno de verdad. Lo segundo es justo lo que el listado previo tiene que dejar ver antes
// de borrar: por eso lleva cuántos equipos tiene apuntados cada uno.
//
// Sólo se vacía su TenantHub: la agenda de reservas web y las imágenes son de un negocio con una
// Main que haya entrado con token, y un negocio sin licencia no ha tenido nunca ninguna.

import type { Client } from "@libsql/client/web";

import { exec, rowsAffected } from "../../server/db";
import { hubDe, type EntornoDelHub } from "../../lib/hub";

/**
 * Cuántos negocios vacía una llamada. Cada uno son tres peticiones salientes (volver a mirarlo, su
 * TenantHub y darlo por borrado) y un Worker tiene un tope por llamada (50 en el plan gratuito). Lo
 * que no cabe sale en `quedan`.
 */
const HUERFANOS_POR_LLAMADA = 12;

/** Lo que tiene que haber pasado desde que se creó un negocio para tomarlo por huérfano: un día. */
export const MARGEN_MS = 24 * 60 * 60 * 1000;

/** Un negocio sin licencia que lo apunte, sin retirar y creado hace más de `MARGEN_MS`. */
const ES_HUERFANO = `
	t.status <> 'deleted'
	AND t.created_at_ms <= ?1
	AND NOT EXISTS (SELECT 1 FROM licenses l WHERE l.tenant_id = t.tenant_id)`;

type Huerfano = {
	tenantId: string;
	creadoEn: string;
	/** Filas de `devices` que apuntan a él (las de los equipos que perdieron la carrera). */
	equipos: number;
};

type RetiradaDeHuerfanos = {
	/** Si esta llamada ha borrado o sólo ha listado. */
	borrar: boolean;
	/** Los encontrados en esta llamada (como mucho `HUERFANOS_POR_LLAMADA`). */
	huerfanos: Huerfano[];
	/** Cuántos se han vaciado y dado por borrados. Con `borrar: false`, 0. */
	retirados: number;
	/** Los que no se pudieron retirar; se quedan como estaban para el siguiente intento. */
	fallos: { tenantId: string; error: string }[];
	/** Si hay más de los que caben en una llamada. */
	quedan: boolean;
};

/**
 * Lista los negocios huérfanos y, con `borrar`, los retira. Repetirlo no hace nada: lo retirado no
 * vuelve a salir, y lo que falló se reintenta.
 */
export async function retirarNegociosHuerfanos(
	db: Client,
	env: EntornoDelHub,
	opciones: { borrar: boolean; ahoraMs: number },
): Promise<RetiradaDeHuerfanos> {
	const creadoAntesDe = opciones.ahoraMs - MARGEN_MS;
	const r = await exec(
		db,
		`SELECT t.tenant_id AS tenant_id, t.created_at_ms AS created_at_ms,
		        (SELECT COUNT(*) FROM devices d WHERE d.tenant_id = t.tenant_id) AS equipos
		   FROM tenants t
		  WHERE ${ES_HUERFANO}
		  ORDER BY t.created_at_ms, t.tenant_id
		  LIMIT ?2;`,
		[creadoAntesDe, HUERFANOS_POR_LLAMADA + 1],
	);
	const filas = (r.rows ?? []) as any[];
	const huerfanos: Huerfano[] = filas.slice(0, HUERFANOS_POR_LLAMADA).map((f) => ({
		tenantId: String(f.tenant_id),
		creadoEn: new Date(Number(f.created_at_ms)).toISOString(),
		equipos: Number(f.equipos ?? 0),
	}));
	const retirada: RetiradaDeHuerfanos = {
		borrar: opciones.borrar,
		huerfanos,
		retirados: 0,
		fallos: [],
		quedan: filas.length > HUERFANOS_POR_LLAMADA,
	};
	if (!opciones.borrar) return retirada;

	for (const { tenantId } of huerfanos) {
		try {
			// Lo que viene ahora no se deshace, así que se vuelve a mirar justo antes. Una licencia no
			// empieza a apuntar a un negocio que ya existe (una reserva estrena siempre uno), pero
			// mirarlo cuesta una lectura y borrar el de otro no tiene vuelta.
			const sigue = await exec(
				db,
				`SELECT 1 AS si FROM tenants t WHERE t.tenant_id = ?2 AND ${ES_HUERFANO} LIMIT 1;`,
				[creadoAntesDe, tenantId],
			);
			if (!sigue.rows.length) continue;

			// La base primero: si falla, el negocio se queda como estaba y la siguiente llamada lo
			// vuelve a encontrar. Vaciarla dos veces no hace nada.
			await hubDe(env, tenantId).borrarTodo();
			const marcado = await exec(
				db,
				`UPDATE tenants AS t SET status = 'deleted', updated_at_ms = ?3 WHERE t.tenant_id = ?2 AND ${ES_HUERFANO};`,
				[creadoAntesDe, tenantId, opciones.ahoraMs],
			);
			if (rowsAffected(marcado) > 0) retirada.retirados++;
		} catch (e: any) {
			retirada.fallos.push({ tenantId, error: String(e?.message || e) });
		}
	}
	return retirada;
}
