import type { Client } from "@libsql/client/web";

import { buildTenantContext } from "../../../../middleware/withTenant";
import { createDbClient } from "../../../../db/clients";
import { json, serverError, unauthorized } from "../../../../utils/response";
import {
    applyTenantHubTransaction,
    getDeviceIdFromContext,
    getTenantIdFromContext,
    readWriteRequest,
    type TxStep,
} from "../../../../utils/tenantHubWrites";

type ProductoCreateInput = {
    op_id?: string;
    opId?: string;

    idProducto?: number | null;
    id_producto?: number | null;

    idCategoria?: number;
    id_categoria?: number;

    idProveedor?: number;
    id_proveedor?: number;

    nombre?: string;

    precioVenta?: number | null;
    precio_venta?: number | null;

    stockActual?: number | null;
    stock_actual?: number | null;

    stockMinimo?: number | null;
    stock_minimo?: number | null;

    unidadMedida?: string | null;
    unidad_medida?: string | null;
};

const COMMAND_NAME = "proveedores.createProducto";
const COMMAND_ALIASES = [
    COMMAND_NAME,
    "proveedores.create_producto",
    "proveedores_create_producto",
];

function s(v: unknown): string {
    return String(v ?? "").trim();
}

function trimOrNull(v: unknown): string | null {
    const out = s(v);
    return out ? out : null;
}

function numOrNull(v: unknown): number | null {
    if (v == null || s(v) === "") return null;

    const n = Number(v);
    return Number.isFinite(n) ? n : null;
}

function resolveOpId(req: Request, input: any, opIdFromBody: string): string {
    const fromBody = s(opIdFromBody || input?.op_id || input?.opId);
    if (fromBody) return fromBody;

    const fromHeader = s(req.headers.get("X-Idempotency-Key"));
    if (fromHeader) return fromHeader;

    return "";
}

function validateCommandName(req: Request): Response | null {
    const raw = s(req.headers.get("X-Command-Name"));
    if (!raw) return null;

    if (!COMMAND_ALIASES.includes(raw)) {
        return json(
            {
                ok: false,
                error: "bad_command_name",
                expected: COMMAND_NAME,
                got: raw,
            },
            409,
            req,
        );
    }

    return null;
}

function buildCloudPayload(params: {
    opId: string;
    commandName: string;
    args: Record<string, any>;
}) {
    return {
        op_id: params.opId,
        command_name: params.commandName,
        args: params.args,
    };
}

async function nextTableId(
    db: Client,
    table: string,
    column: string,
): Promise<number> {
    const r = await db.execute({
        sql: `SELECT COALESCE(MAX(${column}), 0) + 1 AS next_id FROM ${table};`,
        args: [],
    });

    const n = Number((r.rows?.[0] as any)?.next_id ?? 1);
    return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 1;
}

