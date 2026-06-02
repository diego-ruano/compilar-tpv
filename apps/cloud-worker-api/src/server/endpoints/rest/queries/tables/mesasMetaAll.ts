// src/server/endpoints/rest/queries/tables/mesasMetaAll.ts
import type { Client } from "@libsql/client/web";

import { buildTenantContext } from "../../../../middleware/withTenant";
import { createDbClient } from "../../../../db/clients";
import { json, unauthorized, serverError } from "../../../../utils/response";

export async function handleMesasMetaAll(
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
        if (!ctx?.claims?.tenantId)
            return unauthorized(req, "invalid_token_claims");

        // 1) comandas abiertas
        const a = await db.execute({
            sql: `
        SELECT
          c.ID_Mesa,
          c.ID_Comanda,
          (
            SELECT IFNULL(SUM(dc.Precio_Unitario * COALESCE(dc.Cantidad,1)), 0)
            FROM Detalle_Comanda dc
            LEFT JOIN Pago_Detalles pd ON pd.ID_Detalle = dc.ID_Detalle
            WHERE dc.ID_Comanda = c.ID_Comanda
              AND pd.ID_Detalle IS NULL
          ) AS Total_Pendiente,
          (
            SELECT COUNT(*)
            FROM Detalle_Comanda dc
            LEFT JOIN Pago_Detalles pd ON pd.ID_Detalle = dc.ID_Detalle
            WHERE dc.ID_Comanda = c.ID_Comanda
              AND pd.ID_Detalle IS NULL
          ) AS Pendientes_Pago,
          (
            SELECT COUNT(*)
            FROM Detalle_Comanda dc
            JOIN Productos p ON p.ID_Producto = dc.ID_Producto
            JOIN Categorias_Producto cat ON cat.ID_Categoria = p.ID_Categoria
            LEFT JOIN Pago_Detalles pd ON pd.ID_Detalle = dc.ID_Detalle
            WHERE dc.ID_Comanda = c.ID_Comanda
              AND pd.ID_Detalle IS NULL
              AND COALESCE(cat.Pasa_Cocina, 0) = 1
              AND COALESCE(dc.Estado_Cocina,'PENDIENTE') <> 'PREPARADO'
          ) AS Pendientes_Cocina
        FROM Comandas c
        WHERE c.Estado = 'Abierta';
      `,
            args: [],
        });

        const map: Record<string, any> = {};

        for (const r of (a.rows || []) as any[]) {
            const idMesa = Number(r.ID_Mesa ?? r[0] ?? 0);
            const idComanda = Number(r.ID_Comanda ?? r[1] ?? 0);
            if (!idMesa || !idComanda) continue;

            const totalPend = Number(r.Total_Pendiente ?? r[2] ?? 0);
            const pendientesPago = Number(r.Pendientes_Pago ?? r[3] ?? 0);
            const pendientesCocina = Number(r.Pendientes_Cocina ?? r[4] ?? 0);

            map[idMesa] = {
                ocupada: true,
                id_comanda: idComanda,
                idComanda: idComanda,
                totalPendiente: totalPend,
                pendientesPago,
                pendientesCocina,
                estado:
                    pendientesPago > 0 || totalPend > 0 ? "PENDIENTE" : "LIBRE",
                reserva: null,
            };
        }

        // 2) reservas próximas/activas (solo para UI)
        const b = await db.execute({
            sql: `
        SELECT
          R.ID_Mesa,
          R.ID_Reserva,
          R.Dia_YMD,
          R.Hora,
          R.Estado,
          C.Nombre AS Cliente_Nombre
        FROM Reservas R
        JOIN Clientes C ON C.ID_Cliente = R.ID_Cliente
        WHERE R.ID_Mesa IS NOT NULL
          AND R.Estado IN ('PROXIMA','ACTIVA');
      `,
            args: [],
        });

        const now = Date.now();

        // eliges 1 reserva por mesa
        const best = new Map<number, any>();

        for (const r of (b.rows || []) as any[]) {
            const idMesa = Number(r.ID_Mesa ?? r[0] ?? 0);
            const idReserva = Number(r.ID_Reserva ?? r[1] ?? 0);
            const dia = String(r.Dia_YMD ?? r[2] ?? "");
            const hora = String(r.Hora ?? r[3] ?? "");
            const estadoDb = String(r.Estado ?? r[4] ?? "PROXIMA");
            const cliente = String(r.Cliente_Nombre ?? r[5] ?? "");

            if (!idMesa || !idReserva || !dia || !hora) continue;

            const dt = new Date(
                `${dia}T${hora.length === 5 ? hora + ":00" : hora}`,
            );
            const minutosPara = Math.floor((dt.getTime() - now) / 60000);

            const estadoUi =
                estadoDb.toUpperCase() === "ACTIVA" || minutosPara <= 0
                    ? "ACTIVA"
                    : "PROXIMA";
            const keep =
                estadoUi === "ACTIVA"
                    ? true
                    : minutosPara > 0 && minutosPara <= 60;
            if (!keep) continue;

            const item = {
                idReserva: idReserva,
                clienteNombre: cliente,
                diaYMD: dia,
                hora,
                estado: estadoUi,
                minutosPara,
            };

            const prev = best.get(idMesa);
            if (!prev) {
                best.set(idMesa, item);
                continue;
            }

            const replace =
                item.estado === "ACTIVA" && prev.estado !== "ACTIVA"
                    ? true
                    : item.estado !== "ACTIVA" && prev.estado === "ACTIVA"
                        ? false
                        : item.estado === "PROXIMA" && prev.estado === "PROXIMA"
                            ? item.minutosPara < prev.minutosPara
                            : Math.abs(item.minutosPara) <
                            Math.abs(prev.minutosPara);

            if (replace) best.set(idMesa, item);
        }

        for (const [idMesa, reserva] of best.entries()) {
            if (map[idMesa]) map[idMesa].reserva = reserva;
            else {
                map[idMesa] = {
                    ocupada: false,
                    id_comanda: 0,
                    idComanda: 0,
                    totalPendiente: 0,
                    pendientesPago: 0,
                    pendientesCocina: 0,
                    estado: "LIBRE",
                    reserva,
                };
            }
        }

        return json(map, 200, req);
    } catch (e: any) {
        return serverError(req, "internal_error", String(e?.message || e));
    }
}
