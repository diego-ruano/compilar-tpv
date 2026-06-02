// src/server/endpoints/rest/queries/tables/kitchenListTodayPending.ts
import type { Client } from "@libsql/client/web";

import { buildTenantContext } from "../../../../middleware/withTenant";
import { createDbClient } from "../../../../db/clients";
import { json, unauthorized, serverError } from "../../../../utils/response";

export async function handleKitchenListTodayPending(
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

        const r = await db.execute({
            sql: `
        SELECT
          c.ID_Comanda,
          m.Numero_Mesa,
          c.Fecha_Hora_Apertura,
          dc.ID_Detalle,
          COALESCE(dc.Cantidad,1) AS Cantidad,
          p.Nombre AS Nombre_Producto,
          dc.Notas,
          COALESCE(dc.Estado_Cocina,'PENDIENTE') AS Estado_Cocina,
          CASE
            WHEN EXISTS (SELECT 1 FROM Pago_Detalles pd WHERE pd.ID_Detalle = dc.ID_Detalle)
            THEN 1 ELSE 0
          END AS Pagado
        FROM Detalle_Comanda dc
        JOIN Comandas c ON c.ID_Comanda = dc.ID_Comanda
        JOIN Mesas m ON m.ID_Mesa = c.ID_Mesa
        JOIN Productos p ON p.ID_Producto = dc.ID_Producto
        JOIN Categorias_Producto cat ON cat.ID_Categoria = p.ID_Categoria
        WHERE COALESCE(cat.Pasa_Cocina, 0) = 1
          AND datetime(c.Fecha_Hora_Apertura,'localtime') >= datetime('now','localtime','-2 days')
          AND EXISTS (
            SELECT 1
            FROM Detalle_Comanda dc2
            JOIN Productos p2 ON p2.ID_Producto = dc2.ID_Producto
            JOIN Categorias_Producto cat2 ON cat2.ID_Categoria = p2.ID_Categoria
            WHERE dc2.ID_Comanda = c.ID_Comanda
              AND COALESCE(cat2.Pasa_Cocina, 0) = 1
              AND COALESCE(dc2.Estado_Cocina,'PENDIENTE') <> 'PREPARADO'
          )
        ORDER BY datetime(c.Fecha_Hora_Apertura) ASC, c.ID_Comanda ASC, dc.ID_Detalle ASC;
      `,
            args: [],
        });

        const out = (r.rows || []).map((row: any) => ({
            ID_Comanda: Number(row.ID_Comanda ?? row[0] ?? 0),
            Numero_Mesa: String(row.Numero_Mesa ?? row[1] ?? ""),
            Fecha_Hora_Apertura: String(
                row.Fecha_Hora_Apertura ?? row[2] ?? "",
            ),
            ID_Detalle: Number(row.ID_Detalle ?? row[3] ?? 0),
            Cantidad: Number(row.Cantidad ?? row[4] ?? 1),
            Nombre_Producto: String(row.Nombre_Producto ?? row[5] ?? ""),
            Notas: row.Notas ?? row[6] ?? null,
            Estado_Cocina: row.Estado_Cocina ?? row[7] ?? null,
            Pagado: Number(row.Pagado ?? row[8] ?? 0),
        }));

        return json(out, 200, req);
    } catch (e: any) {
        return serverError(req, "internal_error", String(e?.message || e));
    }
}
