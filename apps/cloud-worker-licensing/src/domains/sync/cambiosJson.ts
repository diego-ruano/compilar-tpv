import { HubError } from "../../lib/errorHttp";

export type CambioGuardado = {
	Seq: unknown; Op_Id: unknown; Command_Name: unknown; Device_Id: unknown;
	Created_At_Ms: unknown; Statements_Json: unknown; Statements_Type: unknown;
};

/** RI-44: SQLite valida el fragmento; sólo serializamos metadatos, nunca las sentencias. */
export function serializarCambios(rows: CambioGuardado[], since: number, highWater: number): string {
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
	return `{"ok":true,"items":[${items.join(",")}],"nextSince":${JSON.stringify(nextSince)},"highWater":${JSON.stringify(highWater)}}`;
}
