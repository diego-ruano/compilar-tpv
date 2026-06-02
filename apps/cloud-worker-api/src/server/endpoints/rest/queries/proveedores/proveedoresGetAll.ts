import type { Client } from "@libsql/client/web";
import { buildTenantContext } from "../../../../middleware/withTenant";
import { createDbClient } from "../../../../db/clients";
import { corsHeaders, serverError } from "../../../../utils/response";

export type ProveedorRow = {
    id_proveedor: number;
    nombre_empresa: string;
    contacto: string | null;
    telefono: string | null;
    email: string | null;
    cif: string | null;
    informacion_adicional: string | null;
    nombre_imagen: string | null;
    ruta_imagen: string | null;
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

function rawJson(req: Request, data: unknown, status = 200): Response {
    return new Response(JSON.stringify(data), {
        status,
        headers: {
            ...corsHeaders(req),
            "content-type": "application/json; charset=utf-8",
        },
    });
}

export async function handleProveedoresGetAll(
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
                  ID_Proveedor,
                  Nombre_Empresa,
                  Contacto,
                  Telefono,
                  Email,
                  CIF,
                  Informacion_adicional,
                  Nombre_Imagen,
                  Ruta_Imagen
                FROM Proveedores
                ORDER BY Nombre_Empresa ASC;
            `,
            args: [],
        });

        const proveedores: ProveedorRow[] = ((r.rows || []) as any[]).map((row: any) => ({
            id_proveedor: Number(row.ID_Proveedor ?? row[0] ?? 0),
            nombre_empresa: String(row.Nombre_Empresa ?? row[1] ?? ""),
            contacto: row.Contacto == null ? null : String(row.Contacto),
            telefono: row.Telefono == null ? null : String(row.Telefono),
            email: row.Email == null ? null : String(row.Email),
            cif: row.CIF == null ? null : String(row.CIF),
            informacion_adicional:
                row.Informacion_adicional == null
                    ? null
                    : String(row.Informacion_adicional),
            nombre_imagen:
                row.Nombre_Imagen == null ? null : String(row.Nombre_Imagen),
            ruta_imagen:
                row.Ruta_Imagen == null ? null : String(row.Ruta_Imagen),
        }));

        return rawJson(req, proveedores, 200);
    } catch (e: any) {
        return serverError(req, "internal_error", {
            message: String(e?.message || e),
            name: e?.name,
            stack: e?.stack,
        });
    }
}