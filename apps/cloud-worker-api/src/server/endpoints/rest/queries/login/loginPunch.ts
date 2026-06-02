import type { Client } from "@libsql/client/web";

import { buildTenantContext } from "../../../../middleware/withTenant";
import { createDbClient } from "../../../../db/clients";
import { json, unauthorized } from "../../../../utils/response";
import {
    applyTenantHubTransaction,
    buildCommandCloudPayload,
    getDeviceIdFromContext,
    readWriteRequest,
} from "../../../../utils/tenantHubWrites";

import { verifyPinPbkdf2 } from "./pinKdf";

const COMMAND_NAME = "login.punch";
const COMMAND_ALIASES = [
    COMMAND_NAME,
    "login.fichajePunch",
    "login.fichaje_punch",
];

function s(v: any): string {
    return String(v ?? "").trim();
}

function pad2(n: number): string {
    return String(n).padStart(2, "0");
}

function todayLocalYmd(): string {
    const d = new Date();

    return [
        d.getFullYear(),
        pad2(d.getMonth() + 1),
        pad2(d.getDate()),
    ].join("-");
}

function nowLocalSqlDateTime(): string {
    const d = new Date();

    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(
        d.getDate(),
    )} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

function getHeaderOpId(req: Request): string {
    return s(req.headers.get("X-Idempotency-Key"));
}

function getHeaderCommandName(req: Request): string {
    return s(req.headers.get("X-Command-Name"));
}

function getRawBodyOpId(rawBody: any): string {
    return s(rawBody?.op_id ?? rawBody?.opId);
}

function getRawBodyCommandName(rawBody: any): string {
    return s(rawBody?.command_name ?? rawBody?.commandName);
}

function assertCommandNameAllowed(commandName: string): boolean {
    return COMMAND_ALIASES.includes(commandName);
}

async function buildPunchStatus(
    db: Client,
    idUsuario: number,
    fecha: string,
): Promise<{
    fecha: string;
    turno_partido: number;
    partes: Array<{
        parte: number;
        entrada: string | null;
        salida: string | null;
        estado: string;
    }>;
}> {
    const tp = await db.execute({
        sql: `
			SELECT Turno_Partido AS turno_partido
			FROM Fichaje_Dia
			WHERE ID_Usuario = ?1
			  AND Fecha = ?2
			LIMIT 1;
		`,
        args: [idUsuario, fecha],
    });

    const turnoPartido = Number((tp.rows?.[0] as any)?.turno_partido ?? 0) | 0;

    const r = await db.execute({
        sql: `
			SELECT
				Parte AS parte,
				Hora_Entrada AS entrada,
				Hora_Salida AS salida,
				Estado AS estado
			FROM Fichajes
			WHERE ID_Usuario = ?1
			  AND Fecha = ?2
			ORDER BY Parte ASC;
		`,
        args: [idUsuario, fecha],
    });

    return {
        fecha,
        turno_partido: turnoPartido,
        partes: (r.rows ?? []).map((x: any) => ({
            parte: Number(x.parte ?? 1) | 0,
            entrada: x.entrada == null ? null : String(x.entrada),
            salida: x.salida == null ? null : String(x.salida),
            estado: String(x.estado ?? "ABIERTO"),
        })),
    };
}

