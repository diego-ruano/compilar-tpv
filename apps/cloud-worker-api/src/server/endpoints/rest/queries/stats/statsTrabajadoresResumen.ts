import type { Client } from "@libsql/client/web";

import { buildTenantContext } from "../../../../middleware/withTenant";
import { createDbClient } from "../../../../db/clients";
import { json, unauthorized, serverError } from "../../../../utils/response";

type StatsRange = "hoy" | "semana" | "mes" | "anio";

type StatsTrabajadoresResumenInput = {
    range?: StatsRange;
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
        if (body.payload && typeof body.payload === "object") return body.payload as T;
        if (body.input && typeof body.input === "object") return body.input as T;
    }
    return body as T;
}

function normalizeRange(v: unknown): StatsRange {
    return v === "hoy" || v === "semana" || v === "mes" || v === "anio"
        ? v
        : "hoy";
}

function rangeBounds(range: StatsRange): { start: string; end: string } {
    switch (range) {
        case "hoy":
            return {
                start: "datetime('now','localtime','start of day')",
                end: "datetime('now','localtime')",
            };
        case "semana":
            return {
                start: "datetime('now','localtime','-6 days','start of day')",
                end: "datetime('now','localtime')",
            };
        case "mes":
            return {
                start: "datetime('now','localtime','start of month')",
                end: "datetime('now','localtime')",
            };
        case "anio":
        default:
            return {
                start: "datetime('now','localtime','start of year')",
                end: "datetime('now','localtime')",
            };
    }
}

function nI(v: any): number {
    const x = Number(v ?? 0);
    return Number.isFinite(x) ? Math.trunc(x) : 0;
}
function nF(v: any): number {
    const x = Number(v ?? 0);
    return Number.isFinite(x) ? x : 0;
}
function s(v: any): string {
    return String(v ?? "").trim();
}

async function tableHasColumn(
    db: Client,
    table: string,
    column: string,
): Promise<boolean> {
    const r = await db.execute({
        sql: `PRAGMA table_info(${table});`,
        args: [],
    });
    return (r.rows ?? []).some(
        (row: any) => String(row.name ?? row[1] ?? "") === column,
    );
}

