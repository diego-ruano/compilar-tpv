// src/server/endpoints/rest/queries/bills/billsUpdateGasto.ts
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

const COMMAND_NAME = "cuentas.updateGasto";

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

export async function handleBillsUpdateGasto(
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
            fecha: "",
            tipoGasto: "",
            tipo_gasto: "",
            concepto: "",
            importe: 0,
            proveedorId: null as number | null,
            proveedor_id: null as number | null,
        });

        if (!opId) {
            return json({ ok: false, error: "missing_op_id" }, 400, req);
        }

        const idGasto = nI(body?.idGasto ?? body?.id_gasto);
        const fecha = s(body?.fecha);
        const tipoGasto = s(body?.tipoGasto ?? body?.tipo_gasto);
        const concepto = s(body?.concepto);
        const importe = nF(body?.importe);
        const proveedorIdRaw = body?.proveedorId ?? body?.proveedor_id ?? null;

        if (
            idGasto <= 0 ||
            !fecha ||
            !tipoGasto ||
            !concepto ||
            !Number.isFinite(importe) ||
            importe <= 0
        ) {
            return json({ ok: false }, 200, req);
        }

        const proveedorId =
            tipoGasto === "Proveedor" &&
                Number.isFinite(Number(proveedorIdRaw)) &&
                nI(proveedorIdRaw) > 0
                ? nI(proveedorIdRaw)
                : null;

        const domainArgs = {
            id_gasto: idGasto,
            fecha,
            tipo_gasto: tipoGasto,
            concepto,
            importe,
            proveedor_id: proveedorId,
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
                        UPDATE Cuentas_Gastos
                        SET
                          Fecha = date(?2),
                          Tipo_Gasto = ?3,
                          Concepto = ?4,
                          Importe = ?5,
                          ID_Proveedor = ?6
                        WHERE ID_Gasto = ?1;
                    `,
                    args: [
                        idGasto,
                        fecha,
                        tipoGasto,
                        concepto,
                        importe,
                        proveedorId,
                    ],
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