export async function handleProveedoresCreateProducto(
    req: Request,
    env: any,
    dbCentral: Client,
): Promise<Response> {
    try {
        const commandError = validateCommandName(req);
        if (commandError) return commandError;

        const ctx: any = await buildTenantContext(
            req,
            env,
            dbCentral,
            createDbClient,
        );

        const tenantId = getTenantIdFromContext(ctx);
        if (!tenantId) {
            return unauthorized(req, "invalid_token_claims");
        }

        const db: Client = ctx.dbTenant;

        const { input, opId: bodyOpId } =
            await readWriteRequest<ProductoCreateInput>(req, {});

        const opId = resolveOpId(req, input, bodyOpId);
        if (!opId) {
            return json({ ok: false, error: "missing_op_id" }, 400, req);
        }

        const requestedIdProductoRaw =
            input?.idProducto ?? input?.id_producto ?? null;

        const requestedIdProducto =
            requestedIdProductoRaw == null
                ? null
                : Number(requestedIdProductoRaw);

        if (
            requestedIdProducto !== null &&
            (!Number.isFinite(requestedIdProducto) || requestedIdProducto <= 0)
        ) {
            return json({ ok: false, error: "id_producto_invalido" }, 400, req);
        }

        const idCategoria = Number(input?.idCategoria ?? input?.id_categoria ?? 0);
        const idProveedor = Number(input?.idProveedor ?? input?.id_proveedor ?? 0);
        const nombre = s(input?.nombre);

        if (!nombre) {
            return json({ ok: false, error: "nombre_producto_vacio" }, 400, req);
        }

        if (!Number.isFinite(idCategoria) || idCategoria <= 0) {
            return json({ ok: false, error: "id_categoria_invalido" }, 400, req);
        }

        if (!Number.isFinite(idProveedor) || idProveedor <= 0) {
            return json({ ok: false, error: "id_proveedor_invalido" }, 400, req);
        }

        const precioVenta = numOrNull(input?.precioVenta ?? input?.precio_venta);
        const stockActual = numOrNull(input?.stockActual ?? input?.stock_actual);
        const stockMinimo = numOrNull(input?.stockMinimo ?? input?.stock_minimo);
        const unidadMedida = trimOrNull(
            input?.unidadMedida ?? input?.unidad_medida,
        );

        if (precioVenta !== null && precioVenta < 0) {
            return json({ ok: false, error: "precio_venta_invalido" }, 400, req);
        }

        if (stockActual !== null && stockActual < 0) {
            return json({ ok: false, error: "stock_actual_invalido" }, 400, req);
        }

        if (stockMinimo !== null && stockMinimo < 0) {
            return json({ ok: false, error: "stock_minimo_invalido" }, 400, req);
        }

        const idProducto =
            requestedIdProducto ??
            (await nextTableId(db, "Productos", "ID_Producto"));

        const requestArgs = {
            id_producto: requestedIdProducto,
            id_categoria: Math.trunc(idCategoria),
            id_proveedor: Math.trunc(idProveedor),
            nombre,
            precio_venta: precioVenta,
            stock_actual: stockActual,
            stock_minimo: stockMinimo,
            unidad_medida: unidadMedida,
        };

        const cloudArgs = {
            id_producto: idProducto,
            id_categoria: Math.trunc(idCategoria),
            id_proveedor: Math.trunc(idProveedor),
            nombre,
            precio_venta: precioVenta,
            stock_actual: stockActual,
            stock_minimo: stockMinimo,
            unidad_medida: unidadMedida,
        };

        const steps: TxStep[] = [
            {
                kind: "execute",
                sql: `
					INSERT INTO Productos (
						ID_Producto,
						ID_Categoria,
						ID_Proveedor,
						Nombre,
						Precio_Venta,
						Stock_Minimo,
						Unidad_Medida,
						Nombre_Imagen,
						Ruta_Imagen,
						Cantidad_Pedido_Esperada
					)
					VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, NULL, NULL, NULL)
					ON CONFLICT(ID_Producto) DO UPDATE SET
						ID_Categoria = excluded.ID_Categoria,
						ID_Proveedor = excluded.ID_Proveedor,
						Nombre = excluded.Nombre,
						Precio_Venta = excluded.Precio_Venta,
						Stock_Minimo = excluded.Stock_Minimo,
						Unidad_Medida = excluded.Unidad_Medida;
				`,
                args: [
                    idProducto,
                    Math.trunc(idCategoria),
                    Math.trunc(idProveedor),
                    nombre,
                    precioVenta,
                    stockMinimo,
                    unidadMedida,
                ],
            },
            {
                kind: "value",
                saveAs: "id_producto",
                sql: `SELECT ?1 AS id_producto;`,
                args: [idProducto],
            },
        ];

        if (stockActual !== null && stockActual > 0) {
            steps.push({
                kind: "execute",
                sql: `
					INSERT OR IGNORE INTO Lotes_Producto (
						ID_Producto,
						Codigo_Lote,
						Fecha_Entrada,
						Caducidad,
						Cantidad_Inicial,
						Stock_Disponible,
						Coste_Unitario,
						ID_Proveedor,
						Notas
					)
					VALUES (
						?1,
						?2,
						datetime('now','localtime'),
						NULL,
						?3,
						?4,
						NULL,
						?5,
						?6
					);
				`,
                args: [
                    idProducto,
                    `INI-${idProducto}`,
                    stockActual,
                    stockActual,
                    Math.trunc(idProveedor),
                    "Lote inicial creado desde Proveedores",
                ],
            });
        }

        const txPayload = {
            env,
            tenantId,
            opId,
            commandName: COMMAND_NAME,
            deviceId: getDeviceIdFromContext(ctx),
            requestPayload: requestArgs,
            cloudPayload: buildCloudPayload({
                opId,
                commandName: COMMAND_NAME,
                args: cloudArgs,
            }),
            beginMode: "immediate" as const,
            steps,
            resultKey: "id_producto",
        };

        const resultId = await applyTenantHubTransaction<number>(txPayload);

        return json(
            {
                ok: true,
                data: {
                    id_producto: Number(resultId || idProducto),
                },
                result: {
                    id_producto: Number(resultId || idProducto),
                },
            },
            200,
            req,
        );
    } catch (e: any) {
        return serverError(req, "internal_error", String(e?.message || e));
    }
}