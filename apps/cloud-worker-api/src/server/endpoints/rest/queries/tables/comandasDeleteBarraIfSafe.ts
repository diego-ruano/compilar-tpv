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

const COMMAND_NAME = "comandas.deleteBarraIfSafe";
const COMMAND_ALIASES = [
    COMMAND_NAME,
    "tables.comandasDeleteBarraIfSafe",
    "comandas_delete_barra_if_safe",
];

function s(v: unknown): string {
    return String(v ?? "").trim();
}

function asNumber(v: any, fallback = 0): number {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
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

export async function handleComandasDeleteBarraIfSafe(
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
        });

        if (!opId) {
            return json({ ok: false, error: "missing_op_id" }, 400, req);
        }

        const idComanda = Number(body?.id_comanda ?? body?.idComanda ?? 0);
        if (!Number.isFinite(idComanda) || idComanda <= 0) {
            return json(false, 200, req);
        }

        const okValue = await applyTenantHubTransaction<number>({
            env,
            tenantId,
            opId,
            commandName: COMMAND_NAME,
            deviceId: getDeviceIdFromContext(ctx),
            beginMode: "immediate",
            steps: [
                {
                    kind: "value",
                    saveAs: "has_paid",
                    sql: `
                        SELECT CASE
                            WHEN EXISTS (
                                SELECT 1
                                FROM Detalle_Comanda dc
                                JOIN Pago_Detalles pd
                                  ON pd.ID_Detalle = dc.ID_Detalle
                                WHERE dc.ID_Comanda = ?1
                                LIMIT 1
                            )
                            THEN 1
                            ELSE 0
                        END;
                    `,
                    args: [idComanda],
                },
                {
                    kind: "execute",
                    sql: `
                        DELETE FROM Detalle_Comanda
                        WHERE ID_Comanda = ?1
                          AND COALESCE(?2, 0) = 0;
                    `,
                    args: [idComanda, sqlRef("has_paid")],
                },
                {
                    kind: "execute",
                    saveAs: "rows_affected",
                    sql: `
                        DELETE FROM Comandas
                        WHERE ID_Comanda = ?1
                          AND COALESCE(?2, 0) = 0;
                    `,
                    args: [idComanda, sqlRef("has_paid")],
                },
                {
                    kind: "value",
                    saveAs: "ok_value",
                    sql: `
                        SELECT CASE
                            WHEN COALESCE(?1, 0) > 0 THEN 1
                            ELSE 0
                        END;
                    `,
                    args: [sqlRef("rows_affected")],
                },
            ],
            resultKey: "ok_value",
        });

        return json(asNumber(okValue, 0) === 1, 200, req);
    } catch (e: any) {
        return serverError(req, "internal_error", {
            message: String(e?.message || e),
            name: e?.name,
            stack: e?.stack,
        });
    }
}