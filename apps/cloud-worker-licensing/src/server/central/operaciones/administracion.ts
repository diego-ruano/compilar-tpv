// src/server/central/operaciones/administracion.ts
//
// Lo que la administración hace a mano con una licencia (`domains/admin/admin.routes.ts`): anularla,
// deshacer la anulación, sumarle meses y restárselos. Lo que se comprueba antes (que exista, que esté
// anulada) y lo que se hace después (la auditoría, el aviso al `TenantHub`) lo hace la ruta.

import type { SqlSync } from "../../../lib/sql";
import { DISPUTA_SIN_REVOCAR, extendLicense, reactivateLicense, revokeLicense, shortenLicense } from "./licencias";

type DatosDeLaLicencia = { licenseId: string; ahoraMs: number };
type DatosDeLosMeses = { licenseId: string; meses: number; ahoraMs: number };

/**
 * Anula la licencia. AUD-08: la revocación es del operador aunque una disputa abierta ya hubiera
 * revocado el alta. Su cobro deja de figurar como revocado por la disputa, y ganarla ya no la
 * resucita.
 */
export function revocarAMano(sql: SqlSync, { licenseId, ahoraMs }: DatosDeLaLicencia): null {
	revokeLicense(sql, licenseId, ahoraMs);
	atribuirRevocacionAMano(sql, licenseId);
	return null;
}

/**
 * Deshace la anulación (`reactivateLicense` decide a qué estado vuelve). AUD-45: le quita además al
 * alta la marca de una disputa, para que un reembolso total posterior la vuelva a revocar. Las
 * renovaciones conservan la suya.
 */
export function desrevocar(sql: SqlSync, { licenseId, ahoraMs }: DatosDeLaLicencia): null {
	reactivateLicense(sql, licenseId, ahoraMs);
	quitarMarcasDeDisputa(sql, licenseId);
	return null;
}

/** Suma meses a la caducidad (`extendLicense`) y devuelve la nueva. */
export function extenderAMano(sql: SqlSync, { licenseId, meses, ahoraMs }: DatosDeLosMeses): number {
	return extendLicense(sql, licenseId, meses, ahoraMs);
}

/** Resta meses a la caducidad (`shortenLicense`) y devuelve la nueva, o `null` si no la tiene. */
export function acortarAMano(sql: SqlSync, { licenseId, meses, ahoraMs }: DatosDeLosMeses): number | null {
	return shortenLicense(sql, licenseId, meses, ahoraMs);
}

/**
 * AUD-08 · Revocar a mano una licencia cuya alta había revocado una disputa que sigue abierta hace
 * suya la revocación: el cobro deja de figurar como revocado por la disputa, y ganarla ya no
 * resucita la licencia.
 *
 * Sólo las altas: una renovación disputada no revoca nada (resta meses), y devolvérselos al
 * ganarla no reactiva una licencia revocada (`extendLicense` no toca `status = 'revoked'`).
 */
function atribuirRevocacionAMano(sql: SqlSync, licenseId: string): void {
	sql.execute({
		sql: `
    UPDATE license_payments SET reversed_reason = ?
    WHERE license_id = ? AND kind = 'issue' AND reversed_reason = 'dispute';
    `,
		args: [DISPUTA_SIN_REVOCAR, licenseId],
	});
}

/**
 * AUD-45 · Desrevocar a mano deshace también la marca de disputa del alta (`dispute` o
 * `dispute_ya_revocada`). Si no, el cobro seguía figurando como revertido y un reembolso total
 * posterior del mismo cargo se quedaba en `already_reversed` sin revocar nada; es lo que pasaba
 * al reparar una licencia que había revocado una consulta del banco.
 *
 * Sólo las altas, como `atribuirRevocacionAMano`: desrevocar no devuelve los meses que una disputa
 * le restó a una renovación, así que quitarle la marca dejaría que otro reembolso o disputa del
 * mismo cargo se los restara otra vez, y que ganarla no se los devolviera. Las marcas `refund`
 * tampoco: un reembolso total no se repite.
 *
 * Una disputa formal que siga abierta vuelve a revertir el alta si se pierde (`closed lost`): el
 * dinero se ha ido. Ganarla ya no tiene nada que deshacer.
 */
function quitarMarcasDeDisputa(sql: SqlSync, licenseId: string): void {
	sql.execute({
		sql: `
    UPDATE license_payments
    SET reversed_at_ms = NULL, reversed_reason = NULL, reversed_event_uid = NULL
    WHERE license_id = ? AND kind = 'issue' AND reversed_reason IN ('dispute', ?);
    `,
		args: [licenseId, DISPUTA_SIN_REVOCAR],
	});
}