export async function handleStatsTrabajadoresResumen(
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

        const bodyRaw = await readJsonSafe<StatsTrabajadoresResumenInput>(req, {});
        const body = unwrapArgs<StatsTrabajadoresResumenInput>(bodyRaw);
        const range = normalizeRange(body?.range);
        const { start, end } = rangeBounds(range);

        const baseR = await db.execute({
            sql: `
        SELECT
          t.ID_Trabajador,
          u.ID_Usuario,
          u.Nombre,
          u.Apellido,
          r.Nombre_Rol
        FROM Trabajadores t
        JOIN Usuarios u ON u.ID_Usuario = t.ID_Usuario
        JOIN Roles r ON r.ID_Rol = u.ID_Rol
        WHERE r.Nombre_Rol IN ('Cocinero','Camarero','Limpieza')
        ORDER BY r.Nombre_Rol ASC, u.Nombre ASC;
      `,
            args: [],
        });

        const base = (baseR.rows ?? [])
            .map((r: any) => {
                const nombre = s(r.Nombre);
                const ap = r.Apellido == null ? "" : s(r.Apellido);
                const full = ap ? `${nombre} ${ap}` : nombre;
                return {
                    id_trabajador: nI(r.ID_Trabajador),
                    id_usuario: nI(r.ID_Usuario),
                    nombre: full,
                    rol: s(r.Nombre_Rol),
                };
            })
            .filter((x) => x.id_trabajador > 0 && x.id_usuario > 0);

        if (!base.length) {
            return json(
                {
                    cocineros: [],
                    camareros: [],
                    limpieza: [],
                    ranking_ventas: { labels: [], values: [] },
                },
                200,
                req,
            );
        }

        const tareasR = await db.execute({
            sql: `
        WITH rng AS (SELECT ${start} AS start_dt, ${end} AS end_dt)
        SELECT
          ID_Trabajador,
          SUM(CASE
                WHEN datetime(Asignada_At) >= (SELECT start_dt FROM rng)
                 AND datetime(Asignada_At) <  (SELECT end_dt   FROM rng)
                THEN 1 ELSE 0 END
          ) AS asignadas,
          SUM(CASE
                WHEN COALESCE(Estado,'')='FINALIZADA'
                 AND Finalizada_At IS NOT NULL
                 AND datetime(Finalizada_At) >= (SELECT start_dt FROM rng)
                 AND datetime(Finalizada_At) <  (SELECT end_dt   FROM rng)
                THEN 1 ELSE 0 END
          ) AS finalizadas
        FROM Tarea_Asignaciones
        GROUP BY ID_Trabajador;
      `,
            args: [],
        });

        const tareas_asig = new Map<number, number>();
        const tareas_fin = new Map<number, number>();
        for (const r of tareasR.rows ?? []) {
            tareas_asig.set(
                nI((r as any).ID_Trabajador),
                nI((r as any).asignadas),
            );
            tareas_fin.set(
                nI((r as any).ID_Trabajador),
                nI((r as any).finalizadas),
            );
        }

        const cocR = await db.execute({
            sql: `
        WITH rng AS (SELECT ${start} AS start_dt, ${end} AS end_dt)
        SELECT
          ID_Usuario_Cocinero,
          COUNT(DISTINCT ID_Comanda) AS n
        FROM Detalle_Comanda
        WHERE ID_Usuario_Cocinero IS NOT NULL
          AND Fecha_Hora_Cocina IS NOT NULL
          AND datetime(Fecha_Hora_Cocina) >= (SELECT start_dt FROM rng)
          AND datetime(Fecha_Hora_Cocina) <  (SELECT end_dt   FROM rng)
        GROUP BY ID_Usuario_Cocinero;
      `,
            args: [],
        });
        const coc_comandas_por_user = new Map<number, number>();
        for (const r of cocR.rows ?? []) {
            coc_comandas_por_user.set(
                nI((r as any).ID_Usuario_Cocinero),
                nI((r as any).n),
            );
        }

        const camComR = await db.execute({
            sql: `
        WITH rng AS (SELECT ${start} AS start_dt, ${end} AS end_dt)
        SELECT
          ID_Trabajador,
          COUNT(*) AS n
        FROM Comandas
        WHERE ID_Trabajador IS NOT NULL
          AND datetime(Fecha_Hora_Apertura) >= (SELECT start_dt FROM rng)
          AND datetime(Fecha_Hora_Apertura) <  (SELECT end_dt   FROM rng)
        GROUP BY ID_Trabajador;
      `,
            args: [],
        });
        const cam_comandas_tomadas = new Map<number, number>();
        for (const r of camComR.rows ?? []) {
            cam_comandas_tomadas.set(
                nI((r as any).ID_Trabajador),
                nI((r as any).n),
            );
        }

        const cobR = await db.execute({
            sql: `
        WITH rng AS (SELECT ${start} AS start_dt, ${end} AS end_dt)
        SELECT
          p.ID_Trabajador_Cobrador AS ID_Trabajador,
          COUNT(*) AS n
        FROM Pagos p
        JOIN rng ON 1=1
        JOIN Trabajadores t ON t.ID_Trabajador = p.ID_Trabajador_Cobrador
        JOIN Usuarios u ON u.ID_Usuario = t.ID_Usuario
        JOIN Roles r ON r.ID_Rol = u.ID_Rol
        WHERE datetime(p.Fecha_Hora) >= rng.start_dt
          AND datetime(p.Fecha_Hora) <  rng.end_dt
          AND p.ID_Trabajador_Cobrador IS NOT NULL
          AND r.Nombre_Rol = 'Camarero'
        GROUP BY p.ID_Trabajador_Cobrador;
      `,
            args: [],
        });
        const cam_cobros = new Map<number, number>();
        for (const r of cobR.rows ?? []) {
            cam_cobros.set(nI((r as any).ID_Trabajador), nI((r as any).n));
        }

        const salesR = await db.execute({
            sql: `
        WITH
        rng AS (SELECT ${start} AS start_dt, ${end} AS end_dt),
        pagos_rng AS (
          SELECT ID_Comanda, COALESCE(Importe_Total,0) AS imp
          FROM Pagos, rng
          WHERE datetime(Fecha_Hora) >= rng.start_dt
            AND datetime(Fecha_Hora) <  rng.end_dt
        ),
        comanda_trab AS (
          SELECT ID_Comanda, ID_Trabajador
          FROM Comandas
          WHERE ID_Trabajador IS NOT NULL
        ),
        comanda_tot AS (
          SELECT
            c.ID_Trabajador AS id_trabajador,
            p.ID_Comanda    AS id_comanda,
            SUM(p.imp)      AS total
          FROM pagos_rng p
          JOIN comanda_trab c ON c.ID_Comanda = p.ID_Comanda
          GROUP BY c.ID_Trabajador, p.ID_Comanda
        )
        SELECT
          id_trabajador,
          ROUND(COALESCE(SUM(total),0),2) AS ventas_total,
          ROUND(COALESCE(AVG(total),0),2) AS ticket_medio
        FROM comanda_tot
        GROUP BY id_trabajador;
      `,
            args: [],
        });
        const cam_ventas_total = new Map<number, number>();
        const cam_ticket_medio = new Map<number, number>();
        for (const r of salesR.rows ?? []) {
            cam_ventas_total.set(
                nI((r as any).id_trabajador),
                nF((r as any).ventas_total),
            );
            cam_ticket_medio.set(
                nI((r as any).id_trabajador),
                nF((r as any).ticket_medio),
            );
        }

        const horas_map = new Map<number, number>();
        const hasSalida = await tableHasColumn(
            db,
            "Fichajes",
            "Hora_Salida",
        ).catch(() => false);

        if (hasSalida) {
            const horasR = await db.execute({
                sql: `
          WITH rng AS (SELECT ${start} AS start_dt, ${end} AS end_dt)
          SELECT
            t.ID_Trabajador,
            ROUND(COALESCE(SUM(
              CASE
                WHEN f.Hora_Entrada IS NOT NULL AND f.Hora_Salida IS NOT NULL
                 AND datetime(f.Fecha || ' ' || f.Hora_Entrada) >= rng.start_dt
                 AND datetime(f.Fecha || ' ' || f.Hora_Entrada) <  rng.end_dt
                THEN max(0, (julianday(datetime(f.Fecha || ' ' || f.Hora_Salida)) - julianday(datetime(f.Fecha || ' ' || f.Hora_Entrada))) * 24.0)
                ELSE 0
              END
            ),0),2) AS horas
          FROM Trabajadores t
          JOIN Usuarios u ON u.ID_Usuario = t.ID_Usuario
          LEFT JOIN Fichajes f ON f.ID_Usuario = u.ID_Usuario
          JOIN rng ON 1=1
          GROUP BY t.ID_Trabajador;
        `,
                args: [],
            });

            for (const r of horasR.rows ?? []) {
                horas_map.set(
                    nI((r as any).ID_Trabajador),
                    Math.round(nF((r as any).horas) * 100) / 100,
                );
            }
        }

        const puntualidad_map = new Map<number, any>();
        const puntR = await db.execute({
            sql: `
        WITH
        rng AS (SELECT ${start} AS start_dt, ${end} AS end_dt),
        asig AS (
          SELECT
            a.ID_Trabajador,
            t.ID_Usuario,
            a.Fecha,
            a.Hora_Inicio,
            datetime(a.Fecha || ' ' || a.Hora_Inicio) AS prog_dt
          FROM Asignacion_Turnos a
          JOIN Trabajadores t ON t.ID_Trabajador = a.ID_Trabajador
          WHERE a.Hora_Inicio IS NOT NULL
            AND datetime(a.Fecha || ' ' || a.Hora_Inicio) >= (SELECT start_dt FROM rng)
            AND datetime(a.Fecha || ' ' || a.Hora_Inicio) <  (SELECT end_dt   FROM rng)
        ),
        fich AS (
          SELECT
            ID_Usuario,
            Fecha,
            MIN(datetime(Fecha || ' ' || Hora_Entrada)) AS ent_dt
          FROM Fichajes
          WHERE Hora_Entrada IS NOT NULL
          GROUP BY ID_Usuario, Fecha
        ),
        joined AS (
          SELECT
            a.ID_Trabajador,
            a.Fecha,
            a.prog_dt,
            f.ent_dt
          FROM asig a
          JOIN fich f ON f.ID_Usuario = a.ID_Usuario AND f.Fecha = a.Fecha
        ),
        ranked AS (
          SELECT
            ID_Trabajador,
            prog_dt,
            ent_dt,
            ROW_NUMBER() OVER (
              PARTITION BY ID_Trabajador
              ORDER BY date(Fecha) DESC, prog_dt ASC
            ) AS rn
          FROM joined
        )
        SELECT
          ID_Trabajador,
          strftime('%H:%M', prog_dt) AS programado,
          strftime('%H:%M', ent_dt)  AS entrada,
          CASE WHEN ent_dt <= prog_dt THEN 1 ELSE 0 END AS puntual,
          CAST(
            MAX(
              0,
              ROUND((julianday(ent_dt) - julianday(prog_dt)) * 24 * 60, 0)
            ) AS INTEGER
          ) AS minutos_retraso
        FROM ranked
        WHERE rn = 1;
      `,
            args: [],
        });

        for (const r of puntR.rows ?? []) {
            const id = nI((r as any).ID_Trabajador);
            puntualidad_map.set(id, {
                puntual: nI((r as any).puntual) === 1,
                programado: s((r as any).programado),
                entrada: s((r as any).entrada),
                minutos_retraso: Math.max(0, nI((r as any).minutos_retraso)),
            });
        }

        const cocineros: any[] = [];
        const camareros: any[] = [];
        const limpieza: any[] = [];

        const rankingPairs: Array<{ nombre: string; ventas: number }> = [];

        for (const w of base) {
            const asig = tareas_asig.get(w.id_trabajador) ?? 0;
            const fin = tareas_fin.get(w.id_trabajador) ?? 0;
            const puntualidad = puntualidad_map.get(w.id_trabajador) ?? null;
            const horas = horas_map.get(w.id_trabajador) ?? 0;

            if (w.rol === "Cocinero") {
                const comandas = coc_comandas_por_user.get(w.id_usuario) ?? 0;
                cocineros.push({
                    id_trabajador: w.id_trabajador,
                    nombre: w.nombre,
                    rol: "Cocinero",
                    tareas_asignadas: asig,
                    tareas_finalizadas: fin,
                    puntualidad,
                    horas_trabajadas: horas,
                    comandas_preparadas: comandas,
                });
            } else if (w.rol === "Camarero") {
                const comandas = cam_comandas_tomadas.get(w.id_trabajador) ?? 0;
                const cobros = cam_cobros.get(w.id_trabajador) ?? 0;
                const ticket = cam_ticket_medio.get(w.id_trabajador) ?? 0;
                const ventas = cam_ventas_total.get(w.id_trabajador) ?? 0;

                camareros.push({
                    id_trabajador: w.id_trabajador,
                    nombre: w.nombre,
                    rol: "Camarero",
                    tareas_asignadas: asig,
                    tareas_finalizadas: fin,
                    puntualidad,
                    horas_trabajadas: horas,
                    comandas_tomadas: comandas,
                    cobros_realizados: cobros,
                    ticket_medio_eur: ticket,
                });

                rankingPairs.push({ nombre: w.nombre, ventas });
            } else {
                limpieza.push({
                    id_trabajador: w.id_trabajador,
                    nombre: w.nombre,
                    rol: "Limpieza",
                    tareas_asignadas: asig,
                    tareas_finalizadas: fin,
                    puntualidad,
                    horas_trabajadas: horas,
                });
            }
        }

        rankingPairs.sort((a, b) => (b.ventas ?? 0) - (a.ventas ?? 0));

        const ranking_ventas = {
            labels: rankingPairs.map((x) => x.nombre),
            values: rankingPairs.map(
                (x) => Math.round((x.ventas ?? 0) * 100) / 100,
            ),
        };

        return json(
            { cocineros, camareros, limpieza, ranking_ventas },
            200,
            req,
        );
    } catch (e: any) {
        return serverError(req, "internal_error", String(e?.message || e));
    }
}