import type { Client } from "@libsql/client/web";

import { buildTenantContext } from "../../../../middleware/withTenant";
import { createDbClient } from "../../../../db/clients";
import { json, unauthorized, serverError } from "../../../../utils/response";
import {
    applyTenantHubTransaction,
    getDeviceIdFromContext,
    getTenantIdFromContext,
    readWriteRequest,
    sqlRef,
} from "../../../../utils/tenantHubWrites";

const COMMAND_NAME = "ticket.removeOnePending";
const COMMAND_ALIASES = [
    COMMAND_NAME,
    "tables.ticketRemoveOnePendingDetalle",
    "ticket_remove_one_pending",
];

function s(v: unknown): string {
    return String(v ?? "").trim();
}

function validateCommandName(req: Request): Response | null {
    const raw = s(req.headers.get("X-Command-Name"));
    if (!raw) return null;

    if (!COMMAND_ALIASES.includes(raw)) {
        return json(
            {
                ok: false,
                error: "bad_command_name",
                expected: COMMAND_NAME,
                got: raw,
            },
            409,
            req,
        );
    }

    return null;
}

export async function handleTicketRemoveOnePendingDetalle(
    req: Request,
    env: any,
    dbCentral: Client,
): Promise<Response> {
    try {
        const commandError = validateCommandName(req);
        if (commandError) return commandError;

        const ctx: any = await buildTenantContext(
            req,
            env,
            dbCentral,
            createDbClient,
        );

        const tenantId = getTenantIdFromContext(ctx);
        if (!tenantId) {
            return unauthorized(req, "invalid_token_claims");
        }

        const { input: body, opId } = await readWriteRequest<any>(req, {
            id_comanda: 0,
            idComanda: 0,
            id_producto: 0,
            idProducto: 0,
        });

        if (!opId) {
            return json({ ok: false, error: "missing_op_id" }, 400, req);
        }

        const idComanda = Number(body?.id_comanda ?? body?.idComanda ?? 0);
        const idProducto = Number(body?.id_producto ?? body?.idProducto ?? 0);

        if (!Number.isFinite(idComanda) || idComanda <= 0) {
            return json({ ok: true, result: "OK", data: "OK" }, 200, req);
        }

        if (!Number.isFinite(idProducto) || idProducto <= 0) {
            return json({ ok: true, result: "OK", data: "OK" }, 200, req);
        }

        await applyTenantHubTransaction<number>({
            env,
            tenantId,
            opId,
            commandName: COMMAND_NAME,
            deviceId: getDeviceIdFromContext(ctx),
            beginMode: "immediate",
            steps: [
                {
                    kind: "value",
                    saveAs: "id_detalle_to_delete",
                    sql: `
                        SELECT dc.ID_Detalle
                        FROM Detalle_Comanda dc
                        WHERE dc.ID_Comanda = ?1
                          AND dc.ID_Producto = ?2
                          AND NOT EXISTS (
                            SELECT 1
                            FROM Pago_Detalles pd
                            WHERE pd.ID_Detalle = dc.ID_Detalle
                          )
                        ORDER BY dc.ID_Detalle DESC
                        LIMIT 1;
                    `,
                    args: [idComanda, idProducto],
                },
                {
                    kind: "execute",
                    sql: `
                        DELETE FROM Detalle_Comanda
                        WHERE ID_Detalle = ?1;
                    `,
                    args: [sqlRef("id_detalle_to_delete")],
                },
                {
                    kind: "execute",
                    sql: `
                        UPDATE Comandas
                        SET Total_Comanda = (
                            SELECT IFNULL(
                                SUM(COALESCE(Cantidad, 1) * COALESCE(Precio_Unitario, 0)),
                                0
                            )
                            FROM Detalle_Comanda
                            WHERE ID_Comanda = ?1
                        )
                        WHERE ID_Comanda = ?1;
                    `,
                    args: [idComanda],
                },
                {
                    kind: "value",
                    saveAs: "ok_value",
                    sql: `SELECT 1;`,
                    args: [],
                },
            ],
            resultKey: "ok_value",
        });

        return json({ ok: true, result: "OK", data: "OK" }, 200, req);
    } catch (e: any) {
        return serverError(req, "internal_error", {
            message: String(e?.message || e),
            name: e?.name,
            stack: e?.stack,
        });
    }
}