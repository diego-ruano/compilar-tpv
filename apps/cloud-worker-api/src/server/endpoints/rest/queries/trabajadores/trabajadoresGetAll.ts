import type { Client } from "@libsql/client/web";
import { buildTenantContext } from "../../../../middleware/withTenant";
import { createDbClient } from "../../../../db/clients";
import { json, serverError } from "../../../../utils/response";

export type TrabajadorRow = {
    ID_Trabajador: number;
    ID_Usuario: number;
    Nombre: string;
    Apellido: string | null;
    Email: string;
    Estado: string;
    Nombre_Rol: string;
    Telefono: string | null;
    Puesto: string | null;
};

function pickTenantDb(ctx: any): Client {
    const db =
        (ctx?.dbTenant as Client) ||
        (ctx?.db as Client) ||
        (ctx?.tenantDb as Client) ||
        (ctx?.client as Client);
    if (!db) throw new Error("tenant_db_missing");
    return db;
}

export async function handleTrabajadoresGetAll(
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

        const r = await db.execute({
            sql: `
                SELECT
                  t.ID_Trabajador,
                  t.ID_Usuario,
                  t.Telefono,
                  t.Puesto,
                  u.Nombre,
                  u.Apellido,
                  u.Email,
                  u.Estado,
                  r.Nombre_Rol
                FROM Trabajadores t
                JOIN Usuarios u ON u.ID_Usuario = t.ID_Usuario
                JOIN Roles r ON r.ID_Rol = u.ID_Rol
                ORDER BY u.Nombre ASC, u.Apellido ASC, t.ID_Trabajador ASC;
            `,
            args: [],
        });

        const out: TrabajadorRow[] = (r.rows || []).map((row: any) => ({
            ID_Trabajador: Number(row.ID_Trabajador || 0),
            ID_Usuario: Number(row.ID_Usuario || 0),
            Telefono: row.Telefono == null ? null : String(row.Telefono),
            Puesto: row.Puesto == null ? null : String(row.Puesto),
            Nombre: String(row.Nombre || ""),
            Apellido: row.Apellido == null ? null : String(row.Apellido),
            Email: String(row.Email || ""),
            Estado: String(row.Estado || "Activo"),
            Nombre_Rol: String(row.Nombre_Rol || ""),
        }));

        return json(out, 200, req);
    } catch (e: any) {
        return serverError(req, "internal_error", {
            message: String(e?.message || e),
            name: e?.name,
            stack: e?.stack,
        });
    }
}