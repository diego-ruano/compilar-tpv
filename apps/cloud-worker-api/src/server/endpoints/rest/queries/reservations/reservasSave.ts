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

const COMMAND_NAME = "reservas.save";
const COMMAND_ALIASES = [
    COMMAND_NAME,
    "reservations.save",
    "reservas_save",
];

type ReservaSaveInput = {
    op_id?: string;
    opId?: string;

    id_reserva?: number | null;
    idReserva?: number | null;

    remote_id_reserva?: number | null;
    remoteIdReserva?: number | null;

    dia_ymd?: string;
    diaYMD?: string;

    hora?: string;

    turno?: string | null;
    Turno?: string | null;

    comensales?: number;

    nota?: string | null;
    Nota?: string | null;

    estado?: string | null;
    Estado?: string | null;

    id_mesa?: number;
    idMesa?: number;

    nombre_cliente?: string;
    nombreCliente?: string;

    telefono?: string | null;
    telefono_cliente?: string | null;
    telefonoCliente?: string | null;

    email?: string | null;
    email_cliente?: string | null;
    emailCliente?: string | null;

    notas_cliente?: string | null;
    notasCliente?: string | null;
};

/* =========================
   Helpers
========================= */

function s(v: unknown): string {
    return String(v ?? "").trim();
}

function cleanOptStr(v: unknown): string | null {
    const out = s(v);
    return out ? out : null;
}

