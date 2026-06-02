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

const COMMAND_NAME = "comandas.cerrar";
const COMMAND_ALIASES = [
    COMMAND_NAME,
    "tables.comandasCerrar",
    "comandas_cerrar",
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

export async function handleComandasCerrar(
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
            total: 0,
            total_comanda: 0,
        });

        if (!opId) {
            return json({ ok: false, error: "missing_op_id" }, 400, req);
        }

        const idComanda = Number(body?.id_comanda ?? body?.idComanda ?? 0);
        const total = Number(body?.total ?? body?.total_comanda ?? 0);

        if (!Number.isFinite(idComanda) || idComanda <= 0) {
            return json({ ok: false, error: "bad_id_comanda" }, 400, req);
        }

        if (!Number.isFinite(total) || total < 0) {
            return json({ ok: false, error: "bad_total" }, 400, req);
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
                        UPDATE Comandas
                        SET
                            Estado = 'Pagada',
                            Total_Comanda = ?2,
                            Fecha_Hora_Cierre = datetime('now','localtime')
                        WHERE ID_Comanda = ?1;
                    `,
                    args: [idComanda, total],
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