import type { Client } from "@libsql/client/web";
import { buildTenantContext } from "../../../../middleware/withTenant";
import { createDbClient } from "../../../../db/clients";
import { corsHeaders, serverError } from "../../../../utils/response";

export type ProductoRow = {
    id_producto: number;
    id_categoria: number | null;
    id_proveedor: number | null;
    nombre: string;
    precio_venta: number | null;
    stock_actual: number;
    stock_minimo: number | null;
    unidad_medida: string | null;
    nombre_imagen: string | null;
    ruta_imagen: string | null;
    cantidad_pedido_esperada: number | null;
    ultima_entrada: string | null;
    caducidad_proxima: string | null;
};

async function readJsonSafe<T>(req: Request, fallback: T): Promise<T> {
    try {
        return (await req.json()) as T;
    } catch {
        return fallback;
    }
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

function unwrapArgs<T>(body: any): T {
    if (body && typeof body === "object" && body.args && typeof body.args === "object") {
        return body.args as T;
    }
    return body as T;
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

export async function handleProveedoresGetProductos(
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

        const bodyRaw = await readJsonSafe(req, { idProveedor: 0 });
        const body = unwrapArgs<any>(bodyRaw);

        const idProveedor = Number(
            body?.idProveedor ?? body?.id_proveedor ?? 0,
        );

        if (!Number.isFinite(idProveedor) || idProveedor <= 0) {
            throw new Error("id_proveedor_invalido");
        }

        const r = await db.execute({
            sql: `
                SELECT
                  p.ID_Producto,
                  p.ID_Categoria,
                  p.ID_Proveedor,
                  p.Nombre,
                  p.Precio_Venta,

                  (
                    SELECT COALESCE(SUM(l.Stock_Disponible), 0)
                    FROM Lotes_Producto l
                    WHERE l.ID_Producto = p.ID_Producto
                  ) AS Stock_Actual,

                  p.Stock_Minimo,
                  p.Unidad_Medida,
                  p.Nombre_Imagen,
                  p.Ruta_Imagen,
                  p.Cantidad_Pedido_Esperada,

                  (
                    SELECT MAX(datetime(l.Fecha_Entrada))
                    FROM Lotes_Producto l
                    WHERE l.ID_Producto = p.ID_Producto
                  ) AS Ultima_Entrada,

                  (
                    SELECT l.Caducidad
                    FROM Lotes_Producto l
                    WHERE l.ID_Producto = p.ID_Producto
                      AND l.Stock_Disponible > 0
                      AND l.Caducidad IS NOT NULL
                    ORDER BY date(l.Caducidad) ASC, datetime(l.Fecha_Entrada) ASC, l.ID_Lote ASC
                    LIMIT 1
                  ) AS Caducidad_Proxima

                FROM Productos p
                WHERE p.ID_Proveedor = ?
                ORDER BY p.Nombre ASC;
            `,
            args: [idProveedor],
        });

        const productos: ProductoRow[] = ((r.rows || []) as any[]).map((row: any) => ({
            id_producto: Number(row.ID_Producto ?? row[0] ?? 0),
            id_categoria:
                row.ID_Categoria == null ? null : Number(row.ID_Categoria),
            id_proveedor:
                row.ID_Proveedor == null ? null : Number(row.ID_Proveedor),
            nombre: String(row.Nombre ?? row[3] ?? ""),
            precio_venta:
                row.Precio_Venta == null ? null : Number(row.Precio_Venta),
            stock_actual: Number(row.Stock_Actual ?? row[5] ?? 0),
            stock_minimo:
                row.Stock_Minimo == null ? null : Number(row.Stock_Minimo),
            unidad_medida:
                row.Unidad_Medida == null ? null : String(row.Unidad_Medida),
            nombre_imagen:
                row.Nombre_Imagen == null ? null : String(row.Nombre_Imagen),
            ruta_imagen:
                row.Ruta_Imagen == null ? null : String(row.Ruta_Imagen),
            cantidad_pedido_esperada:
                row.Cantidad_Pedido_Esperada == null
                    ? null
                    : Number(row.Cantidad_Pedido_Esperada),
            ultima_entrada:
                row.Ultima_Entrada == null ? null : String(row.Ultima_Entrada),
            caducidad_proxima:
                row.Caducidad_Proxima == null
                    ? null
                    : String(row.Caducidad_Proxima),
        }));

        return rawJson(req, productos, 200);
    } catch (e: any) {
        return serverError(req, "internal_error", {
            message: String(e?.message || e),
            name: e?.name,
            stack: e?.stack,
        });
    }
}