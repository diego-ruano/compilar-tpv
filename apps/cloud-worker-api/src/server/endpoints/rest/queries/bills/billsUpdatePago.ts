// src/server/endpoints/rest/queries/bills/billsUpdatePago.ts
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

const COMMAND_NAME = "cuentas.updatePago";

function s(v: any): string {
    return String(v ?? "").trim();
}

function nI(v: any): number {
    const x = Number(v ?? 0);
    return Number.isFinite(x) ? Math.trunc(x) : 0;
}

function nF(v: any): number {
    const x = Number(v ?? 0);
    return Number.isFinite(x) ? x : 0;
}

export async function handleBillsUpdatePago(
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
            idPago: 0,
            id_pago: 0,
            fechaHora: "",
            fecha_hora: "",
            metodo: "Efectivo",
            importe: 0,
        });

        if (!opId) {
            return json({ ok: false, error: "missing_op_id" }, 400, req);
        }

        const idPago = nI(body?.idPago ?? body?.id_pago);
        const fechaHora = s(body?.fechaHora ?? body?.fecha_hora);
        const metodoIn = s(body?.metodo);
        const importe = nF(body?.importe);

        if (
            idPago <= 0 ||
            !fechaHora ||
            !Number.isFinite(importe) ||
            importe <= 0
        ) {
            return json({ ok: false }, 200, req);
        }

        const metodo = metodoIn === "Tarjeta" ? "Tarjeta" : "Efectivo";

        const domainArgs = {
            id_pago: idPago,
            fecha_hora: fechaHora,
            metodo,
            importe,
        };

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
                    sql: `
                        UPDATE Pagos
                        SET
                          Fecha_Hora = ?2,
                          Metodo_Pago = ?3,
                          Importe_Total = ?4
                        WHERE ID_Pago = ?1;
                    `,
                    args: [idPago, fechaHora, metodo, importe],
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