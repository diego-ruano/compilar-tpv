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

type AsignacionCreateInput = {
    op_id?: string;
    opId?: string;
    command_name?: string;
    commandName?: string;

    idTrabajador?: number;
    id_trabajador?: number;

    fecha?: string;

    idTurno?: number;
    id_turno?: number;

    area?: string;

    horaInicio?: string | null;
    hora_inicio?: string | null;

    horaFin?: string | null;
    hora_fin?: string | null;

    notas?: string | null;

    idAsignacion?: number | null;
    id_asignacion?: number | null;
    remoteIdAsignacion?: number | null;
    remote_id_asignacion?: number | null;
};

const COMMAND_NAME = "horarios.createAsignacion";
const COMMAND_ALIASES = [
    COMMAND_NAME,
    "trabajadores.horarios.createAsignacion",
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

function positiveIntOrNull(v: unknown): number | null {
    const n = num(v);
    return n > 0 ? Math.trunc(n) : null;
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

export async function handleHorariosCreateAsignacion(
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
            await readWriteRequest<AsignacionCreateInput>(req, {
                idTrabajador: 0,
                fecha: "",
                idTurno: 0,
                area: "",
            });

        const commandError = validateCommandName(req, payload);
        if (commandError) return commandError;

        const opId = resolveOpId(req, payload, opIdFromReadWrite);
        if (!opId) {
            return json({ ok: false, error: "missing_op_id" }, 400, req);
        }

        const idTrabajador = num(payload?.idTrabajador ?? payload?.id_trabajador);
        const idTurno = num(payload?.idTurno ?? payload?.id_turno);
        const fecha = trimOrEmpty(payload?.fecha);
        const area = trimOrEmpty(payload?.area);

        const horaInicio = trimOrNull(payload?.horaInicio ?? payload?.hora_inicio);
        const horaFin = trimOrNull(payload?.horaFin ?? payload?.hora_fin);
        const notas = trimOrNull(payload?.notas);

        const forcedIdAsignacion = positiveIntOrNull(
            payload?.remote_id_asignacion ??
            payload?.remoteIdAsignacion ??
            payload?.id_asignacion ??
            payload?.idAsignacion,
        );

        if (!(idTrabajador > 0) || !(idTurno > 0) || !fecha || !area) {
            return json({ ok: false, error: "bad_args" }, 400, req);
        }

        const steps = forcedIdAsignacion
            ? [
                {
                    kind: "execute" as const,
                    sql: `
                        INSERT INTO Asignacion_Turnos (
                          ID_Asignacion,
                          ID_Trabajador,
                          Fecha,
                          ID_Turno,
                          Area,
                          Hora_Inicio,
                          Hora_Fin,
                          Notas
                        )
                        VALUES (
                          ?1,
                          ?2,
                          date(?3),
                          ?4,
                          ?5,
                          ?6,
                          ?7,
                          ?8
                        )
                        ON CONFLICT(ID_Asignacion) DO UPDATE SET
                          ID_Trabajador = excluded.ID_Trabajador,
                          Fecha = excluded.Fecha,
                          ID_Turno = excluded.ID_Turno,
                          Area = excluded.Area,
                          Hora_Inicio = excluded.Hora_Inicio,
                          Hora_Fin = excluded.Hora_Fin,
                          Notas = excluded.Notas;
                    `,
                    args: [
                        forcedIdAsignacion,
                        idTrabajador,
                        fecha,
                        idTurno,
                        area,
                        horaInicio,
                        horaFin,
                        notas,
                    ],
                },
                {
                    kind: "value" as const,
                    saveAs: "id_asignacion",
                    sql: `SELECT ?1;`,
                    args: [forcedIdAsignacion],
                },
            ]
            : [
                {
                    kind: "execute" as const,
                    sql: `
                        INSERT INTO Asignacion_Turnos (
                          ID_Trabajador,
                          Fecha,
                          ID_Turno,
                          Area,
                          Hora_Inicio,
                          Hora_Fin,
                          Notas
                        )
                        VALUES (
                          ?1,
                          date(?2),
                          ?3,
                          ?4,
                          ?5,
                          ?6,
                          ?7
                        );
                    `,
                    args: [
                        idTrabajador,
                        fecha,
                        idTurno,
                        area,
                        horaInicio,
                        horaFin,
                        notas,
                    ],
                },
                {
                    kind: "value" as const,
                    saveAs: "id_asignacion",
                    sql: `SELECT last_insert_rowid();`,
                    args: [],
                },
            ];

        const idAsignacion = await applyTenantHubTransaction<number>({
            env,
            tenantId,
            opId,
            commandName: COMMAND_NAME,
            deviceId: getDeviceIdFromContext(ctx),
            beginMode: "immediate",
            steps,
            resultKey: "id_asignacion",
        });

        const finalId = Number(idAsignacion ?? 0);
        if (!(finalId > 0)) {
            return json({ ok: false, error: "id_asignacion_missing" }, 500, req);
        }

        return json(finalId, 200, req);
    } catch (e: any) {
        return serverError(req, "internal_error", {
            message: String(e?.message || e),
            name: e?.name,
            stack: e?.stack,
        });
    }
}