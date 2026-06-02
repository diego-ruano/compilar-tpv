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

type TareaSetAsignacionesInput = {
    op_id?: string;
    opId?: string;

    idTarea?: number;
    id_tarea?: number;

    idsTrabajadores?: number[];
    ids_trabajadores?: number[];
};

const COMMAND_NAME = "tareas.setAsignacionesTarea";
const COMMAND_ALIASES = [
    COMMAND_NAME,
    "tasks.setAsignacionesTarea",
    "tareas_set_asignaciones_tarea",
];

function s(v: unknown): string {
    return String(v ?? "").trim();
}

function num(v: unknown): number {
    const n = Number(v ?? 0);
    return Number.isFinite(n) ? n : 0;
}

function normalizeIds(values: unknown): number[] {
    if (!Array.isArray(values)) return [];

    const ids = values
        .map((x) => Number(x))
        .filter((n) => Number.isFinite(n) && n > 0)
        .map((n) => Math.trunc(n));

    ids.sort((a, b) => a - b);

    return [...new Set(ids)];
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

function buildDeleteNotInStep(
    idTarea: number,
    idsTrabajadores: number[],
): TxStep {
    const placeholders = idsTrabajadores
        .map((_, i) => `?${i + 2}`)
        .join(", ");

    return {
        kind: "execute",
        sql: `
            DELETE FROM Tarea_Asignaciones
            WHERE ID_Tarea = ?1
              AND ID_Trabajador NOT IN (${placeholders});
        `,
        args: [idTarea, ...idsTrabajadores],
    };
}

function buildInsertAsignacionesStep(
    idTarea: number,
    idsTrabajadores: number[],
): TxStep {
    const selects = idsTrabajadores
        .map((_, i) =>
            i === 0
                ? `SELECT ?${i + 2} AS ID_Trabajador`
                : `UNION ALL SELECT ?${i + 2}`,
        )
        .join(" ");

    return {
        kind: "execute",
        sql: `
            INSERT OR IGNORE INTO Tarea_Asignaciones (
                ID_Tarea,
                ID_Trabajador,
                Asignada_At,
                Estado
            )
            SELECT
                ?1,
                src.ID_Trabajador,
                datetime('now','localtime'),
                'PENDIENTE'
            FROM (${selects}) AS src;
        `,
        args: [idTarea, ...idsTrabajadores],
    };
}

export async function handleTareasSetAsignacionesTarea(
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
            await readWriteRequest<TareaSetAsignacionesInput>(
                req,
                {} as TareaSetAsignacionesInput,
            );

        const opId = resolveOpId(req, payload, bodyOpId);
        if (!opId) {
            return json({ ok: false, error: "missing_op_id" }, 400, req);
        }

        const idTarea = num(payload?.idTarea ?? payload?.id_tarea);
        const idsTrabajadores = normalizeIds(
            payload?.idsTrabajadores ?? payload?.ids_trabajadores,
        );

        if (!(idTarea > 0)) {
            return json({ ok: false, error: "id_tarea_required" }, 400, req);
        }

        const steps: TxStep[] = [
            {
                kind: "value",
                saveAs: "task_exists",
                sql: `
                    SELECT CASE
                        WHEN EXISTS (
                            SELECT 1
                            FROM Tareas
                            WHERE ID_Tarea = ?1
                            LIMIT 1
                        )
                        THEN 1
                        ELSE 0
                    END;
                `,
                args: [idTarea],
            },
        ];

        if (idsTrabajadores.length === 0) {
            steps.push({
                kind: "execute",
                sql: `
                    DELETE FROM Tarea_Asignaciones
                    WHERE ID_Tarea = ?1
                      AND COALESCE(?2, 0) = 1;
                `,
                args: [idTarea, sqlRef("task_exists")],
            });
        } else {
            steps.push({
                kind: "execute",
                sql: `
                    DELETE FROM Tarea_Asignaciones
                    WHERE ID_Tarea = ?1
                      AND COALESCE(?2, 0) = 1
                      AND ID_Trabajador NOT IN (${idsTrabajadores
                        .map((_, i) => `?${i + 3}`)
                        .join(", ")});
                `,
                args: [idTarea, sqlRef("task_exists"), ...idsTrabajadores],
            });

            steps.push({
                kind: "execute",
                sql: `
                    INSERT OR IGNORE INTO Tarea_Asignaciones (
                        ID_Tarea,
                        ID_Trabajador,
                        Asignada_At,
                        Estado
                    )
                    SELECT
                        ?1,
                        src.ID_Trabajador,
                        datetime('now','localtime'),
                        'PENDIENTE'
                    FROM (${idsTrabajadores
                        .map((_, i) =>
                            i === 0
                                ? `SELECT ?${i + 3} AS ID_Trabajador`
                                : `UNION ALL SELECT ?${i + 3}`,
                        )
                        .join(" ")}) AS src
                    WHERE COALESCE(?2, 0) = 1;
                `,
                args: [idTarea, sqlRef("task_exists"), ...idsTrabajadores],
            });
        }

        steps.push({
            kind: "value",
            saveAs: "ok_value",
            sql: `
                SELECT CASE
                    WHEN COALESCE(?1, 0) = 1 THEN 1
                    ELSE 0
                END;
            `,
            args: [sqlRef("task_exists")],
        });

        const ok = await applyTenantHubTransaction<number>({
            env,
            tenantId,
            opId,
            commandName: COMMAND_NAME,
            deviceId: getDeviceIdFromContext(ctx),
            beginMode: "immediate",
            steps,
            resultKey: "ok_value",
        });

        return json(Number(ok ?? 0) === 1, 200, req);
    } catch (e: any) {
        return serverError(req, "internal_error", {
            message: String(e?.message || e),
            name: e?.name,
            stack: e?.stack,
        });
    }
}