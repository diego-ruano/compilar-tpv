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

type AsignacionUpdateInput = {
    op_id?: string;
    opId?: string;
    command_name?: string;
    commandName?: string;

    idAsignacion?: number;
    id_asignacion?: number;

    idTurno?: number;
    id_turno?: number;

    area?: string;

    horaInicio?: string | null;
    hora_inicio?: string | null;

    horaFin?: string | null;
    hora_fin?: string | null;

    notas?: string | null;
};

const COMMAND_NAME = "horarios.updateAsignacion";
const COMMAND_ALIASES = [
    COMMAND_NAME,
    "trabajadores.horarios.updateAsignacion",
];

function trimOrNull(v: unknown): string | null {
    const s = String(v ?? "").trim();
    return s ? s : null;
}

function trimOrEmpty(v: unknown): string {
    return String(v ?? "").trim();
}

function num(v: unknown): number {
    const n = Number(v ?? 0);
    return Number.isFinite(n) ? n : 0;
}

function resolveOpId(req: Request, payload: any, opIdFromReadWrite: string): string {
    const fromBody = trimOrEmpty(opIdFromReadWrite || payload?.op_id || payload?.opId);
    if (fromBody) return fromBody;

    return trimOrEmpty(req.headers.get("X-Idempotency-Key"));
}

function validateCommandName(req: Request, payload: any): Response | null {
    const raw =
        trimOrEmpty(payload?.command_name || payload?.commandName) ||
        trimOrEmpty(req.headers.get("X-Command-Name"));

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

export async function handleHorariosUpdateAsignacion(
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
            return unauthorized(req, "invalid_token_claims");
        }

        const { input: payload, opId: opIdFromReadWrite } =
            await readWriteRequest<AsignacionUpdateInput>(req, {
                idAsignacion: 0,
                idTurno: 0,
                area: "",
            });

        const commandError = validateCommandName(req, payload);
        if (commandError) return commandError;

        const opId = resolveOpId(req, payload, opIdFromReadWrite);
        if (!opId) {
            return json({ ok: false, error: "missing_op_id" }, 400, req);
        }

        const idAsignacion = num(payload?.idAsignacion ?? payload?.id_asignacion);
        const idTurno = num(payload?.idTurno ?? payload?.id_turno);
        const area = trimOrEmpty(payload?.area);

        if (!(idAsignacion > 0) || !(idTurno > 0) || !area) {
            return json({ ok: false, error: "bad_args" }, 400, req);
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
                    saveAs: "rows_affected",
                    sql: `
                        UPDATE Asignacion_Turnos
                        SET
                          ID_Turno = ?2,
                          Area = ?3,
                          Hora_Inicio = ?4,
                          Hora_Fin = ?5,
                          Notas = ?6
                        WHERE ID_Asignacion = ?1;
                    `,
                    args: [
                        idAsignacion,
                        idTurno,
                        area,
                        trimOrNull(payload?.horaInicio ?? payload?.hora_inicio),
                        trimOrNull(payload?.horaFin ?? payload?.hora_fin),
                        trimOrNull(payload?.notas),
                    ],
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