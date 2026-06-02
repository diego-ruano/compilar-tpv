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

type TareaFinalizarInput = {
    op_id?: string;
    opId?: string;

    idTarea?: number;
    id_tarea?: number;

    idTrabajador?: number;
    id_trabajador?: number;
};

const COMMAND_NAME = "tareas.marcarTareaFinalizada";
const COMMAND_ALIASES = [
    COMMAND_NAME,
    "tasks.marcarFinalizada",
    "tasks.marcarTareaFinalizada",
    "tareas_marcar_tarea_finalizada",
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

export async function handleTareasMarcarTareaFinalizada(
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
            await readWriteRequest<TareaFinalizarInput>(
                req,
                {} as TareaFinalizarInput,
            );

        const opId = resolveOpId(req, payload, bodyOpId);
        if (!opId) {
            return json({ ok: false, error: "missing_op_id" }, 400, req);
        }

        const idTarea = num(payload?.idTarea ?? payload?.id_tarea);
        const idTrabajador = num(
            payload?.idTrabajador ?? payload?.id_trabajador,
        );

        if (!(idTarea > 0) || !(idTrabajador > 0)) {
            return json({ ok: false, error: "bad_args" }, 400, req);
        }

        const changedRows = await applyTenantHubTransaction<number>({
            env,
            tenantId,
            opId,
            commandName: COMMAND_NAME,
            deviceId: getDeviceIdFromContext(ctx),
            beginMode: "immediate",
            steps: [
                {
                    kind: "execute",
                    saveAs: "changed_rows",
                    sql: `
                        UPDATE Tarea_Asignaciones
                        SET
                            Estado = 'FINALIZADA',
                            Finalizada_At = COALESCE(
                                Finalizada_At,
                                datetime('now','localtime')
                            )
                        WHERE ID_Tarea = ?1
                          AND ID_Trabajador = ?2;
                    `,
                    args: [idTarea, idTrabajador],
                },
            ],
            resultKey: "changed_rows",
        });

        return json(Number(changedRows ?? 0) > 0, 200, req);
    } catch (e: any) {
        return serverError(req, "internal_error", {
            message: String(e?.message || e),
            name: e?.name,
            stack: e?.stack,
        });
    }
}