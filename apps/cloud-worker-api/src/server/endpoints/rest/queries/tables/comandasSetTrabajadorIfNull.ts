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
    type TxStep,
} from "../../../../utils/tenantHubWrites";

const COMMAND_NAME = "comandas.setTrabajadorIfNull";
const COMMAND_ALIASES = [
    COMMAND_NAME,
    "tables.comandasSetTrabajadorIfNull",
    "comandas_set_trabajador_if_null",
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

export async function handleComandasSetTrabajadorIfNull(
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
            id_usuario: null,
            idUsuario: null,
            id_trabajador: null,
            idTrabajador: null,
        });

        if (!opId) {
            return json({ ok: false, error: "missing_op_id" }, 400, req);
        }

        const idComanda = Number(body?.id_comanda ?? body?.idComanda ?? 0);

        const idUsuarioOrTrabajador =
            Number(
                body?.id_trabajador ??
                body?.idTrabajador ??
                body?.id_usuario ??
                body?.idUsuario ??
                0,
            ) || 0;

        if (!Number.isFinite(idComanda) || idComanda <= 0) {
            return json(false, 200, req);
        }

        const steps: TxStep[] = [
            {
                kind: "value",
                saveAs: "id_trabajador_real",
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
                            WHERE ?1 > 0
                              AND ID_Usuario = ?1
                            LIMIT 1
                        )
                    );
                `,
                args: [idUsuarioOrTrabajador],
            },
            {
                kind: "execute",
                sql: `
                    UPDATE Comandas
                    SET ID_Trabajador = ?2
                    WHERE ID_Comanda = ?1
                      AND Estado = 'Abierta'
                      AND COALESCE(?2, 0) > 0
                      AND (ID_Trabajador IS NULL OR ID_Trabajador <= 0)
                      AND NOT EXISTS (
                        SELECT 1
                        FROM Detalle_Comanda dc
                        WHERE dc.ID_Comanda = ?1
                      );
                `,
                args: [idComanda, sqlRef("id_trabajador_real")],
            },
            {
                kind: "value",
                saveAs: "changed_rows",
                sql: `SELECT changes();`,
                args: [],
            },
        ];

        const changed = await applyTenantHubTransaction<number>({
            env,
            tenantId,
            opId,
            commandName: COMMAND_NAME,
            deviceId: getDeviceIdFromContext(ctx),
            beginMode: "immediate",
            steps,
            resultKey: "changed_rows",
        });

        return json(Number(changed ?? 0) > 0, 200, req);
    } catch (e: any) {
        return serverError(req, "internal_error", {
            message: String(e?.message || e),
            name: e?.name,
            stack: e?.stack,
        });
    }
}