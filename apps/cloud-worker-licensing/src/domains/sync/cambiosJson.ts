import { HubError } from "../../lib/errorHttp";

export type CambioGuardado = {
	Seq: unknown; Op_Id: unknown; Command_Name: unknown; Device_Id: unknown;
	Created_At_Ms: unknown; Statements_Json: unknown; Statements_Type: unknown;
};

/**
 * AUD-19 · Clave reservada de `Sync_Main_Checkpoints` donde la purga del log anota el mayor `Seq`
 * que ha borrado, en la misma transacción que el `DELETE`. No es un dispositivo (los suyos son
 * UUID): el suelo de la purga la excluye, y `/v1/sync/changes` la devuelve como `purgadoHasta`.
 */
export const PURGADO_HASTA = "_purgado_hasta";

/**
 * RI-44: SQLite valida el fragmento; sólo serializamos metadatos, nunca las sentencias.
 *
 * AUD-19: `purgadoHasta` es el mayor `Seq` que la purga ha borrado (0 si nunca ha borrado nada). A
 * una Main con el checkpoint por debajo le falta lo que hubiera entre su checkpoint y ese `Seq`, y
 * no puede deducirlo de los items: `Seq` no es contiguo y la purga, que mira también la antigüedad,
 * no siempre quita un prefijo.
 */
export function serializarCambios(rows: CambioGuardado[], since: number, highWater: number, purgadoHasta: number): string {
	const items = rows.map((row) => {
		if (row.Statements_Type !== "array" || typeof row.Statements_Json !== "string") {
			throw new HubError("sync_log_corrupto", 500);
		}
		const metadata = JSON.stringify({
			seq: Number(row.Seq), opId: String(row.Op_Id), command: String(row.Command_Name),
			deviceId: row.Device_Id ? String(row.Device_Id) : null, createdAtMs: Number(row.Created_At_Ms),
		});
		return `${metadata.slice(0, -1)},"statements":${row.Statements_Json}}`;
	});
	const nextSince = rows.length ? Number(rows[rows.length - 1].Seq) : since;
	return `{"ok":true,"items":[${items.join(",")}],"nextSince":${JSON.stringify(nextSince)},"highWater":${JSON.stringify(highWater)},"purgadoHasta":${JSON.stringify(purgadoHasta)}}`;
}
