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

type TareaDeleteInput = {
    op_id?: string;
    opId?: string;

    idTarea?: number;
    id_tarea?: number;
};

const COMMAND_NAME = "tareas.deleteTarea";
const COMMAND_ALIASES = [
    COMMAND_NAME,
    "tasks.deleteTarea",
    "tareas_delete_tarea",
];

function s(v: unknown): string {
    return String(v ?? "").trim();
}

function num(v: unknown): number {
    const n = Number(v ?? 0);
    return Number.isFinite(n) ? n : 0;
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

export async function handleTareasDeleteTarea(
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

        const { input: payload, opId: bodyOpId } =
            await readWriteRequest<TareaDeleteInput>(
                req,
                {} as TareaDeleteInput,
            );

        const opId = resolveOpId(req, payload, bodyOpId);
        if (!opId) {
            return json({ ok: false, error: "missing_op_id" }, 400, req);
        }

        const idTarea = num(payload?.idTarea ?? payload?.id_tarea);
        if (!(idTarea > 0)) {
            return json(false, 200, req);
        }

        const rowsAffected = await applyTenantHubTransaction<number>({
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
                        DELETE FROM Tarea_Asignaciones
                        WHERE ID_Tarea = ?1;
                    `,
                    args: [idTarea],
                },
                {
                    kind: "execute",
                    saveAs: "rows_affected",
                    sql: `
                        DELETE FROM Tareas
                        WHERE ID_Tarea = ?1;
                    `,
                    args: [idTarea],
                },
            ],
            resultKey: "rows_affected",
        });

        return json(Number(rowsAffected ?? 0) > 0, 200, req);
    } catch (e: any) {
        return serverError(req, "internal_error", {
            message: String(e?.message || e),
            name: e?.name,
            stack: e?.stack,
        });
    }
}