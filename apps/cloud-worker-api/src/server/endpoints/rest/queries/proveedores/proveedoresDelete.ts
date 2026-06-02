import type { Client } from "@libsql/client/web";

import { buildTenantContext } from "../../../../middleware/withTenant";
import { createDbClient } from "../../../../db/clients";
import { json, serverError, unauthorized } from "../../../../utils/response";
import {
    applyTenantHubTransaction,
    getDeviceIdFromContext,
    getTenantIdFromContext,
    readWriteRequest,
} from "../../../../utils/tenantHubWrites";

const COMMAND_NAME = "proveedores.delete";
const COMMAND_ALIASES = [
    COMMAND_NAME,
    "proveedores.deleteProveedor",
    "proveedores_delete",
];

type DeleteInput = {
    op_id?: string;
    opId?: string;
    idProveedor?: number;
    id_proveedor?: number;
};

function s(v: unknown): string {
    return String(v ?? "").trim();
}

function resolveOpId(req: Request, input: any, opIdFromBody: string): string {
    const fromBody = s(opIdFromBody || input?.op_id || input?.opId);
    if (fromBody) return fromBody;

    const fromHeader = s(req.headers.get("X-Idempotency-Key"));
    if (fromHeader) return fromHeader;

    return "";
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

function buildCloudPayload(params: {
    opId: string;
    commandName: string;
    args: Record<string, any>;
}) {
    return {
        op_id: params.opId,
        command_name: params.commandName,
        args: params.args,
    };
}

export async function handleProveedoresDelete(
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

        const { input: body, opId: bodyOpId } =
            await readWriteRequest<DeleteInput>(req, {
                idProveedor: 0,
                id_proveedor: 0,
            });

        const opId = resolveOpId(req, body, bodyOpId);
        if (!opId) {
            return json({ ok: false, error: "missing_op_id" }, 400, req);
        }

        const idProveedor = Number(body?.idProveedor ?? body?.id_proveedor ?? 0);

        if (!Number.isFinite(idProveedor) || idProveedor <= 0) {
            return json({ ok: false, error: "id_proveedor_invalido" }, 400, req);
        }

        const domainArgs = {
            id_proveedor: Math.trunc(idProveedor),
        };

        const txPayload = {
            env,
            tenantId,
            opId,
            commandName: COMMAND_NAME,
            deviceId: getDeviceIdFromContext(ctx),
            requestPayload: domainArgs,
            cloudPayload: buildCloudPayload({
                opId,
                commandName: COMMAND_NAME,
                args: domainArgs,
            }),
            beginMode: "immediate" as const,
            steps: [
                {
                    kind: "execute" as const,
                    sql: `
						UPDATE Lotes_Producto
						SET ID_Proveedor = NULL
						WHERE ID_Proveedor = ?1;
					`,
                    args: [domainArgs.id_proveedor],
                },
                {
                    kind: "execute" as const,
                    sql: `
						UPDATE Productos
						SET ID_Proveedor = NULL
						WHERE ID_Proveedor = ?1;
					`,
                    args: [domainArgs.id_proveedor],
                },
                {
                    kind: "execute" as const,
                    saveAs: "rows_affected",
                    sql: `
						DELETE FROM Proveedores
						WHERE ID_Proveedor = ?1;
					`,
                    args: [domainArgs.id_proveedor],
                },
            ],
            resultKey: "rows_affected",
        };

        const rowsAffected = await applyTenantHubTransaction<number>(txPayload);
        const ok = Number(rowsAffected ?? 0) > 0;

        return json({ ok: true, data: ok, result: ok }, 200, req);
    } catch (e: any) {
        return serverError(req, "internal_error", String(e?.message || e));
    }
}