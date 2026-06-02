import type { Client } from "@libsql/client/web";

import { buildTenantContext } from "../../../../middleware/withTenant";
import { createDbClient } from "../../../../db/clients";
import { json, serverError } from "../../../../utils/response";
import {
    applyTenantHubTransaction,
    buildCommandCloudPayload,
    getDeviceIdFromContext,
    getTenantIdFromContext,
    readWriteRequest,
    type TxStep,
} from "../../../../utils/tenantHubWrites";

type UpsertProductoArgs = {
    op_id?: string;
    opId?: string;
    command_name?: string;
    commandName?: string;

    id_producto?: number | null;
    idProducto?: number | null;
    id_categoria?: number;
    idCategoria?: number;
    id_proveedor?: number | null;
    idProveedor?: number | null;
    nombre?: string;
    precio_venta?: number | null;
    precioVenta?: number | null;
    stock_minimo?: number | null;
    stockMinimo?: number | null;
    unidad_medida?: string | null;
    unidadMedida?: string | null;
    nombre_imagen?: string | null;
    nombreImagen?: string | null;
    ruta_imagen?: string | null;
    rutaImagen?: string | null;
    cantidad_pedido_esperada?: number | null;
    cantidadPedidoEsperada?: number | null;
    ids_alergenos?: number[];
    idsAlergenos?: number[];
};

const COMMAND_NAME = "inventario.upsertProducto";
const COMMAND_ALIASES = [
    COMMAND_NAME,
    "inventario.upsert_producto",
    "inventory.upsertProducto",
];

function normalizeText(value: unknown): string {
    return String(value ?? "").trim();
}

function normalizeOptionalText(value: unknown): string | null {
    const t = normalizeText(value);
    return t ? t : null;
}

function normalizeOptionalNumber(value: unknown): number | null {
    if (value === null || value === undefined || value === "") return null;

    const n = Number(value);
    return Number.isFinite(n) ? n : null;
}

function normalizePositiveIntOrNull(value: unknown): number | null {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? Math.trunc(n) : null;
}

function normalizeIds(ids: any): number[] {
    const arr = Array.isArray(ids) ? ids : [];

    const out = arr
        .map((n) => Number(n || 0))
        .filter((n) => Number.isFinite(n) && n > 0)
        .map((n) => Math.trunc(n));

    out.sort((a, b) => a - b);

    return [...new Set(out)];
}

function getHeaderOpId(req: Request): string {
    return normalizeText(req.headers.get("X-Idempotency-Key"));
}

function getHeaderCommandName(req: Request): string {
    return normalizeText(req.headers.get("X-Command-Name"));
}

function getRawBodyOpId(rawBody: any): string {
    return normalizeText(rawBody?.op_id ?? rawBody?.opId);
}

function getRawBodyCommandName(rawBody: any): string {
    return normalizeText(rawBody?.command_name ?? rawBody?.commandName);
}

function assertCommandNameAllowed(commandName: string): boolean {
    return COMMAND_ALIASES.includes(commandName);
}

async function nextProductoId(db: Client): Promise<number> {
    const r = await db.execute({
        sql: `
			SELECT COALESCE(MAX(ID_Producto), 0) + 1 AS next_id
			FROM Productos;
		`,
        args: [],
    });

    const row: any = r.rows?.[0] ?? {};
    const n = Number(row.next_id ?? 1);

    return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 1;
}

