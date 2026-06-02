// src/server/endpoints/rest/queries/bills/billsCreateGasto.ts
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

const COMMAND_NAME = "cuentas.createGasto";

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

export async function handleBillsCreateGasto(
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
            idGasto: null as number | null,
            id_gasto: null as number | null,
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

        const requestedIdGasto = nI(body?.idGasto ?? body?.id_gasto ?? 0);
        const fecha = s(body?.fecha);
        const tipoGasto = s(body?.tipoGasto ?? body?.tipo_gasto);
        const concepto = s(body?.concepto);
        const importe = nF(body?.importe);
        const proveedorIdRaw = body?.proveedorId ?? body?.proveedor_id ?? null;

        if (
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

        const idGastoToInsert = requestedIdGasto > 0 ? requestedIdGasto : null;

        const requestArgs = {
            id_gasto: idGastoToInsert,
            fecha,
            tipo_gasto: tipoGasto,
            concepto,
            importe,
            proveedor_id: proveedorId,
        };

        const cloudArgs = requestArgs;

        const finalIdGasto = await applyTenantHubTransaction<number>({
            env,
            tenantId,
            opId,
            commandName: COMMAND_NAME,
            deviceId: getDeviceIdFromContext(ctx),

            requestPayload: requestArgs,
            cloudPayload: buildCommandCloudPayload({
                opId,
                commandName: COMMAND_NAME,
                args: cloudArgs,
            }),

            beginMode: "immediate",
            steps: [
                {
                    kind: "execute",
                    sql: `
                        INSERT INTO Cuentas_Gastos (
                            ID_Gasto,
                            Fecha,
                            Concepto,
                            Importe,
                            Tipo_Gasto,
                            ID_Proveedor
                        )
                        VALUES (?1, date(?2), ?3, ?4, ?5, ?6);
                    `,
                    args: [
                        idGastoToInsert,
                        fecha,
                        concepto,
                        importe,
                        tipoGasto,
                        proveedorId,
                    ],
                },
                {
                    kind: "value",
                    saveAs: "id_gasto",
                    sql: `
                        SELECT COALESCE(?1, last_insert_rowid());
                    `,
                    args: [idGastoToInsert],
                },
            ],
            resultKey: "id_gasto",
        });

        return json(
            {
                ok: true,
                data: {
                    id_gasto: finalIdGasto,
                    idGasto: finalIdGasto,
                },
            },
            200,
            req,
        );
    } catch (e: any) {
        return serverError(req, "internal_error", String(e?.message || e));
    }
}