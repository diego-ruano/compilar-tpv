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
    type TxStep,
} from "../../../../utils/tenantHubWrites";

type SetProductoAlergenosArgs = {
    op_id?: string;
    opId?: string;
    command_name?: string;
    commandName?: string;

    id_producto?: number;
    idProducto?: number;
    ids_alergenos?: number[];
    idsAlergenos?: number[];
};

const COMMAND_NAME = "inventario.setAlergenosProducto";
const COMMAND_ALIASES = [
    COMMAND_NAME,
    "inventario.set_alergenos_producto",
    "inventory.setAlergenosProducto",
];

function normalizeText(value: unknown): string {
    return String(value ?? "").trim();
}

function normalizeIds(ids: any): number[] {
    const arr = Array.isArray(ids) ? ids : [];

    const out = arr
        .map((n) => Number(n || 0))
        .filter((n) => Number.isFinite(n) && n > 0)
        .map((n) => Math.trunc(n));

    out.sort((a, b) => a - b);

    return [...new Set(out)];
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

export async function handleInventarioSetAlergenosProducto(
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
        } = await readWriteRequest<SetProductoAlergenosArgs>(req, {
            id_producto: 0,
            ids_alergenos: [],
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

        const ids = normalizeIds(body?.ids_alergenos ?? body?.idsAlergenos);

        const domainArgs = {
            id_producto: Math.trunc(idProducto),
            ids_alergenos: ids,
        };

        const steps: TxStep[] = [
            {
                kind: "execute",
                sql: `DELETE FROM Producto_Alergenos WHERE ID_Producto = ?1;`,
                args: [domainArgs.id_producto],
            },
        ];

        for (const idAlergeno of ids) {
            steps.push({
                kind: "execute",
                sql: `
					INSERT OR IGNORE INTO Producto_Alergenos
						(ID_Producto, ID_Alergeno)
					VALUES
						(?1, ?2);
				`,
                args: [domainArgs.id_producto, idAlergeno],
            });
        }

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
            steps,
        });

        return json({ ok: true, data: true }, 200, req);
    } catch (e: any) {
        return serverError(req, "internal_error", String(e?.message || e));
    }
}