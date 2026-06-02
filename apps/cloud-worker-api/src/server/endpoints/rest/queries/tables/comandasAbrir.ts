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

const COMMAND_NAME = "comandas.abrir";
const COMMAND_ALIASES = [
    COMMAND_NAME,
    "tables.comandasAbrir",
    "comandas_abrir",
];

function s(v: unknown): string {
    return String(v ?? "").trim();
}

function n(v: unknown): number {
    const out = Number(v);
    return Number.isFinite(out) ? Math.trunc(out) : 0;
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

function mapComandaRow(row: any) {
    return {
        id_comanda: Number(row.ID_Comanda ?? row.id_comanda ?? row[0] ?? 0),
        id_mesa: Number(row.ID_Mesa ?? row.id_mesa ?? row[1] ?? 0),
        id_trabajador: row.ID_Trabajador ?? row.id_trabajador ?? row[2] ?? null,
        id_reserva: row.ID_Reserva ?? row.id_reserva ?? row[3] ?? null,
        fecha_hora_apertura: String(
            row.Fecha_Hora_Apertura ?? row.fecha_hora_apertura ?? row[4] ?? "",
        ),
        fecha_hora_cierre:
            row.Fecha_Hora_Cierre ?? row.fecha_hora_cierre ?? row[5] ?? null,
        total_comanda: Number(
            row.Total_Comanda ?? row.total_comanda ?? row[6] ?? 0,
        ),
        estado: String(row.Estado ?? row.estado ?? row[7] ?? "Abierta"),
    };
}

export async function handleComandasAbrir(
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

        const db: Client = (ctx.dbTenant ?? ctx.db) as Client;
        const tenantId = getTenantIdFromContext(ctx);

        if (!tenantId) {
            return unauthorized(req, "invalid_token_claims");
        }

        const { input: body, opId } = await readWriteRequest<any>(req, {
            id_mesa: 0,
            idMesa: 0,
            id_reserva: null,
            idReserva: null,
            id_trabajador: null,
            idTrabajador: null,
            id_usuario: null,
            idUsuario: null,
            id_comanda: null,
            idComanda: null,
        });

        if (!opId) {
            return json({ ok: false, error: "missing_op_id" }, 400, req);
        }

        const idMesa = n(body?.id_mesa ?? body?.idMesa);
        const idReservaBody = n(body?.id_reserva ?? body?.idReserva);
        const idComandaForced = n(body?.id_comanda ?? body?.idComanda);

        const idTrabajadorOrUsuario = n(
            body?.id_trabajador ??
            body?.idTrabajador ??
            body?.id_usuario ??
            body?.idUsuario,
        );

        if (idMesa <= 0) {
            return json({ ok: false, error: "bad_id_mesa" }, 400, req);
        }

        const steps: TxStep[] = [
            {
                kind: "value",
                saveAs: "existing_id",
                sql: `
                    SELECT ID_Comanda
                    FROM Comandas
                    WHERE ID_Mesa = ?1
                      AND Estado = 'Abierta'
                    ORDER BY ID_Comanda DESC
                    LIMIT 1;
                `,
                args: [idMesa],
            },
            {
                kind: "value",
                saveAs: "id_trabajador_real",
                sql: `
                    SELECT COALESCE(
                        (
                            SELECT ID_Trabajador
                            FROM Trabajadores
                            WHERE ?1 > 0
                              AND ID_Trabajador = ?1
                            LIMIT 1
                        ),
                        (
                            SELECT ID_Trabajador
                            FROM Trabajadores
                            WHERE ?1 > 0
                              AND ID_Usuario = ?1
                            LIMIT 1
                        )
                    );
                `,
                args: [idTrabajadorOrUsuario],
            },
            {
                kind: "value",
                saveAs: "id_reserva_real",
                sql: `
                    SELECT COALESCE(
                        (
                            SELECT ID_Reserva
                            FROM Reservas
                            WHERE ?2 > 0
                              AND ID_Reserva = ?2
                              AND ID_Mesa = ?1
                            LIMIT 1
                        ),
                        (
                            SELECT ID_Reserva
                            FROM Reservas
                            WHERE COALESCE(?2, 0) <= 0
                              AND ID_Mesa = ?1
                              AND Estado = 'ACTIVA'
                            ORDER BY ID_Reserva DESC
                            LIMIT 1
                        )
                    );
                `,
                args: [idMesa, idReservaBody],
            },
        ];

        if (idComandaForced > 0) {
            steps.push({
                kind: "execute",
                sql: `
                    INSERT OR IGNORE INTO Comandas (
                        ID_Comanda,
                        ID_Mesa,
                        ID_Trabajador,
                        ID_Reserva,
                        Fecha_Hora_Apertura,
                        Total_Comanda,
                        Estado
                    )
                    SELECT
                        ?1,
                        ?2,
                        ?3,
                        ?4,
                        datetime('now','localtime'),
                        0,
                        'Abierta'
                    WHERE COALESCE(?5, 0) <= 0;
                `,
                args: [
                    idComandaForced,
                    idMesa,
                    sqlRef("id_trabajador_real"),
                    sqlRef("id_reserva_real"),
                    sqlRef("existing_id"),
                ],
            });
        } else {
            steps.push({
                kind: "execute",
                sql: `
                    INSERT INTO Comandas (
                        ID_Mesa,
                        ID_Trabajador,
                        ID_Reserva,
                        Fecha_Hora_Apertura,
                        Total_Comanda,
                        Estado
                    )
                    SELECT
                        ?1,
                        ?2,
                        ?3,
                        datetime('now','localtime'),
                        0,
                        'Abierta'
                    WHERE COALESCE(?4, 0) <= 0;
                `,
                args: [
                    idMesa,
                    sqlRef("id_trabajador_real"),
                    sqlRef("id_reserva_real"),
                    sqlRef("existing_id"),
                ],
            });
        }

        steps.push(
            {
                kind: "execute",
                sql: `
                    UPDATE Comandas
                    SET ID_Trabajador = COALESCE(ID_Trabajador, ?2)
                    WHERE COALESCE(?2, 0) > 0
                      AND ID_Comanda = COALESCE(
                        ?1,
                        (
                            SELECT ID_Comanda
                            FROM Comandas
                            WHERE ID_Mesa = ?3
                              AND Estado = 'Abierta'
                            ORDER BY ID_Comanda DESC
                            LIMIT 1
                        )
                      );
                `,
                args: [sqlRef("existing_id"), sqlRef("id_trabajador_real"), idMesa],
            },
            {
                kind: "execute",
                sql: `
                    UPDATE Comandas
                    SET ID_Reserva = COALESCE(ID_Reserva, ?2)
                    WHERE COALESCE(?2, 0) > 0
                      AND ID_Comanda = COALESCE(
                        ?1,
                        (
                            SELECT ID_Comanda
                            FROM Comandas
                            WHERE ID_Mesa = ?3
                              AND Estado = 'Abierta'
                            ORDER BY ID_Comanda DESC
                            LIMIT 1
                        )
                      );
                `,
                args: [sqlRef("existing_id"), sqlRef("id_reserva_real"), idMesa],
            },
            {
                kind: "value",
                saveAs: "final_id",
                sql: `
                    SELECT ID_Comanda
                    FROM Comandas
                    WHERE ID_Mesa = ?1
                      AND Estado = 'Abierta'
                    ORDER BY ID_Comanda DESC
                    LIMIT 1;
                `,
                args: [idMesa],
            },
        );

        const idComanda = await applyTenantHubTransaction<number>({
            env,
            tenantId,
            opId,
            commandName: COMMAND_NAME,
            deviceId: getDeviceIdFromContext(ctx),
            beginMode: "immediate",
            steps,
            resultKey: "final_id",
        });

        const finalId = Number(idComanda ?? 0);
        if (finalId <= 0) {
            return json(null, 200, req);
        }

        const r = await db.execute({
            sql: `
                SELECT
                    ID_Comanda,
                    ID_Mesa,
                    ID_Trabajador,
                    ID_Reserva,
                    Fecha_Hora_Apertura,
                    Fecha_Hora_Cierre,
                    Total_Comanda,
                    Estado
                FROM Comandas
                WHERE ID_Comanda = ?1
                LIMIT 1;
            `,
            args: [finalId],
        });

        const row: any = r.rows?.[0];
        if (!row) {
            return json(null, 200, req);
        }

        return json(mapComandaRow(row), 200, req);
    } catch (e: any) {
        return serverError(req, "internal_error", {
            message: String(e?.message || e),
            name: e?.name,
            stack: e?.stack,
        });
    }
}