function numberOrNull(v: unknown): number | null {
    if (v === null || v === undefined || s(v) === "") return null;

    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? Math.trunc(n) : null;
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

function isYmd10(value: string): boolean {
    return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function normalizeDiaYmd(raw: string): string {
    const value = s(raw);

    if (value.length >= 10) {
        const candidate = value.slice(0, 10);
        if (isYmd10(candidate)) return candidate;
    }

    const posT = value.indexOf("T");
    const posSpace = value.indexOf(" ");

    const pos =
        posT >= 0 && posSpace >= 0
            ? Math.min(posT, posSpace)
            : posT >= 0
                ? posT
                : posSpace;

    if (pos >= 10) {
        const candidate = value.slice(0, 10);
        if (isYmd10(candidate)) return candidate;
    }

    throw new Error(
        `Formato de día inválido: '${value}'. Esperado YYYY-MM-DD.`,
    );
}

function normalizeHoraHhmm(raw: string): string {
    const value = s(raw);

    if (value.length < 5) {
        throw new Error(`Formato de hora inválido: '${value}'. Esperado HH:MM.`);
    }

    const hhmm = value.slice(0, 5);

    if (!/^\d{2}:\d{2}$/.test(hhmm)) {
        throw new Error(`Formato de hora inválido: '${value}'. Esperado HH:MM.`);
    }

    const hh = Number(hhmm.slice(0, 2));
    const mm = Number(hhmm.slice(3, 5));

    if (!(hh >= 0 && hh <= 23 && mm >= 0 && mm <= 59)) {
        throw new Error(
            `Hora fuera de rango: '${value}'. Esperado 00:00..23:59.`,
        );
    }

    return hhmm;
}

function normalizeEstado(raw: unknown): string {
    const value = s(raw || "PROXIMA").toUpperCase();

    if (value === "PROXIMA") return "PROXIMA";
    if (value === "ACTIVA") return "ACTIVA";
    if (value === "FINALIZADA") return "FINALIZADA";
    if (value === "CANCELADA") return "CANCELADA";
    if (value === "NO_SHOW") return "NO_SHOW";

    return "PROXIMA";
}

function turnoPorHora(hhmm: string): string {
    const [hhS, mmS] = hhmm.split(":");
    const hh = Number(hhS || 0);
    const mm = Number(mmS || 0);
    const mins = hh * 60 + mm;

    if (mins < 13 * 60) return "DESAYUNO";
    if (mins < 16 * 60) return "COMIDA";
    if (mins < 19 * 60) return "CAFE";
    return "CENA";
}

function normalizeTurno(raw: unknown, horaHhmm: string): string {
    const value = cleanOptStr(raw)?.toUpperCase();

    if (value === "DESAYUNO") return "DESAYUNO";
    if (value === "COMIDA") return "COMIDA";
    if (value === "CAFE") return "CAFE";
    if (value === "CENA") return "CENA";

    return turnoPorHora(horaHhmm);
}

async function nextTableId(
    db: Client,
    table: string,
    column: string,
): Promise<number> {
    const r = await db.execute({
        sql: `SELECT COALESCE(MAX(${column}), 0) + 1 AS next_id FROM ${table};`,
        args: [],
    });

    const n = Number((r.rows?.[0] as any)?.next_id ?? 1);
    return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 1;
}

function buildCloudPayload(params: {
    opId: string;
    commandName: string;
    args: Record<string, any>;
}) {
    return {
        op_id: params.opId,
        command_name: params.commandName,
        args: params.args,
    };
}

/* =========================
   Handler
========================= */

export async function handleReservasSave(
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
        if (!tenantId) return unauthorized(req, "invalid_token_claims");

        const db: Client = ctx.dbTenant;

        const { input: body, opId: bodyOpId } =
            await readWriteRequest<ReservaSaveInput>(req, {});

        const opId = resolveOpId(req, body, bodyOpId);
        if (!opId) {
            return json({ ok: false, error: "missing_op_id" }, 400, req);
        }

        const idReservaOriginal = numberOrNull(
            body?.id_reserva ?? body?.idReserva,
        );

        const remoteIdReservaOriginal = numberOrNull(
            body?.remote_id_reserva ?? body?.remoteIdReserva,
        );

        const targetIdReserva = idReservaOriginal ?? remoteIdReservaOriginal;

        const dia = normalizeDiaYmd(String(body?.dia_ymd ?? body?.diaYMD ?? ""));
        const hora = normalizeHoraHhmm(String(body?.hora ?? ""));

        const idMesa = Number(body?.id_mesa ?? body?.idMesa ?? 0);
        const comensales = Number(body?.comensales ?? 0);

        const nombreCliente = s(body?.nombre_cliente ?? body?.nombreCliente);

        const telefono = cleanOptStr(
            body?.telefono ?? body?.telefono_cliente ?? body?.telefonoCliente,
        );
        const email = cleanOptStr(
            body?.email ?? body?.email_cliente ?? body?.emailCliente,
        );
        const notasCliente = cleanOptStr(
            body?.notas_cliente ?? body?.notasCliente,
        );

        const notaReserva = cleanOptStr(body?.nota ?? body?.Nota);
        const turno = normalizeTurno(body?.turno ?? body?.Turno, hora);

        const estado = targetIdReserva
            ? normalizeEstado(body?.estado ?? body?.Estado)
            : "PROXIMA";

        if (!nombreCliente) {
            return json({ ok: false, error: "missing_nombre_cliente" }, 400, req);
        }

        if (!Number.isFinite(idMesa) || idMesa <= 0) {
            return json({ ok: false, error: "invalid_id_mesa" }, 400, req);
        }

        if (!Number.isFinite(comensales) || comensales <= 0) {
            return json({ ok: false, error: "invalid_comensales" }, 400, req);
        }

        const idReservaFinal =
            targetIdReserva ?? (await nextTableId(db, "Reservas", "ID_Reserva"));

        const requestArgs = {
            id_reserva: idReservaOriginal,
            remote_id_reserva: remoteIdReservaOriginal,
            dia_ymd: dia,
            hora,
            turno,
            comensales,
            nota: notaReserva,
            estado,
            id_mesa: Math.trunc(idMesa),
            nombre_cliente: nombreCliente,
            telefono,
            email,
            notas_cliente: notasCliente,
        };

        const cloudArgs = {
            ...requestArgs,

            /*
                Importante:
                - id_reserva mantiene lo que venía del frontend.
                - remote_id_reserva lleva el ID real generado en nube.
                Así coincide con lo que aplica reservas_save_after_remote_ok en local.
            */
            remote_id_reserva: idReservaFinal,
        };

        const steps: TxStep[] = [
            {
                kind: "value",
                saveAs: "existing_client_id",
                sql: `
					SELECT ID_Cliente
					FROM Clientes
					WHERE (
						?1 IS NOT NULL
						AND TRIM(?1) <> ''
						AND Email = ?1
					)
					OR (
						?2 IS NOT NULL
						AND TRIM(?2) <> ''
						AND Telefono = ?2
					)
					ORDER BY
						CASE
							WHEN ?1 IS NOT NULL AND TRIM(?1) <> '' AND Email = ?1 THEN 0
							ELSE 1
						END,
						ID_Cliente DESC
					LIMIT 1;
				`,
                args: [email, telefono],
            },
            {
                kind: "execute",
                sql: `
					UPDATE Clientes
					SET
						Nombre = ?1,
						Email = CASE
							WHEN ?2 IS NOT NULL
							 AND TRIM(?2) <> ''
							 AND (Email IS NULL OR TRIM(Email) = '')
							THEN ?2
							ELSE Email
						END,
						Telefono = ?3,
						Notas = ?4
					WHERE ID_Cliente = ?5
					  AND COALESCE(?5, 0) > 0;
				`,
                args: [
                    nombreCliente,
                    email,
                    telefono,
                    notasCliente,
                    sqlRef("existing_client_id"),
                ],
            },
            {
                kind: "execute",
                sql: `
					INSERT INTO Clientes (
						Nombre,
						Telefono,
						Email,
						Notas,
						Created_At
					)
					SELECT
						?1,
						?2,
						?3,
						?4,
						datetime('now','localtime')
					WHERE COALESCE(?5, 0) <= 0;
				`,
                args: [
                    nombreCliente,
                    telefono,
                    email,
                    notasCliente,
                    sqlRef("existing_client_id"),
                ],
            },
            {
                kind: "value",
                saveAs: "id_cliente_final",
                sql: `SELECT COALESCE(?1, last_insert_rowid());`,
                args: [sqlRef("existing_client_id")],
            },
            {
                kind: "execute",
                sql: `
					INSERT INTO Reservas (
						ID_Reserva,
						ID_Cliente,
						ID_Mesa,
						Dia_YMD,
						Hora,
						Turno,
						Comensales,
						Nota,
						Estado
					)
					VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
					ON CONFLICT(ID_Reserva) DO UPDATE SET
						ID_Cliente = excluded.ID_Cliente,
						ID_Mesa = excluded.ID_Mesa,
						Dia_YMD = excluded.Dia_YMD,
						Hora = excluded.Hora,
						Turno = excluded.Turno,
						Comensales = excluded.Comensales,
						Nota = excluded.Nota,
						Estado = excluded.Estado;
				`,
                args: [
                    idReservaFinal,
                    sqlRef("id_cliente_final"),
                    Math.trunc(idMesa),
                    dia,
                    hora,
                    turno,
                    Math.trunc(comensales),
                    notaReserva,
                    estado,
                ],
            },
            {
                kind: "value",
                saveAs: "id_reserva_final",
                sql: `SELECT ?1 AS id_reserva;`,
                args: [idReservaFinal],
            },
        ];

        const txPayload = {
            env,
            tenantId,
            opId,
            commandName: COMMAND_NAME,
            deviceId: getDeviceIdFromContext(ctx),
            requestPayload: requestArgs,
            cloudPayload: buildCloudPayload({
                opId,
                commandName: COMMAND_NAME,
                args: cloudArgs,
            }),
            beginMode: "immediate" as const,
            steps,
            resultKey: "id_reserva_final",
        };

        const returnedId = await applyTenantHubTransaction<number>(txPayload);

        const idReservaReturned = Number(returnedId || idReservaFinal);

        return json(
            {
                ok: true,
                data: {
                    id_reserva: idReservaReturned,
                },
                result: {
                    id_reserva: idReservaReturned,
                },
            },
            200,
            req,
        );
    } catch (e: any) {
        return serverError(req, "internal_error", String(e?.message || e));
    }
}