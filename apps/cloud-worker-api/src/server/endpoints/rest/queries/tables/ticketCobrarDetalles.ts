import type { Client } from "@libsql/client/web";

import { buildTenantContext } from "../../../../middleware/withTenant";
import { createDbClient } from "../../../../db/clients";
import { json, unauthorized, serverError } from "../../../../utils/response";
import {
    applyTenantHubTransaction,
    getDeviceIdFromContext,
    readWriteRequest,
    sqlRef,
    type TxStep,
} from "../../../../utils/tenantHubWrites";

type CobrarDetallesParams = {
    id_comanda: number;
    idComanda?: number;
    metodo: string;
    tipo: string;
    detalle_ids: number[];
    detalleIds?: number[];
    id_usuario?: number | null;
    idUsuario?: number | null;
    id_trabajador_cobrador?: number | null;
    idTrabajadorCobrador?: number | null;
};

const COMMAND_NAME = "ticket.cobrarDetalles";

function buildInPlaceholders(start: number, count: number): string {
    return Array.from({ length: count }, (_, i) => `?${start + i}`).join(", ");
}

function normalizeDetalleIds(raw: any): number[] {
    const arr = Array.isArray(raw) ? raw : [];

    let ids = arr
        .map((n: any) => Number(n))
        .filter((n: number) => Number.isFinite(n) && n > 0);

    ids.sort((a, b) => a - b);
    ids = ids.filter((n, i) => (i === 0 ? true : n !== ids[i - 1]));

    return ids;
}

