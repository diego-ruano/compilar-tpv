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

type RoomPoly = { type: string; points: number[] };

type TableInput = {
    id: string;
    name: string;
    x: number;
    y: number;
    width: number;
    height: number;
    radius?: number | null;
    seats: number;
    shape: string;
};

type SalonInput = {
    id: string;
    name: string;
    room: RoomPoly;
    tables: TableInput[];
};

const COMMAND_NAME = "mesas.saveLayout";
const COMMAND_ALIASES = [
    COMMAND_NAME,
    "tables.mesasSaveLayout",
    "mesas_save_layout",
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

function parseDbId(id: string, prefix: string): number | null {
    const value = String(id || "").trim();
    if (!value.startsWith(prefix)) return null;

    const rest = value.slice(prefix.length);
    if (!rest || !/^\d+$/.test(rest)) return null;

    const n = Number(rest);
    return Number.isFinite(n) && n > 0 ? Math.trunc(n) : null;
}

function buildDeleteMesasStep(zoneIdArg: SqlArg, kept: number[]): TxStep {
    let sql = `
        DELETE FROM Mesas
        WHERE ID_Zona = ?1
          AND Es_Sistema = 0
    `;

    const args: SqlArg[] = [zoneIdArg];

    if (kept.length) {
        sql += ` AND ID_Mesa NOT IN (${kept
            .map((_, i) => `?${i + 2}`)
            .join(", ")})`;
        args.push(...kept);
    }

    sql += `
        AND NOT EXISTS (
            SELECT 1
            FROM Comandas C
            WHERE C.ID_Mesa = Mesas.ID_Mesa
        )
        AND NOT EXISTS (
            SELECT 1
            FROM Reservas R
            WHERE R.ID_Mesa = Mesas.ID_Mesa
        );
    `;

    return {
        kind: "execute",
        sql,
        args,
    };
}

export async function handleMesasSaveLayout(
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

        const { input: body, opId } = await readWriteRequest<any>(req, {
            salons: [] as SalonInput[],
        });

        if (!opId) {
            return json({ ok: false, error: "missing_op_id" }, 400, req);
        }

        const salons: SalonInput[] = Array.isArray(body?.salons)
            ? body.salons
            : [];

        const steps: TxStep[] = [];

        for (let i = 0; i < salons.length; i++) {
            const z = salons[i];

            const zoneName = s(z?.name) || `Zona ${i + 1}`;
            const pointsJson = JSON.stringify(z?.room?.points ?? []);
            const idZonaOpt = parseDbId(String(z?.id || ""), "db-zona-");

            let zoneIdArg: SqlArg;

            if (idZonaOpt) {
                steps.push({
                    kind: "execute",
                    sql: `
                        INSERT INTO Zonas (
                            ID_Zona,
                            Nombre_Zona,
                            Room_Points,
                            Updated_At
                        )
                        VALUES (?1, ?2, ?3, datetime('now','localtime'))
                        ON CONFLICT(ID_Zona) DO UPDATE SET
                            Nombre_Zona = excluded.Nombre_Zona,
                            Room_Points = excluded.Room_Points,
                            Updated_At = excluded.Updated_At;
                    `,
                    args: [idZonaOpt, zoneName, pointsJson],
                });

                zoneIdArg = idZonaOpt;
            } else {
                const zoneIdKey = `zone_id_${i}`;

                steps.push({
                    kind: "execute",
                    sql: `
                        UPDATE Zonas
                        SET
                            Room_Points = ?2,
                            Updated_At = datetime('now','localtime')
                        WHERE Nombre_Zona = ?1;
                    `,
                    args: [zoneName, pointsJson],
                });

                steps.push({
                    kind: "execute",
                    sql: `
                        INSERT INTO Zonas (
                            Nombre_Zona,
                            Room_Points,
                            Updated_At
                        )
                        SELECT
                            ?1,
                            ?2,
                            datetime('now','localtime')
                        WHERE NOT EXISTS (
                            SELECT 1
                            FROM Zonas
                            WHERE Nombre_Zona = ?1
                        );
                    `,
                    args: [zoneName, pointsJson],
                });

                steps.push({
                    kind: "value",
                    saveAs: zoneIdKey,
                    sql: `
                        SELECT ID_Zona
                        FROM Zonas
                        WHERE Nombre_Zona = ?1
                        LIMIT 1;
                    `,
                    args: [zoneName],
                });

                zoneIdArg = sqlRef(zoneIdKey);
            }

            const kept: number[] = [];
            for (const t of z?.tables ?? []) {
                const idMesa = parseDbId(String(t?.id || ""), "db-mesa-");
                if (idMesa) kept.push(idMesa);
            }

            steps.push(buildDeleteMesasStep(zoneIdArg, kept));

            for (let j = 0; j < (z?.tables ?? []).length; j++) {
                const t = z.tables[j];

                const idMesaOpt = parseDbId(String(t?.id || ""), "db-mesa-");
                const numeroMesa = s(t?.name) || `Mesa ${j + 1}`;
                const capacidad = Number(t?.seats || 0) > 0 ? Number(t.seats) : 4;
                const x = Number(t?.x || 0);
                const y = Number(t?.y || 0);
                const shape = s(t?.shape) || "rounded";
                const width = Number(t?.width || 0) > 0 ? Number(t.width) : 120;
                const height =
                    Number(t?.height || 0) > 0 ? Number(t.height) : 70;
                const radius = t?.radius ?? null;

                if (idMesaOpt) {
                    steps.push({
                        kind: "execute",
                        sql: `
                            UPDATE Mesas
                            SET
                                ID_Zona = ?1,
                                Numero_Mesa = ?2,
                                Capacidad = ?3,
                                Ubicacion_X = ?4,
                                Ubicacion_Y = ?5,
                                Shape = ?6,
                                Width = ?7,
                                Height = ?8,
                                Radius = ?9,
                                Updated_At = datetime('now','localtime')
                            WHERE ID_Mesa = ?10;
                        `,
                        args: [
                            zoneIdArg,
                            numeroMesa,
                            capacidad,
                            x,
                            y,
                            shape,
                            width,
                            height,
                            radius,
                            idMesaOpt,
                        ],
                    });
                } else {
                    steps.push({
                        kind: "execute",
                        sql: `
                            UPDATE Mesas
                            SET
                                Capacidad = ?3,
                                Ubicacion_X = ?4,
                                Ubicacion_Y = ?5,
                                Shape = ?6,
                                Width = ?7,
                                Height = ?8,
                                Radius = ?9,
                                Updated_At = datetime('now','localtime')
                            WHERE ID_Zona = ?1
                              AND Numero_Mesa = ?2
                              AND Es_Sistema = 0;
                        `,
                        args: [
                            zoneIdArg,
                            numeroMesa,
                            capacidad,
                            x,
                            y,
                            shape,
                            width,
                            height,
                            radius,
                        ],
                    });

                    steps.push({
                        kind: "execute",
                        sql: `
                            INSERT INTO Mesas (
                                ID_Zona,
                                Numero_Mesa,
                                Capacidad,
                                Ubicacion_X,
                                Ubicacion_Y,
                                Shape,
                                Width,
                                Height,
                                Radius,
                                Updated_At,
                                Es_Sistema
                            )
                            SELECT
                                ?1,
                                ?2,
                                ?3,
                                ?4,
                                ?5,
                                ?6,
                                ?7,
                                ?8,
                                ?9,
                                datetime('now','localtime'),
                                0
                            WHERE NOT EXISTS (
                                SELECT 1
                                FROM Mesas
                                WHERE ID_Zona = ?1
                                  AND Numero_Mesa = ?2
                            );
                        `,
                        args: [
                            zoneIdArg,
                            numeroMesa,
                            capacidad,
                            x,
                            y,
                            shape,
                            width,
                            height,
                            radius,
                        ],
                    });
                }
            }
        }

        steps.push({
            kind: "value",
            saveAs: "ok_value",
            sql: `SELECT 1;`,
            args: [],
        });

        await applyTenantHubTransaction<number>({
            env,
            tenantId,
            opId,
            commandName: COMMAND_NAME,
            deviceId: getDeviceIdFromContext(ctx),
            beginMode: "immediate",
            steps,
            resultKey: "ok_value",
        });

        return json({ ok: true, result: "OK", data: "OK" }, 200, req);
    } catch (e: any) {
        return serverError(req, "internal_error", {
            message: String(e?.message || e),
            name: e?.name,
            stack: e?.stack,
        });
    }
}