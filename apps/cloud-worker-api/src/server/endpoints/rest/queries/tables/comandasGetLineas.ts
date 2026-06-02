// src/server/endpoints/rest/queries/tables/comandasGetLineas.ts
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

export async function handleComandasGetLineas(
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

        const body = await readJsonSafe(req, { id_comanda: 0 });
        const idComanda = Number(
            (body as any).id_comanda ?? (body as any).idComanda ?? 0,
        );
        if (!idComanda) return json([], 200, req);

        const r = await db.execute({
            sql: `
        SELECT
          D.ID_Detalle,
          D.ID_Comanda,
          D.ID_Producto,
          COALESCE(D.Cantidad, 1) AS Cantidad,
          COALESCE(D.Precio_Unitario, 0) AS Precio_Unitario,
          D.Notas,
          D.Estado_Cocina,
          P.Nombre,
          COALESCE(cat.Pasa_Cocina, 0) AS Pasa_Cocina,
          CASE
            WHEN EXISTS (
              SELECT 1 FROM Pago_Detalles pd WHERE pd.ID_Detalle = D.ID_Detalle
            ) THEN 1 ELSE 0
          END AS Pagado
        FROM Detalle_Comanda D
        JOIN Productos P ON P.ID_Producto = D.ID_Producto
        JOIN Categorias_Producto cat ON cat.ID_Categoria = P.ID_Categoria
        WHERE D.ID_Comanda = ?1
        ORDER BY D.ID_Detalle ASC;
      `,
            args: [idComanda],
        });

        // devolvemos tal cual shape del Rust (con renames)
        const out = (r.rows || []).map((row: any) => ({
            ID_Detalle: Number(row.ID_Detalle ?? row[0] ?? 0),
            ID_Comanda: Number(row.ID_Comanda ?? row[1] ?? 0),
            ID_Producto: Number(row.ID_Producto ?? row[2] ?? 0),
            Cantidad: Number(row.Cantidad ?? row[3] ?? 1),
            Precio_Unitario: Number(row.Precio_Unitario ?? row[4] ?? 0),
            Notas: row.Notas ?? row[5] ?? null,
            Estado_Cocina: row.Estado_Cocina ?? row[6] ?? null,
            Nombre: String(row.Nombre ?? row[7] ?? ""),
            Pasa_Cocina: Number(row.Pasa_Cocina ?? row[8] ?? 0),
            Pagado: Number(row.Pagado ?? row[9] ?? 0),
        }));

        return json(out, 200, req);
    } catch (e: any) {
        return serverError(req, "internal_error", String(e?.message || e));
    }
}
