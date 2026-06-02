import type { Client } from "@libsql/client/web";

import { buildTenantContext } from "../../../../middleware/withTenant";
import { createDbClient } from "../../../../db/clients";
import { json, unauthorized, serverError } from "../../../../utils/response";
import {
    applyTenantHubTransaction,
    buildCommandCloudPayload,
    getDeviceIdFromContext,
    readWriteRequest,
} from "../../../../utils/tenantHubWrites";

const COMMAND_NAME = "login.setTurnoPartidoHoy";
const COMMAND_ALIASES = [
    COMMAND_NAME,
    "login.set_turno_partido_hoy",
];

function s(v: any): string {
    return String(v ?? "").trim();
}

function bool(v: any): boolean {
    if (typeof v === "boolean") return v;
    if (typeof v === "number") return v !== 0;

    const t = s(v).toLowerCase();
    if (!t) return false;

    return ["1", "true", "t", "yes", "y", "si", "sí"].includes(t);
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

async function getDbToday(db: Client): Promise<string> {
    const r = await db.execute({
        sql: `SELECT date('now','localtime') AS d;`,
        args: [],
    });

    return String((r.rows?.[0] as any)?.d ?? "");
}

export async function handleLoginSetTurnoPartidoHoy(
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
            turnoPartido: false,
            turno_partido: false,
            fecha: null,
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
        const turnoPartido = bool(body?.turnoPartido ?? body?.turno_partido);
        const fecha = s(body?.fecha) || (await getDbToday(ctx.dbTenant));

        if (idUsuario <= 0) {
            return json({ ok: false, error: "id_usuario_required" }, 200, req);
        }

        const domainArgs = {
            id_usuario: idUsuario,
            fecha,
            turno_partido: turnoPartido,
        };

        await applyTenantHubTransaction<number>({
            env,
            tenantId,
            opId,
            commandName: COMMAND_NAME,
            deviceId: getDeviceIdFromContext(ctx),

            requestPayload: domainArgs,
            cloudPayload: buildCommandCloudPayload({
                opId,
                commandName: COMMAND_NAME,
                args: domainArgs,
            }),

            beginMode: "immediate",
            steps: [
                {
                    kind: "execute",
                    sql: `
						INSERT INTO Fichaje_Dia (
							ID_Usuario,
							Fecha,
							Turno_Partido
						)
						VALUES (
							?1,
							?2,
							?3
						)
						ON CONFLICT(ID_Usuario, Fecha) DO UPDATE SET
							Turno_Partido = excluded.Turno_Partido;
					`,
                    args: [idUsuario, fecha, turnoPartido ? 1 : 0],
                },
                {
                    kind: "value",
                    saveAs: "ok_value",
                    sql: `SELECT 1;`,
                    args: [],
                },
            ],
            resultKey: "ok_value",
        });

        return json({ ok: true, data: "OK", result: "OK" }, 200, req);
    } catch (e: any) {
        return serverError(req, "internal_error", String(e?.message || e));
    }
}