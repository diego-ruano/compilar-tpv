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

type SetPredeterminadoDesdeSemanaInput = {
    op_id?: string;
    opId?: string;
    command_name?: string;
    commandName?: string;

    fechaLunes?: string;
    fecha_lunes?: string;
};

const COMMAND_NAME = "horarios.setPredeterminadoDesdeSemana";
const COMMAND_ALIASES = [
    COMMAND_NAME,
    "trabajadores.horarios.setPredeterminadoDesdeSemana",
];

function trimOrEmpty(v: unknown): string {
    return String(v ?? "").trim();
}

function isYmd(value: string): boolean {
    return /^\d{4}-\d{2}-\d{2}$/.test(value);
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

export async function handleHorariosSetPredeterminadoDesdeSemana(
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
            await readWriteRequest<SetPredeterminadoDesdeSemanaInput>(
                req,
                { fechaLunes: "" },
            );

        const commandError = validateCommandName(req, payload);
        if (commandError) return commandError;

        const opId = resolveOpId(req, payload, opIdFromReadWrite);
        if (!opId) {
            return json({ ok: false, error: "missing_op_id" }, 400, req);
        }

        const lunes = trimOrEmpty(payload?.fechaLunes ?? payload?.fecha_lunes);

        if (!isYmd(lunes)) {
            return json({ ok: false, error: "bad_fecha_lunes" }, 400, req);
        }

        const steps: TxStep[] = [
            {
                kind: "execute",
                sql: `
                    DELETE FROM Horario_Predeterminado
                    WHERE ID_Trabajador IN (
                        SELECT DISTINCT a.ID_Trabajador
                        FROM Asignacion_Turnos a
                        WHERE a.Fecha >= date(?1)
                          AND a.Fecha < date(?1, '+7 day')
                          AND COALESCE(a.ID_Trabajador, 0) > 0
                          AND COALESCE(a.ID_Turno, 0) > 0
                    );
                `,
                args: [lunes],
            },
            {
                kind: "execute",
                saveAs: "inserted_rows",
                sql: `
                    INSERT INTO Horario_Predeterminado (
                        ID_Trabajador,
                        Weekday,
                        Orden,
                        ID_Turno,
                        Area,
                        Hora_Inicio,
                        Hora_Fin,
                        Notas
                    )
                    SELECT
                        src.ID_Trabajador,
                        src.Weekday,
                        src.Orden,
                        src.ID_Turno,
                        src.Area,
                        src.Hora_Inicio,
                        src.Hora_Fin,
                        src.Notas
                    FROM (
                        SELECT
                            a.ID_Trabajador AS ID_Trabajador,
                            CASE strftime('%w', a.Fecha)
                                WHEN '0' THEN 7
                                ELSE CAST(strftime('%w', a.Fecha) AS INTEGER)
                            END AS Weekday,
                            ROW_NUMBER() OVER (
                                PARTITION BY a.ID_Trabajador, a.Fecha
                                ORDER BY a.Hora_Inicio ASC, a.ID_Asignacion ASC
                            ) AS Orden,
                            a.ID_Turno AS ID_Turno,
                            COALESCE(NULLIF(TRIM(a.Area), ''), 'Sala') AS Area,
                            NULLIF(TRIM(a.Hora_Inicio), '') AS Hora_Inicio,
                            NULLIF(TRIM(a.Hora_Fin), '') AS Hora_Fin,
                            NULLIF(TRIM(a.Notas), '') AS Notas
                        FROM Asignacion_Turnos a
                        WHERE a.Fecha >= date(?1)
                          AND a.Fecha < date(?1, '+7 day')
                          AND COALESCE(a.ID_Trabajador, 0) > 0
                          AND COALESCE(a.ID_Turno, 0) > 0
                    ) src
                    ORDER BY
                        src.ID_Trabajador ASC,
                        src.Weekday ASC,
                        src.Orden ASC;
                `,
                args: [lunes],
            },
        ];

        const insertedRows = await applyTenantHubTransaction<number>({
            env,
            tenantId,
            opId,
            commandName: COMMAND_NAME,
            deviceId: getDeviceIdFromContext(ctx),
            beginMode: "immediate",
            steps,
            resultKey: "inserted_rows",
        });

        return json(Number(insertedRows ?? 0) > 0, 200, req);
    } catch (e: any) {
        return serverError(req, "internal_error", {
            message: String(e?.message || e),
            name: e?.name,
            stack: e?.stack,
        });
    }
}