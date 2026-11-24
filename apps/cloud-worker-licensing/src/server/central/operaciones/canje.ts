// src/server/central/operaciones/canje.ts
//
// REV-13 · El canje de una clave sin estrenar: su tiempo se suma a la licencia viva de la que el
// equipo que la teclea es la Main (`/v1/license/activate`, `domains/licensing/licensing.routes.ts`).
//
// Gastar la clave, sumar sus meses y mudar su cobro van juntos o no van (REV-01): con sentencias
// sueltas, un corte a mitad dejaba la clave gastada sin haber sumado nada. Y en este orden: si el
// canje no gana la carrera, no se ha sumado nada. Lo que la respuesta necesita y puede fallar sin
// escribir nada (la DEK, el token) lo prepara la ruta antes.

import type { SqlSync } from "../../../lib/sql";
import { extendLicense } from "./licencias";

type DatosDelCanje = {
	/** La clave que se gasta. */
	claveId: string;
	/** La licencia viva que recibe su tiempo, la que la ruta eligió para este equipo. */
	licenciaId: string;
	/** El equipo que la teclea: la Main de `licenciaId`. */
	deviceId: string;
	/** Los meses de la clave. */
	meses: number;
	ahoraMs: number;
};

type ResultadoDelCanje =
	| { resultado: "sumado"; expiresAtMs: number }
	/** La licencia ya no es la viva de ese equipo: la clave no se ha gastado. */
	| { resultado: "sin_licencia" }
	/** Otra petición la ha canjeado antes. */
	| { resultado: "usada" };

export function canjearClave(sql: SqlSync, d: DatosDelCanje): ResultadoDelCanje {
	// AUD-01: la licencia se eligió fuera de la operación. Si entretanto se ha anulado o se ha
	// trasladado a otro equipo, la clave no se gasta sobre ella.
	if (!sigueSiendoLaLicenciaDelEquipo(sql, d.licenciaId, d.deviceId)) return { resultado: "sin_licencia" };
	if (!canjearLicencia(sql, d.claveId, d.licenciaId, d.ahoraMs)) return { resultado: "usada" };
	const expiresAtMs = extendLicense(sql, d.licenciaId, d.meses, d.ahoraMs);
	// LIC-07: el cobro se muda con el tiempo, o un reembolso no tendría de dónde restar.
	reasignarCobrosDeLaClave(sql, d.claveId, d.licenciaId);
	return { resultado: "sumado", expiresAtMs };
}

/**
 * ¿Sigue siendo ésta la licencia viva de la que ese equipo es la Main? Entre que la ruta elige la
 * licencia y gasta la clave, la licencia se puede haber anulado o trasladado a otro equipo, y sumarle
 * tiempo entonces sería gastar la clave sobre una licencia que ya no es de quien la teclea (AUD-01).
 */
function sigueSiendoLaLicenciaDelEquipo(sql: SqlSync, licenseId: string, deviceId: string): boolean {
	const r = sql.execute({
		sql: `
    SELECT 1 AS viva FROM licenses
    WHERE license_id = ?
      AND main_device_id = ?
      AND disabled = 0
      AND status IN ('active', 'expired')
    LIMIT 1;
    `,
		args: [licenseId, deviceId],
	});
	return r.rows.length > 0;
}

/**
 * Gasta una clave **sin estrenar** sobre otra licencia, y dice si ha sido esta llamada la que la
 * ha gastado (REV-13).
 *
 * El `WHERE` es la mitad importante: sólo se canjea lo que sigue `issued` y sin equipo. Una
 * licencia **ya activada no suma tiempo** —decisión de producto: si lo que quieres es mover una
 * licencia a otro local, eso es un cambio de equipo y va por su propia pantalla, reciclando la que
 * hay en vez de creando otra—. Y mirar `rowsAffected` es la lección de REV-15: una condición de
 * carrera que nadie comprueba no es una condición de carrera, y aquí dos intentos a la vez
 * sumarían el doble de meses.
 *
 * AUD-09: la clave canjeada suelta el negocio que tuviera reservado (`reservarNegocioDeLaClave`):
 * ya no va a nacer, y una clave canjeada no lleva negocio. Si una activación lo llegó a crear, se
 * queda sin licencia que lo apunte, que es lo que busca la retirada de negocios huérfanos
 * (`domains/admin/huerfanos.ts`).
 */
function canjearLicencia(sql: SqlSync, claveId: string, sobreLicenciaId: string, ahoraMs: number): boolean {
	const r = sql.execute({
		sql: `UPDATE licenses
        SET status = 'redeemed',
            redeemed_into_license_id = ?,
            tenant_id = NULL,
            updated_at_ms = ?
      WHERE license_id = ?
        AND status = 'issued'
        AND main_device_id IS NULL
        AND disabled = 0;`,
		args: [sobreLicenciaId, ahoraMs, claveId],
	});
	return r.rowsAffected > 0;
}

/**
 * Pasa el cobro de una clave canjeada a la licencia que recibió su tiempo, como renovación.
 *
 * Sin esto, un reembolso de esa compra no quitaría nada: `localizarCobros` (LIC-07, `cobros.ts`)
 * llega al cobro por el `payment_intent`, y ese cobro seguiría apuntando a la clave gastada —que ya
 * no tiene meses que quitar— en vez de a la licencia donde de verdad fueron a parar. Se **mueve** en
 * vez de insertar otro porque `license_payments` tiene índice único por sesión y unidad: otra fila
 * con la misma es justo lo que esa barrera impide.
 */
function reasignarCobrosDeLaClave(sql: SqlSync, claveId: string, aLicenciaId: string): void {
	sql.execute({
		sql: `UPDATE license_payments SET license_id = ?, kind = 'renewal' WHERE license_id = ?;`,
		args: [aLicenciaId, claveId],
	});
}
