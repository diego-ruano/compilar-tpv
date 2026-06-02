import type { Client } from "@libsql/client/web";

import { buildTenantContext } from "../../../../middleware/withTenant";
import { createDbClient } from "../../../../db/clients";
import { json, serverError } from "../../../../utils/response";
import {
    applyTenantHubTransaction,
    buildCommandCloudPayload,
    getDeviceIdFromContext,
    getTenantIdFromContext,
    readWriteRequest,
} from "../../../../utils/tenantHubWrites";

type DeleteProductoArgs = {
    op_id?: string;
    opId?: string;
    command_name?: string;
    commandName?: string;

    id_producto?: number;
    idProducto?: number;
};

const COMMAND_NAME = "inventario.deleteProducto";
const COMMAND_ALIASES = [
    COMMAND_NAME,
    "inventario.delete_producto",
    "inventory.deleteProducto",
];

function normalizeText(value: unknown): string {
    return String(value ?? "").trim();
}

function getHeaderOpId(req: Request): string {
    return normalizeText(req.headers.get("X-Idempotency-Key"));
}

function getHeaderCommandName(req: Request): string {
    return normalizeText(req.headers.get("X-Command-Name"));
}

function getRawBodyOpId(rawBody: any): string {
    return normalizeText(rawBody?.op_id ?? rawBody?.opId);
}

function getRawBodyCommandName(rawBody: any): string {
    return normalizeText(rawBody?.command_name ?? rawBody?.commandName);
}

function assertCommandNameAllowed(commandName: string): boolean {
    return COMMAND_ALIASES.includes(commandName);
}

export async function handleInventarioDeleteProducto(
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

        const tenantId = getTenantIdFromContext(ctx);
        if (!tenantId) {
            return json({ ok: false, error: "missing_tenant_id" }, 400, req);
        }

        const {
            rawBody,
            input: body,
            opId: bodyOpId,
        } = await readWriteRequest<DeleteProductoArgs>(req, {
            id_producto: 0,
        });

        const headerOpId = getHeaderOpId(req);
        const rawBodyOpId = getRawBodyOpId(rawBody);

        if (headerOpId && rawBodyOpId && headerOpId !== rawBodyOpId) {
            return json({ ok: false, error: "op_id_mismatch" }, 409, req);
        }

        const opId = normalizeText(bodyOpId || headerOpId || rawBodyOpId);
        if (!opId) {
            return json({ ok: false, error: "missing_op_id" }, 400, req);
        }

        const headerCommandName = getHeaderCommandName(req);
        const rawBodyCommandName = getRawBodyCommandName(rawBody);

        if (headerCommandName && !assertCommandNameAllowed(headerCommandName)) {
            return json(
                {
                    ok: false,
                    error: "bad_command_name",
                    expected: COMMAND_NAME,
                    got: headerCommandName,
                },
                409,
                req,
            );
        }

        if (rawBodyCommandName && !assertCommandNameAllowed(rawBodyCommandName)) {
            return json(
                {
                    ok: false,
                    error: "bad_command_name",
                    expected: COMMAND_NAME,
                    got: rawBodyCommandName,
                },
                409,
                req,
            );
        }

        const idProducto = Number(body?.id_producto ?? body?.idProducto ?? 0);
        if (!Number.isFinite(idProducto) || idProducto <= 0) {
            return json({ ok: false, error: "bad_id_producto" }, 400, req);
        }

        const domainArgs = {
            id_producto: Math.trunc(idProducto),
        };

        await applyTenantHubTransaction({
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
                    sql: `DELETE FROM Producto_Alergenos WHERE ID_Producto = ?1;`,
                    args: [domainArgs.id_producto],
                },
                {
                    kind: "execute",
                    sql: `DELETE FROM Lotes_Producto WHERE ID_Producto = ?1;`,
                    args: [domainArgs.id_producto],
                },
                {
                    kind: "execute",
                    sql: `DELETE FROM Productos WHERE ID_Producto = ?1;`,
                    args: [domainArgs.id_producto],
                },
            ],
        });

        return json({ ok: true, data: true }, 200, req);
    } catch (e: any) {
        return serverError(req, "internal_error", String(e?.message || e));
    }
}