export async function handleTicketCobrarDetalles(
    req: Request,
    env: any,
    dbCentral: Client,
): Promise<Response> {
    try {
        const ctx: any = await buildTenantContext(
            req,
            env,
            dbCentral,
            createDbClient,
        );

        const tenantId = String(ctx?.claims?.tenantId || "").trim();
        if (!tenantId) {
            return unauthorized(req, "invalid_token_claims");
        }

        const { input: body, opId } = await readWriteRequest<CobrarDetallesParams>(
            req,
            {
                id_comanda: 0,
                metodo: "Efectivo",
                tipo: "FRACCIONADO",
                detalle_ids: [],
                id_usuario: null,
                idUsuario: null,
                id_trabajador_cobrador: null,
                idTrabajadorCobrador: null,
            },
        );

        if (!opId) {
            return json({ ok: false, error: "missing_op_id" }, 400, req);
        }

        const idComanda = Number(body?.id_comanda ?? body?.idComanda ?? 0);

        const ids = normalizeDetalleIds(
            Array.isArray(body?.detalle_ids) ? body.detalle_ids : body?.detalleIds,
        );

        if (!idComanda || ids.length === 0) {
            return json({ ok: true }, 200, req);
        }

        const idUsuarioRaw = Number(body?.id_usuario ?? body?.idUsuario ?? 0);
        const idUsuario = idUsuarioRaw > 0 ? idUsuarioRaw : null;

        const idTrabajadorDirectoRaw = Number(
            body?.id_trabajador_cobrador ?? body?.idTrabajadorCobrador ?? 0,
        );
        const idTrabajadorDirecto =
            idTrabajadorDirectoRaw > 0 ? idTrabajadorDirectoRaw : null;

        const metodo = String(body?.metodo ?? "Efectivo");
        const tipo = String(body?.tipo ?? "FRACCIONADO");

        const expectedCount = ids.length;
        const inSql = buildInPlaceholders(2, ids.length);

        const steps: TxStep[] = [
            {
                kind: "value",
                saveAs: "id_trabajador_cobrador",
                sql: `
					SELECT COALESCE(
						(
							SELECT ID_Trabajador
							FROM Trabajadores
							WHERE ?1 > 0
							  AND ID_Trabajador = ?1
							LIMIT 1
						),
						(
							SELECT ID_Trabajador
							FROM Trabajadores
							WHERE ?2 > 0
							  AND ID_Usuario = ?2
							LIMIT 1
						)
					);
				`,
                args: [idTrabajadorDirecto ?? 0, idUsuario ?? 0],
            },
            {
                kind: "value",
                saveAs: "valid_count",
                sql: `
					SELECT COUNT(*)
					FROM Detalle_Comanda dc
					WHERE dc.ID_Comanda = ?1
					  AND dc.ID_Detalle IN (${inSql})
					  AND NOT EXISTS (
						SELECT 1
						FROM Pago_Detalles pd
						WHERE pd.ID_Detalle = dc.ID_Detalle
					  );
				`,
                args: [idComanda, ...ids],
            },
            {
                kind: "value",
                saveAs: "importe_total",
                sql: `
					SELECT ROUND(
						IFNULL(
							SUM(COALESCE(dc.Cantidad, 1) * COALESCE(dc.Precio_Unitario, 0)),
							0
						),
						2
					)
					FROM Detalle_Comanda dc
					WHERE dc.ID_Comanda = ?1
					  AND dc.ID_Detalle IN (${inSql})
					  AND NOT EXISTS (
						SELECT 1
						FROM Pago_Detalles pd
						WHERE pd.ID_Detalle = dc.ID_Detalle
					  );
				`,
                args: [idComanda, ...ids],
            },
            {
                kind: "execute",
                sql: `
					INSERT INTO Pagos (
						ID_Comanda,
						Fecha_Hora,
						Metodo_Pago,
						Importe_Total,
						Tipo,
						ID_Usuario_Cobrador,
						ID_Trabajador_Cobrador
					)
					SELECT
						?1,
						datetime('now','localtime'),
						?2,
						?3,
						?4,
						?5,
						?6
					WHERE COALESCE(?7, 0) = ?8;
				`,
                args: [
                    idComanda,
                    metodo,
                    sqlRef("importe_total"),
                    tipo,
                    idUsuario,
                    sqlRef("id_trabajador_cobrador"),
                    sqlRef("valid_count"),
                    expectedCount,
                ],
            },
            {
                kind: "value",
                saveAs: "id_pago",
                sql: `
					SELECT CASE
						WHEN COALESCE(?1, 0) = ?2 THEN last_insert_rowid()
						ELSE 0
					END;
				`,
                args: [sqlRef("valid_count"), expectedCount],
            },
            {
                kind: "execute",
                sql: `
					INSERT OR IGNORE INTO Pago_Detalles (ID_Pago, ID_Detalle)
					SELECT ?1, dc.ID_Detalle
					FROM Detalle_Comanda dc
					WHERE COALESCE(?1, 0) > 0
					  AND dc.ID_Comanda = ?2
					  AND dc.ID_Detalle IN (${buildInPlaceholders(3, ids.length)})
					  AND NOT EXISTS (
						SELECT 1
						FROM Pago_Detalles pd
						WHERE pd.ID_Detalle = dc.ID_Detalle
					  );
				`,
                args: [sqlRef("id_pago"), idComanda, ...ids],
            },
            {
                kind: "value",
                saveAs: "pending_left",
                sql: `
					SELECT COUNT(*)
					FROM Detalle_Comanda dc
					LEFT JOIN Pago_Detalles pd ON pd.ID_Detalle = dc.ID_Detalle
					WHERE dc.ID_Comanda = ?1
					  AND pd.ID_Detalle IS NULL;
				`,
                args: [idComanda],
            },
            {
                kind: "execute",
                sql: `
					UPDATE Comandas
					SET
						Estado = 'Pagada',
						Total_Comanda = (
							SELECT IFNULL(
								SUM(COALESCE(Cantidad, 1) * COALESCE(Precio_Unitario, 0)),
								0
							)
							FROM Detalle_Comanda
							WHERE ID_Comanda = ?1
						),
						Fecha_Hora_Cierre = datetime('now','localtime')
					WHERE ID_Comanda = ?1
					  AND COALESCE(?2, 0) = 0
					  AND COALESCE(?3, 0) > 0;
				`,
                args: [idComanda, sqlRef("pending_left"), sqlRef("id_pago")],
            },
            {
                kind: "execute",
                sql: `
					UPDATE Comandas
					SET ID_Reserva = COALESCE(
						ID_Reserva,
						(
							SELECT r.ID_Reserva
							FROM Reservas r
							WHERE r.ID_Mesa = Comandas.ID_Mesa
							  AND r.Estado = 'ACTIVA'
							ORDER BY r.ID_Reserva DESC
							LIMIT 1
						)
					)
					WHERE ID_Comanda = ?1
					  AND COALESCE(?2, 0) > 0;
				`,
                args: [idComanda, sqlRef("id_pago")],
            },
            {
                kind: "execute",
                sql: `
					UPDATE Clientes
					SET Total_Gastado = COALESCE(Total_Gastado, 0) + ?2
					WHERE ID_Cliente = (
						SELECT r.ID_Cliente
						FROM Reservas r
						JOIN Comandas c ON c.ID_Reserva = r.ID_Reserva
						WHERE c.ID_Comanda = ?1
						LIMIT 1
					)
					  AND COALESCE(?3, 0) > 0
					  AND COALESCE(?2, 0) > 0;
				`,
                args: [idComanda, sqlRef("importe_total"), sqlRef("id_pago")],
            },
            {
                kind: "row",
                saveAs: "result",
                sql: `
					SELECT
						?1 AS idPago,
						?2 AS total;
				`,
                args: [sqlRef("id_pago"), sqlRef("importe_total")],
            },
        ];

        const result = await applyTenantHubTransaction<any>({
            env,
            tenantId,
            opId,
            commandName: COMMAND_NAME,
            deviceId: getDeviceIdFromContext(ctx),
            beginMode: "immediate",
            steps,
            resultKey: "result",
        });

        const idPago = Number(result?.idPago ?? result?.id_pago ?? 0);
        const total = Math.round(Number(result?.total ?? 0) * 100) / 100;

        if (!idPago) {
            return json(
                {
                    ok: false,
                    error:
                        "Algunos detalles no existen, no pertenecen a la comanda o ya están pagados.",
                },
                409,
                req,
            );
        }

        return json({ ok: true, idPago, total }, 200, req);
    } catch (e: any) {
        return serverError(req, "internal_error", String(e?.message || e));
    }
}