import type { Client } from "@libsql/client/web";

import { buildTenantContext } from "../../../../middleware/withTenant";
import { createDbClient } from "../../../../db/clients";
import { json, unauthorized, serverError } from "../../../../utils/response";
import { ensureMesaBarraThroughTenantHub } from "../../../../utils/tenantHubBarra";
import {
    getDeviceIdFromContext,
    getTenantIdFromContext,
    readWriteRequest,
} from "../../../../utils/tenantHubWrites";

const COMMAND_NAME = "mesas.getOrCreateMesaBarra";
const COMMAND_ALIASES = [
    COMMAND_NAME,
    "tables.mesasGetOrCreateMesaBarra",
    "mesas_get_or_create_mesa_barra",
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

export async function handleMesasGetOrCreateMesaBarra(
    req: Request,
    env: any,
    dbCentral: Client,
): Promise<Response> {
    try {
        if (req.method !== "POST") {
            return json({ ok: false, error: "method_not_allowed" }, 405, req);
        }

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

        const { opId } = await readWriteRequest<any>(req, {});

        if (!opId) {
            return json({ ok: false, error: "missing_op_id" }, 400, req);
        }

        const id = await ensureMesaBarraThroughTenantHub({
            env,
            tenantId,
            opId,
            commandName: COMMAND_NAME,
            deviceId: getDeviceIdFromContext(ctx),
        });

        return json(id, 200, req);
    } catch (e: any) {
        return serverError(req, "internal_error", {
            message: String(e?.message || e),
            name: e?.name,
            stack: e?.stack,
        });
    }
}