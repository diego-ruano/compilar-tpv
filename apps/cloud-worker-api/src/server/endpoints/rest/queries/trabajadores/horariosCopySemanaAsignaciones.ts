import type { Client } from "@libsql/client/web";

import { buildTenantContext } from "../../../../middleware/withTenant";
import { createDbClient } from "../../../../db/clients";
import { json, serverError, unauthorized } from "../../../../utils/response";
import {
    applyTenantHubTransaction,
    getDeviceIdFromContext,
    getTenantIdFromContext,
    readWriteRequest,
    type TxStep,
} from "../../../../utils/tenantHubWrites";

type CopySemanaInput = {
    op_id?: string;
    opId?: string;
    command_name?: string;
    commandName?: string;

    fromMonday?: string;
    from_monday?: string;

    toMonday?: string;
    to_monday?: string;

    overwrite?: boolean | number | string;
};

const COMMAND_NAME = "horarios.copySemanaAsignaciones";
const COMMAND_ALIASES = [
    COMMAND_NAME,
    "trabajadores.horarios.copySemanaAsignaciones",
];

function trimOrEmpty(v: unknown): string {
    return String(v ?? "").trim();
}

function isYmd(value: string): boolean {
    return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function normalizeBool(value: unknown, fallback = true): boolean {
    if (typeof value === "boolean") return value;
    if (typeof value === "number") return value !== 0;

    const s = String(value ?? "").trim().toLowerCase();
    if (!s) return fallback;

    if (["1", "true", "yes", "y", "si", "sí"].includes(s)) return true;
    if (["0", "false", "no", "n"].includes(s)) return false;

    return fallback;
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

async function readAsignacionesSemana(
    db: Client,
    fechaLunes: string,
): Promise<any[]> {
    const r = await db.execute({
        sql: `
            SELECT
              a.ID_Asignacion,
              a.ID_Trabajador,
              a.Fecha,
              a.ID_Turno,
              a.Area,
              a.Hora_Inicio,
              a.Hora_Fin,
              a.Notas
            FROM Asignacion_Turnos a
            WHERE a.Fecha >= date(?1)
              AND a.Fecha < date(?1, '+7 day')
            ORDER BY a.Fecha ASC, a.ID_Trabajador ASC, a.Hora_Inicio ASC, a.ID_Asignacion ASC;
        `,
        args: [fechaLunes],
    });

    return (r.rows ?? []).map((row: any) => ({
        ID_Asignacion: Number(row.ID_Asignacion ?? row[0] ?? 0),
        ID_Trabajador: Number(row.ID_Trabajador ?? row[1] ?? 0),
        Fecha: String(row.Fecha ?? row[2] ?? ""),
        ID_Turno: Number(row.ID_Turno ?? row[3] ?? 0),
        Area: String(row.Area ?? row[4] ?? "Sala"),
        Hora_Inicio: row.Hora_Inicio ?? row[5] ?? null,
        Hora_Fin: row.Hora_Fin ?? row[6] ?? null,
        Notas: row.Notas ?? row[7] ?? null,
    }));
}

export async function handleHorariosCopySemanaAsignaciones(
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

        const db: Client = (ctx.dbTenant ?? ctx.db) as Client;
        const tenantId = getTenantIdFromContext(ctx);

        if (!tenantId) {
            return unauthorized(req, "invalid_token_claims");
        }

        const { input: payload, opId: opIdFromReadWrite } =
            await readWriteRequest<CopySemanaInput>(req, {
                fromMonday: "",
                toMonday: "",
                overwrite: true,
            });

        const commandError = validateCommandName(req, payload);
        if (commandError) return commandError;

        const opId = resolveOpId(req, payload, opIdFromReadWrite);
        if (!opId) {
            return json({ ok: false, error: "missing_op_id" }, 400, req);
        }

        const fromMonday = trimOrEmpty(payload?.fromMonday ?? payload?.from_monday);
        const toMonday = trimOrEmpty(payload?.toMonday ?? payload?.to_monday);
        const overwrite = normalizeBool(payload?.overwrite, true);

        if (!isYmd(fromMonday) || !isYmd(toMonday)) {
            return json({ ok: false, error: "bad_week_monday" }, 400, req);
        }

        const steps: TxStep[] = [];

        if (overwrite) {
            steps.push({
                kind: "execute",
                sql: `
                    DELETE FROM Asignacion_Turnos
                    WHERE Fecha >= date(?1)
                      AND Fecha < date(?1, '+7 day');
                `,
                args: [toMonday],
            });
        }

        steps.push({
            kind: "execute",
            saveAs: "rows_copied",
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
                SELECT
                    a.ID_Trabajador,
                    date(a.Fecha, printf('%+d day',
                        CAST((julianday(date(?2)) - julianday(date(?1))) AS INTEGER)
                    )) AS Fecha_Destino,
                    a.ID_Turno,
                    a.Area,
                    a.Hora_Inicio,
                    a.Hora_Fin,
                    a.Notas
                FROM Asignacion_Turnos a
                WHERE a.Fecha >= date(?1)
                  AND a.Fecha < date(?1, '+7 day')
                  ${overwrite
                    ? ""
                    : `
                  AND NOT EXISTS (
                    SELECT 1
                    FROM Asignacion_Turnos dst
                    WHERE dst.ID_Trabajador = a.ID_Trabajador
                      AND dst.Fecha = date(a.Fecha, printf('%+d day',
                        CAST((julianday(date(?2)) - julianday(date(?1))) AS INTEGER)
                      ))
                      AND dst.ID_Turno = a.ID_Turno
                      AND COALESCE(dst.Area, '') = COALESCE(a.Area, '')
                      AND COALESCE(dst.Hora_Inicio, '') = COALESCE(a.Hora_Inicio, '')
                      AND COALESCE(dst.Hora_Fin, '') = COALESCE(a.Hora_Fin, '')
                  )
                          `
                };
            `,
            args: [fromMonday, toMonday],
        });

        await applyTenantHubTransaction<number>({
            env,
            tenantId,
            opId,
            commandName: COMMAND_NAME,
            deviceId: getDeviceIdFromContext(ctx),
            beginMode: "immediate",
            steps,
            resultKey: "rows_copied",
        });

        const asignaciones = await readAsignacionesSemana(db, toMonday);

        return json(asignaciones, 200, req);
    } catch (e: any) {
        return serverError(req, "internal_error", {
            message: String(e?.message || e),
            name: e?.name,
            stack: e?.stack,
        });
    }
}