export async function handleLoginPunch(
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

        const db: Client = ctx.dbTenant;
        const tenantId = s(ctx?.claims?.tenantId);

        if (!tenantId) {
            return unauthorized(req, "invalid_token_claims");
        }

        const {
            rawBody,
            input: body,
            opId: bodyOpId,
        } = await readWriteRequest<any>(req, {
            idUsuario: 0,
            id_usuario: 0,
            pin: "",
            tipo: "",
            fecha: null,
            hora_evento: null,
        });

        const headerOpId = getHeaderOpId(req);
        const rawBodyOpId = getRawBodyOpId(rawBody);

        if (headerOpId && rawBodyOpId && headerOpId !== rawBodyOpId) {
            return json({ ok: false, error: "op_id_mismatch" }, 409, req);
        }

        const opId = s(bodyOpId || headerOpId || rawBodyOpId);

        if (!opId) {
            return json({ ok: false, error: "missing_op_id" }, 400, req);
        }

        const headerCommandName = getHeaderCommandName(req);
        const rawBodyCommandName = getRawBodyCommandName(rawBody);

        if (headerCommandName && !assertCommandNameAllowed(headerCommandName)) {
            return json(
                {
                    ok: false,
                    error: "bad_command_name",
                    expected: COMMAND_NAME,
                    got: headerCommandName,
                },
                409,
                req,
            );
        }

        if (rawBodyCommandName && !assertCommandNameAllowed(rawBodyCommandName)) {
            return json(
                {
                    ok: false,
                    error: "bad_command_name",
                    expected: COMMAND_NAME,
                    got: rawBodyCommandName,
                },
                409,
                req,
            );
        }

        const idUsuario = Number(body?.idUsuario ?? body?.id_usuario ?? 0) | 0;
        const pin = String(body?.pin ?? "");
        const tipo = s(body?.tipo).toLowerCase();
        const fecha = s(body?.fecha) || todayLocalYmd();
        const horaEvento = s(body?.hora_evento ?? body?.horaEvento) || nowLocalSqlDateTime();

        if (idUsuario <= 0) {
            return json({ ok: false, error: "ID_Usuario inválido" }, 200, req);
        }

        if (tipo !== "entrada" && tipo !== "salida") {
            return json(
                {
                    ok: false,
                    error: "Tipo inválido (usa 'entrada' o 'salida')",
                },
                200,
                req,
            );
        }

        const u = await db.execute({
            sql: `
				SELECT Password_Hash AS password_hash
				FROM Usuarios
				WHERE ID_Usuario = ?1
				  AND Estado = 'Activo'
				LIMIT 1;
			`,
            args: [idUsuario],
        });

        const storedHash = String((u.rows?.[0] as any)?.password_hash ?? "");

        if (!storedHash) {
            return json(
                { ok: false, error: "Usuario no encontrado o inactivo" },
                200,
                req,
            );
        }

        await verifyPinPbkdf2(pin, storedHash);

        const requestArgs = {
            id_usuario: idUsuario,
            pin: pin.trim(),
            tipo,
            fecha,
            hora_evento: horaEvento,
        };

        const cloudArgs = {
            id_usuario: idUsuario,
            tipo,
            fecha,
            hora_evento: horaEvento,
        };

        if (tipo === "entrada") {
            const affected = await applyTenantHubTransaction<number>({
                env,
                tenantId,
                opId,
                commandName: COMMAND_NAME,
                deviceId: getDeviceIdFromContext(ctx),

                requestPayload: requestArgs,
                cloudPayload: buildCommandCloudPayload({
                    opId,
                    commandName: COMMAND_NAME,
                    args: cloudArgs,
                }),

                beginMode: "immediate",
                steps: [
                    {
                        kind: "execute",
                        saveAs: "affected",
                        sql: `
							INSERT INTO Fichajes (
								ID_Usuario,
								Fecha,
								Parte,
								Hora_Entrada,
								Hora_Salida,
								Estado,
								Cerrado_Automatico
							)
							SELECT
								?1,
								?2,
								CASE
									WHEN EXISTS (
										SELECT 1
										FROM Fichajes p1
										WHERE p1.ID_Usuario = ?1
										  AND p1.Fecha = ?2
										  AND p1.Parte = 1
									)
									THEN 2
									ELSE 1
								END,
								?3,
								NULL,
								'ABIERTO',
								0
							WHERE
								NOT EXISTS (
									SELECT 1
									FROM Fichajes o
									WHERE o.ID_Usuario = ?1
									  AND o.Fecha = ?2
									  AND o.Estado = 'ABIERTO'
									  AND o.Hora_Entrada IS NOT NULL
									  AND o.Hora_Salida IS NULL
								)
								AND (
									NOT EXISTS (
										SELECT 1
										FROM Fichajes p1
										WHERE p1.ID_Usuario = ?1
										  AND p1.Fecha = ?2
										  AND p1.Parte = 1
									)
									OR (
										EXISTS (
											SELECT 1
											FROM Fichajes p1c
											WHERE p1c.ID_Usuario = ?1
											  AND p1c.Fecha = ?2
											  AND p1c.Parte = 1
											  AND p1c.Hora_Salida IS NOT NULL
										)
										AND COALESCE((
											SELECT fd.Turno_Partido
											FROM Fichaje_Dia fd
											WHERE fd.ID_Usuario = ?1
											  AND fd.Fecha = ?2
											LIMIT 1
										), 0) = 1
										AND NOT EXISTS (
											SELECT 1
											FROM Fichajes p2
											WHERE p2.ID_Usuario = ?1
											  AND p2.Fecha = ?2
											  AND p2.Parte = 2
										)
									)
								);
						`,
                        args: [idUsuario, fecha, horaEvento],
                    },
                ],
                resultKey: "affected",
            });

            if (Number(affected ?? 0) <= 0) {
                return json(
                    {
                        ok: false,
                        error:
                            "No se pudo fichar entrada. Puede que tengas un fichaje abierto o que el día ya esté completado.",
                    },
                    200,
                    req,
                );
            }

            const status = await buildPunchStatus(db, idUsuario, fecha);

            return json(
                {
                    ok: true,
                    status,
                    data: status,
                },
                200,
                req,
            );
        }

        const affected = await applyTenantHubTransaction<number>({
            env,
            tenantId,
            opId,
            commandName: COMMAND_NAME,
            deviceId: getDeviceIdFromContext(ctx),

            requestPayload: requestArgs,
            cloudPayload: buildCommandCloudPayload({
                opId,
                commandName: COMMAND_NAME,
                args: cloudArgs,
            }),

            beginMode: "immediate",
            steps: [
                {
                    kind: "execute",
                    saveAs: "affected",
                    sql: `
						UPDATE Fichajes
						SET
							Hora_Salida = ?3,
							Estado = 'CERRADO',
							Cerrado_Automatico = 0,
							Cierre_Motivo = NULL,
							Incidencia = NULL
						WHERE ID_Fichaje = (
							SELECT f.ID_Fichaje
							FROM Fichajes f
							WHERE f.ID_Usuario = ?1
							  AND f.Fecha = ?2
							  AND f.Estado = 'ABIERTO'
							  AND f.Hora_Entrada IS NOT NULL
							  AND f.Hora_Salida IS NULL
							ORDER BY f.Parte DESC
							LIMIT 1
						);
					`,
                    args: [idUsuario, fecha, horaEvento],
                },
            ],
            resultKey: "affected",
        });

        if (Number(affected ?? 0) <= 0) {
            return json(
                {
                    ok: false,
                    error: "No hay fichaje abierto para cerrar (primero ficha entrada).",
                },
                200,
                req,
            );
        }

        const status = await buildPunchStatus(db, idUsuario, fecha);

        return json(
            {
                ok: true,
                status,
                data: status,
            },
            200,
            req,
        );
    } catch (e: any) {
        const msg = String(e?.message || e);
        return json({ ok: false, error: msg }, 200, req);
    }
}