import type { Client } from "@libsql/client/web";

import { buildTenantContext } from "../../../../middleware/withTenant";
import { createDbClient } from "../../../../db/clients";
import { json, unauthorized, serverError } from "../../../../utils/response";

async function readJsonSafe<T>(req: Request, fallback: T): Promise<T> {
    try {
        return (await req.json()) as T;
    } catch {
        return fallback;
    }
}

function unwrapArgs<T>(body: any): T {
    if (body && typeof body === "object") {
        if (body.args && typeof body.args === "object") return body.args as T;
        if (body.payload && typeof body.payload === "object") return body.payload as T;
        if (body.input && typeof body.input === "object") return body.input as T;
    }

    return (body ?? {}) as T;
}

function s(v: any): string {
    return String(v ?? "").trim();
}

type TodayPunchStatusBody = {
    idUsuario?: number;
    id_usuario?: number;
    fecha?: string | null;
};

async function getDbToday(db: Client): Promise<string> {
    const r = await db.execute({
        sql: `SELECT date('now','localtime') AS d;`,
        args: [],
    });

    return String((r.rows?.[0] as any)?.d ?? "");
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
    const t = await db.execute({
        sql: `
			SELECT Turno_Partido AS turno_partido
			FROM Fichaje_Dia
			WHERE ID_Usuario = ?1
			  AND Fecha = ?2
			LIMIT 1;
		`,
        args: [idUsuario, fecha],
    });

    const turnoPartido = Number((t.rows?.[0] as any)?.turno_partido ?? 0) | 0;

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

    const partes = (r.rows ?? []).map((x: any) => ({
        parte: Number(x.parte ?? 1) | 0,
        entrada: x.entrada == null ? null : String(x.entrada),
        salida: x.salida == null ? null : String(x.salida),
        estado: String(x.estado ?? "ABIERTO"),
    }));

    return {
        fecha,
        turno_partido: turnoPartido,
        partes,
    };
}

export async function handleLoginTodayPunchStatus(
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

        if (!ctx?.claims?.tenantId) {
            return unauthorized(req, "invalid_token_claims");
        }

        const rawBody = await readJsonSafe<any>(req, {});
        const body = unwrapArgs<TodayPunchStatusBody>(rawBody);

        const idUsuario = Number(body?.idUsuario ?? body?.id_usuario ?? 0) | 0;

        if (idUsuario <= 0) {
            return json({ ok: false, error: "id_usuario_required" }, 200, req);
        }

        const fecha = s(body?.fecha) || (await getDbToday(db));
        const status = await buildPunchStatus(db, idUsuario, fecha);

        return json({ ok: true, status, data: status }, 200, req);
    } catch (e: any) {
        return serverError(req, "internal_error", String(e?.message || e));
    }
}