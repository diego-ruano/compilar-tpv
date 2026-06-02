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
    type SqlArg,
    type TxStep,
} from "../../../../utils/tenantHubWrites";

type TareaCreateInput = {
    op_id?: string;
    opId?: string;

    titulo?: string;
    descripcion?: string | null;

    fechaLimite?: string | null;
    fecha_limite?: string | null;

    idsTrabajadores?: number[];
    ids_trabajadores?: number[];

    idTarea?: number | null;
    id_tarea?: number | null;
    remoteIdTarea?: number | null;
    remote_id_tarea?: number | null;
};

const COMMAND_NAME = "tareas.createTarea";
const COMMAND_ALIASES = [
    COMMAND_NAME,
    "tasks.createTarea",
    "tareas_create_tarea",
];

function s(v: unknown): string {
    return String(v ?? "").trim();
}

function trimOrNull(v: unknown): string | null {
    const out = s(v);
    return out ? out : null;
}

function num(v: unknown): number {
    const n = Number(v ?? 0);
    return Number.isFinite(n) ? n : 0;
}

function positiveIntOrNull(v: unknown): number | null {
    const n = num(v);
    return n > 0 ? Math.trunc(n) : null;
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

function buildInsertAsignacionesStep(
    idTareaArg: SqlArg,
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
        args: [idTareaArg, ...idsTrabajadores],
    };
}

export async function handleTareasCreateTarea(
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
            await readWriteRequest<TareaCreateInput>(
                req,
                {} as TareaCreateInput,
            );

        const opId = resolveOpId(req, payload, bodyOpId);
        if (!opId) {
            return json({ ok: false, error: "missing_op_id" }, 400, req);
        }

        const titulo = s(payload?.titulo);
        const descripcion = trimOrNull(payload?.descripcion);
        const fechaLimite = trimOrNull(
            payload?.fechaLimite ?? payload?.fecha_limite,
        );

        const idsTrabajadores = normalizeIds(
            payload?.idsTrabajadores ?? payload?.ids_trabajadores,
        );

        const requestedIdTarea = positiveIntOrNull(
            payload?.remote_id_tarea ??
            payload?.remoteIdTarea ??
            payload?.id_tarea ??
            payload?.idTarea,
        );

        if (!titulo) {
            return json({ ok: false, error: "titulo_required" }, 400, req);
        }

        if (idsTrabajadores.length === 0) {
            return json(
                { ok: false, error: "ids_trabajadores_required" },
                400,
                req,
            );
        }

        const steps: TxStep[] = [];

        if (requestedIdTarea) {
            steps.push(
                {
                    kind: "execute",
                    sql: `
                        INSERT INTO Tareas (
                            ID_Tarea,
                            Titulo,
                            Descripcion,
                            Fecha_Limite,
                            Estado
                        )
                        VALUES (
                            ?1,
                            ?2,
                            ?3,
                            ?4,
                            'ABIERTA'
                        )
                        ON CONFLICT(ID_Tarea) DO UPDATE SET
                            Titulo = excluded.Titulo,
                            Descripcion = excluded.Descripcion,
                            Fecha_Limite = excluded.Fecha_Limite,
                            Estado = COALESCE(Tareas.Estado, 'ABIERTA');
                    `,
                    args: [requestedIdTarea, titulo, descripcion, fechaLimite],
                },
                {
                    kind: "value",
                    saveAs: "id_tarea_final",
                    sql: `SELECT ?1;`,
                    args: [requestedIdTarea],
                },
            );
        } else {
            steps.push(
                {
                    kind: "execute",
                    sql: `
                        INSERT INTO Tareas (
                            Titulo,
                            Descripcion,
                            Fecha_Limite
                        )
                        VALUES (?1, ?2, ?3);
                    `,
                    args: [titulo, descripcion, fechaLimite],
                },
                {
                    kind: "value",
                    saveAs: "id_tarea_final",
                    sql: `SELECT last_insert_rowid();`,
                    args: [],
                },
            );
        }

        steps.push(
            buildInsertAsignacionesStep(
                sqlRef("id_tarea_final"),
                idsTrabajadores,
            ),
        );

        const idTarea = await applyTenantHubTransaction<number>({
            env,
            tenantId,
            opId,
            commandName: COMMAND_NAME,
            deviceId: getDeviceIdFromContext(ctx),
            beginMode: "immediate",
            steps,
            resultKey: "id_tarea_final",
        });

        return json(Number(idTarea || 0), 200, req);
    } catch (e: any) {
        return serverError(req, "internal_error", {
            message: String(e?.message || e),
            name: e?.name,
            stack: e?.stack,
        });
    }
}