import type { Client } from "@libsql/client/web";
import { buildTenantContext } from "../../../../middleware/withTenant";
import { createDbClient } from "../../../../db/clients";
import { json, serverError } from "../../../../utils/response";

export type AsignacionRow = {
    ID_Asignacion: number;
    ID_Trabajador: number;
    Fecha: string;
    ID_Turno: number;
    Area: string;
    Hora_Inicio: string | null;
    Hora_Fin: string | null;
    Notas: string | null;
    Nombre_Turno: string;
};

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
        if (body.payload && typeof body.payload === "object")
            return body.payload as T;
        if (body.input && typeof body.input === "object") return body.input as T;
    }
    return body as T;
}

function pickTenantDb(ctx: any): Client {
    const db =
        (ctx?.dbTenant as Client) ||
        (ctx?.db as Client) ||
        (ctx?.tenantDb as Client) ||
        (ctx?.client as Client);
    if (!db) throw new Error("tenant_db_missing");
    return db;
}

function ymdToUtcDate(ymd: string): Date | null {
    const m = String(ymd || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return null;
    const y = Number(m[1]);
    const mo = Number(m[2]) - 1;
    const d = Number(m[3]);
    const dt = new Date(Date.UTC(y, mo, d, 0, 0, 0, 0));
    if (!Number.isFinite(dt.getTime())) return null;
    return dt;
}

function utcDateToYmd(dt: Date): string {
    const y = dt.getUTCFullYear();
    const m = String(dt.getUTCMonth() + 1).padStart(2, "0");
    const d = String(dt.getUTCDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
}

function mondayOfUtcWeek(dt: Date): Date {
    const day = dt.getUTCDay();
    const mondayIndex = (day + 6) % 7;
    const out = new Date(dt);
    out.setUTCDate(out.getUTCDate() - mondayIndex);
    out.setUTCHours(0, 0, 0, 0);
    return out;
}

function hhmm(t: string | null): string {
    return (t || "").slice(0, 5);
}

export async function handleHorariosGetAsignacionesSemana(
    req: Request,
    env: any,
    dbCentral: Client,
): Promise<Response> {
    try {
        const ctx = await buildTenantContext(
            req,
            env,
            dbCentral,
            createDbClient,
        );
        const db = pickTenantDb(ctx);

        const bodyRaw = await readJsonSafe(req, { fechaLunes: "" });
        const body = unwrapArgs<any>(bodyRaw);

        const fechaLunes = String(
            body?.fechaLunes ?? body?.fecha_lunes ?? "",
        ).trim();

        const reqMonday = ymdToUtcDate(fechaLunes);
        if (!reqMonday) {
            return json([], 200, req);
        }

        const realesRes = await db.execute({
            sql: `
                SELECT
                  a.ID_Asignacion,
                  a.ID_Trabajador,
                  a.Fecha,
                  a.ID_Turno,
                  a.Area,
                  a.Hora_Inicio,
                  a.Hora_Fin,
                  a.Notas,
                  t.Nombre_Turno
                FROM Asignacion_Turnos a
                JOIN Turnos t ON t.ID_Turno = a.ID_Turno
                WHERE a.Fecha >= date(?1)
                  AND a.Fecha < date(?1, '+7 day')
                ORDER BY a.Fecha ASC, a.ID_Trabajador ASC, a.Hora_Inicio ASC;
            `,
            args: [fechaLunes],
        });

        let out: AsignacionRow[] = (realesRes.rows || []).map((row: any) => ({
            ID_Asignacion: Number(row.ID_Asignacion || 0),
            ID_Trabajador: Number(row.ID_Trabajador || 0),
            Fecha: String(row.Fecha || ""),
            ID_Turno: Number(row.ID_Turno || 0),
            Area: row.Area == null ? "Sala" : String(row.Area),
            Hora_Inicio: row.Hora_Inicio == null ? null : String(row.Hora_Inicio),
            Hora_Fin: row.Hora_Fin == null ? null : String(row.Hora_Fin),
            Notas: row.Notas == null ? null : String(row.Notas),
            Nombre_Turno: String(row.Nombre_Turno || ""),
        }));

        const todayUtc = new Date();
        const currentMonday = mondayOfUtcWeek(todayUtc);
        const shouldFillDefaults =
            reqMonday.getTime() >= currentMonday.getTime();

        if (!shouldFillDefaults) {
            return json(out, 200, req);
        }

        const realCells = new Set<string>();
        for (const a of out) {
            realCells.add(`${a.ID_Trabajador}|${a.Fecha}`);
        }

        const defsRes = await db.execute({
            sql: `
                SELECT
                  h.ID_Trabajador,
                  h.Weekday,
                  h.Orden,
                  h.ID_Turno,
                  h.Area,
                  h.Hora_Inicio,
                  h.Hora_Fin,
                  h.Notas,
                  t.Nombre_Turno
                FROM Horario_Predeterminado h
                JOIN Turnos t ON t.ID_Turno = h.ID_Turno
                ORDER BY h.ID_Trabajador, h.Weekday, h.Orden;
            `,
            args: [],
        });

        type DefItem = {
            idTurno: number;
            area: string;
            horaInicio: string | null;
            horaFin: string | null;
            notas: string | null;
            nombreTurno: string;
        };

        const defs = new Map<string, DefItem[]>();

        for (const row of defsRes.rows || []) {
            const idTrab = Number((row as any).ID_Trabajador || 0);
            const weekday = Number((row as any).Weekday || 0);
            const idTurno = Number((row as any).ID_Turno || 0);

            if (!(idTrab > 0 && weekday >= 1 && weekday <= 7 && idTurno > 0)) {
                continue;
            }

            const key = `${idTrab}|${weekday}`;
            const list = defs.get(key) || [];

            list.push({
                idTurno,
                area: (row as any).Area ? String((row as any).Area) : "Sala",
                horaInicio: (row as any).Hora_Inicio
                    ? String((row as any).Hora_Inicio)
                    : null,
                horaFin: (row as any).Hora_Fin
                    ? String((row as any).Hora_Fin)
                    : null,
                notas: (row as any).Notas ? String((row as any).Notas) : null,
                nombreTurno: String((row as any).Nombre_Turno || ""),
            });

            defs.set(key, list);
        }

        for (let dayOffset = 0; dayOffset < 7; dayOffset++) {
            const dt = new Date(reqMonday);
            dt.setUTCDate(dt.getUTCDate() + dayOffset);

            const ymd = utcDateToYmd(dt);
            const weekday = dayOffset + 1;

            for (const [key, list] of defs.entries()) {
                const [idTrabStr, wdStr] = key.split("|");
                if (Number(wdStr) !== weekday) continue;

                const idTrab = Number(idTrabStr);
                if (realCells.has(`${idTrab}|${ymd}`)) continue;

                for (const it of list) {
                    out.push({
                        ID_Asignacion: 0,
                        ID_Trabajador: idTrab,
                        Fecha: ymd,
                        ID_Turno: it.idTurno,
                        Area: it.area,
                        Hora_Inicio: it.horaInicio,
                        Hora_Fin: it.horaFin,
                        Notas: it.notas,
                        Nombre_Turno: it.nombreTurno,
                    });
                }
            }
        }

        out.sort((a, b) => {
            if (a.Fecha !== b.Fecha) return a.Fecha < b.Fecha ? -1 : 1;
            if (a.ID_Trabajador !== b.ID_Trabajador) {
                return a.ID_Trabajador - b.ID_Trabajador;
            }
            const ha = hhmm(a.Hora_Inicio);
            const hb = hhmm(b.Hora_Inicio);
            return ha < hb ? -1 : ha > hb ? 1 : 0;
        });

        return json(out, 200, req);
    } catch (e: any) {
        return serverError(req, "internal_error", {
            message: String(e?.message || e),
            name: e?.name,
            stack: e?.stack,
        });
    }
}