export async function handleInventarioUpsertProducto(
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

        const tenantId = getTenantIdFromContext(ctx);
        if (!tenantId) {
            return json({ ok: false, error: "missing_tenant_id" }, 400, req);
        }

        const {
            rawBody,
            input: body,
            opId: bodyOpId,
        } = await readWriteRequest<UpsertProductoArgs>(req, {
            id_producto: null,
            id_categoria: 0,
            id_proveedor: null,
            nombre: "",
            ids_alergenos: [],
        } as any);

        const headerOpId = getHeaderOpId(req);
        const rawBodyOpId = getRawBodyOpId(rawBody);

        if (headerOpId && rawBodyOpId && headerOpId !== rawBodyOpId) {
            return json({ ok: false, error: "op_id_mismatch" }, 409, req);
        }

        const opId = normalizeText(bodyOpId || headerOpId || rawBodyOpId);
        if (!opId) {
            return json({ ok: false, error: "missing_op_id" }, 400, req);
        }

        const headerCommandName = getHeaderCommandName(req);
        const rawBodyCommandName = getRawBodyCommandName(rawBody);

        if (headerCommandName && !assertCommandNameAllowed(headerCommandName)) {
            return json(
                {
                    ok: false,
                    error: "bad_command_name",
                    expected: COMMAND_NAME,
                    got: headerCommandName,
                },
                409,
                req,
            );
        }

        if (rawBodyCommandName && !assertCommandNameAllowed(rawBodyCommandName)) {
            return json(
                {
                    ok: false,
                    error: "bad_command_name",
                    expected: COMMAND_NAME,
                    got: rawBodyCommandName,
                },
                409,
                req,
            );
        }

        const requestedIdProducto = normalizePositiveIntOrNull(
            body?.id_producto ?? body?.idProducto,
        );

        const idProducto =
            requestedIdProducto ?? (await nextProductoId(ctx.dbTenant));

        const idCategoria = Number(body?.id_categoria ?? body?.idCategoria ?? 0);
        if (!Number.isFinite(idCategoria) || idCategoria <= 0) {
            return json({ ok: false, error: "bad_id_categoria" }, 400, req);
        }

        const nombre = normalizeText(body?.nombre);
        if (!nombre) {
            return json({ ok: false, error: "nombre_required" }, 400, req);
        }

        const idsAlergenos = normalizeIds(
            body?.ids_alergenos ?? body?.idsAlergenos,
        );

        const idProveedor = normalizeOptionalNumber(
            body?.id_proveedor ?? body?.idProveedor,
        );

        const precioVenta = normalizeOptionalNumber(
            body?.precio_venta ?? body?.precioVenta,
        );

        const stockMinimo = normalizeOptionalNumber(
            body?.stock_minimo ?? body?.stockMinimo,
        );

        const cantidadPedidoEsperada = normalizeOptionalNumber(
            body?.cantidad_pedido_esperada ?? body?.cantidadPedidoEsperada,
        );

        const unidadMedida = normalizeOptionalText(
            body?.unidad_medida ?? body?.unidadMedida,
        );

        const nombreImagen = normalizeOptionalText(
            body?.nombre_imagen ?? body?.nombreImagen,
        );

        const rutaImagen = normalizeOptionalText(
            body?.ruta_imagen ?? body?.rutaImagen,
        );

        const requestArgs = {
            id_producto: requestedIdProducto,
            id_categoria: idCategoria,
            id_proveedor: idProveedor,
            nombre,
            precio_venta: precioVenta,
            stock_minimo: stockMinimo,
            unidad_medida: unidadMedida,
            nombre_imagen: nombreImagen,
            ruta_imagen: rutaImagen,
            cantidad_pedido_esperada: cantidadPedidoEsperada,
            ids_alergenos: idsAlergenos,
        };

        const cloudArgs = {
            ...requestArgs,
            id_producto: idProducto,
        };

        const steps: TxStep[] = [
            {
                kind: "execute",
                sql: `
					INSERT INTO Productos
						(
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
					VALUES
						(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
					ON CONFLICT(ID_Producto) DO UPDATE SET
						ID_Categoria = excluded.ID_Categoria,
						ID_Proveedor = excluded.ID_Proveedor,
						Nombre = excluded.Nombre,
						Precio_Venta = excluded.Precio_Venta,
						Stock_Minimo = excluded.Stock_Minimo,
						Unidad_Medida = excluded.Unidad_Medida,
						Nombre_Imagen = COALESCE(excluded.Nombre_Imagen, Productos.Nombre_Imagen),
						Ruta_Imagen = COALESCE(excluded.Ruta_Imagen, Productos.Ruta_Imagen),
						Cantidad_Pedido_Esperada = excluded.Cantidad_Pedido_Esperada;
				`,
                args: [
                    idProducto,
                    idCategoria,
                    idProveedor,
                    nombre,
                    precioVenta,
                    stockMinimo,
                    unidadMedida,
                    nombreImagen,
                    rutaImagen,
                    cantidadPedidoEsperada,
                ],
            },
            {
                kind: "execute",
                sql: `DELETE FROM Producto_Alergenos WHERE ID_Producto = ?1;`,
                args: [idProducto],
            },
        ];

        for (const idAlergeno of idsAlergenos) {
            steps.push({
                kind: "execute",
                sql: `
					INSERT OR IGNORE INTO Producto_Alergenos
						(ID_Producto, ID_Alergeno)
					VALUES
						(?1, ?2);
				`,
                args: [idProducto, idAlergeno],
            });
        }

        steps.push({
            kind: "row",
            saveAs: "producto",
            sql: `
				SELECT ID_Producto AS id_producto
				FROM Productos
				WHERE ID_Producto = ?1
				LIMIT 1;
			`,
            args: [idProducto],
        });

        await applyTenantHubTransaction({
            env,
            tenantId,
            opId,
            commandName: COMMAND_NAME,
            deviceId: getDeviceIdFromContext(ctx),

            requestPayload: requestArgs,
            cloudPayload: buildCommandCloudPayload({
                opId,
                commandName: COMMAND_NAME,
                args: cloudArgs,
            }),

            beginMode: "immediate",
            steps,
            resultKey: "producto",
        });

        return json({ ok: true, data: { id_producto: idProducto } }, 200, req);
    } catch (e: any) {
        return serverError(req, "internal_error", String(e?.message || e));
    }
}