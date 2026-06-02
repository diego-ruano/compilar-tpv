// src/server/endpoints/rest/queries/bills/billsDeleteGasto.ts
import type { Client } from "@libsql/client/web";

import { buildTenantContext } from "../../../../middleware/withTenant";
import { createDbClient } from "../../../../db/clients";
import { json, unauthorized, serverError } from "../../../../utils/response";
import {
    applyTenantHubTransaction,
    buildCommandCloudPayload,
    getDeviceIdFromContext,
    readWriteRequest,
} from "../../../../utils/tenantHubWrites";

const COMMAND_NAME = "cuentas.deleteGasto";

function nI(v: any): number {
    const x = Number(v ?? 0);
    return Number.isFinite(x) ? Math.trunc(x) : 0;
}

export async function handleBillsDeleteGasto(
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

        const { input: body, opId } = await readWriteRequest(req, {
            idGasto: 0,
            id_gasto: 0,
        });

        if (!opId) {
            return json({ ok: false, error: "missing_op_id" }, 400, req);
        }

        const idGasto = nI(body?.idGasto ?? body?.id_gasto);
        if (idGasto <= 0) return json({ ok: false }, 200, req);

        const domainArgs = { id_gasto: idGasto };

        await applyTenantHubTransaction<number>({
            env,
            tenantId,
            opId,
            commandName: COMMAND_NAME,
            deviceId: getDeviceIdFromContext(ctx),

            requestPayload: domainArgs,
            cloudPayload: buildCommandCloudPayload({
                opId,
                commandName: COMMAND_NAME,
                args: domainArgs,
            }),

            beginMode: "immediate",
            steps: [
                {
                    kind: "execute",
                    sql: `DELETE FROM Cuentas_Gastos WHERE ID_Gasto = ?1;`,
                    args: [idGasto],
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

        return json({ ok: true, data: true }, 200, req);
    } catch (e: any) {
        return serverError(req, "internal_error", String(e?.message || e));
    }
}