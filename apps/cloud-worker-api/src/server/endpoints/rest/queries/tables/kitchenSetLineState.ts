import type { Client } from "@libsql/client/web";

import { buildTenantContext } from "../../../../middleware/withTenant";
import { createDbClient } from "../../../../db/clients";
import { json, unauthorized, serverError } from "../../../../utils/response";
import {
    applyTenantHubTransaction,
    getDeviceIdFromContext,
    getTenantIdFromContext,
    readWriteRequest,
} from "../../../../utils/tenantHubWrites";

const COMMAND_NAME = "kitchen.setLineaEstado";
const COMMAND_ALIASES = [
    COMMAND_NAME,
    "tables.kitchenSetLineState",
    "kitchen.setLineState",
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

export async function handleKitchenSetLineState(
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
            id_detalle: 0,
            idDetalle: 0,
            id_usuario_cocinero: 0,
            idUsuarioCocinero: 0,
            estado: "",
        });

        if (!opId) {
            return json({ ok: false, error: "missing_op_id" }, 400, req);
        }

        const idDetalle = Number(body?.id_detalle ?? body?.idDetalle ?? 0);

        const idUsuarioCocinero = Number(
            body?.id_usuario_cocinero ?? body?.idUsuarioCocinero ?? 0,
        );

        let estado = String(body?.estado || "").trim().toUpperCase();
        estado = estado === "PREPARADO" ? "PREPARADO" : "PENDIENTE";

        if (!Number.isFinite(idDetalle) || idDetalle <= 0) {
            return json({ ok: false, error: "bad_id_detalle" }, 400, req);
        }

        if (!Number.isFinite(idUsuarioCocinero) || idUsuarioCocinero <= 0) {
            return json(
                { ok: false, error: "bad_id_usuario_cocinero" },
                400,
                req,
            );
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
                    kind: "execute",
                    sql: `
                        UPDATE Detalle_Comanda
                        SET
                            Estado_Cocina = CASE
                                WHEN ?2 = 'PREPARADO' THEN 'PREPARADO'
                                ELSE 'PENDIENTE'
                            END,
                            ID_Usuario_Cocinero = CASE
                                WHEN ?2 = 'PREPARADO' THEN COALESCE(ID_Usuario_Cocinero, ?3)
                                ELSE NULL
                            END,
                            Fecha_Hora_Cocina = CASE
                                WHEN ?2 = 'PREPARADO' THEN COALESCE(Fecha_Hora_Cocina, datetime('now','localtime'))
                                ELSE NULL
                            END
                        WHERE ID_Detalle = ?1;
                    `,
                    args: [idDetalle, estado, idUsuarioCocinero],
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