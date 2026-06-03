// src/features/InventaryComponents/api/inventarioAPI.ts
//
// API de inventario — Local-First puro (invokeClient vía @tpv/client). Sustituye dualCall/
// op_id/outbox/afterRemoteOk/remote-id. Se conservan tipos, normalizadores y la superficie
// del objeto exportado `inventarioAPI` (mismos métodos, firmas y tipos de retorno).

import { invokeClient } from "@tpv/client";

/** =========================
 *  Tipos frontend
 *  ========================= */

// ─── Categorías ───
export type CategoriaRow = {
    ID_Categoria: number;
    Nombre: string;
    Nombre_Imagen: string;
    Ruta_Imagen: string;
    Vendible?: number | boolean;
    Pasa_Cocina?: number | boolean;
};

export type ProveedorMiniRow = {
    ID_Proveedor: number;
    Nombre_Empresa: string;
    Email: string | null;
};

// ─── Productos ───
export type ProductoRow = {
    ID_Producto: number;
    ID_Categoria: number;
    ID_Proveedor: number | null;

    Nombre: string;
    Precio_Venta: number | null;

    Stock_Minimo: number | null;
    Unidad_Medida: string | null;

    Nombre_Imagen: string | null;
    Ruta_Imagen: string | null;

    Cantidad_Pedido_Esperada: number | null;
};

export type ProductoListRow = ProductoRow & {
    Stock_Actual: number | null;
    Caducidad_Proxima: string | null;
    Lote_Proximo: string | null;
};

// ─── Lotes ───
export type LoteRow = {
    ID_Lote: number;
    ID_Producto: number;

    Codigo_Lote: string;

    Fecha_Entrada: string;
    Caducidad: string | null;

    Cantidad_Inicial: number;
    Stock_Disponible: number;

    Coste_Unitario: number | null;
    ID_Proveedor: number | null;

    Notas: string | null;
};

// ─── Resumen ───
export type ProductoResumen = {
    Nombre: string;
    Stock_Actual: number | null;
    Unidad_Medida: string | null;

    Caducidad_Proxima: string | null;
    Lote: string | null;

    Precio_Venta: number | null;
};

// ─── Alérgenos ───
export type AlergenoRow = {
    ID_Alergeno: number;
    Nombre: string;
    Nombre_Imagen: string | null;
    Ruta_Imagen: string | null;
};

export type ProductoDetalle = ProductoRow & {
    alergs: Array<Pick<AlergenoRow, "ID_Alergeno" | "Nombre" | "Ruta_Imagen">>;
};

// ─── Inputs frontend ───
export type CreateCategoriaArgs = {
    nombre: string;
    nombre_imagen: string;
    ruta_imagen: string;
    vendible: boolean;
    pasa_cocina: boolean;
};

export type UpsertProductoArgs = {
    id_producto?: number;

    id_categoria: number;
    id_proveedor: number | null;

    nombre: string;

    precio_venta: number | null;

    stock_minimo: number | null;
    unidad_medida: string | null;

    nombre_imagen: string | null;
    ruta_imagen: string | null;

    cantidad_pedido_esperada: number | null;

    ids_alergenos: number[];
};

export type CreateLoteArgs = {
    id_producto: number;
    codigo_lote: string;

    caducidad: string | null;
    cantidad_inicial: number;

    stock_disponible?: number | null;

    fecha_entrada?: string | null;
    coste_unitario?: number | null;
    id_proveedor?: number | null;
    notas?: string | null;
};

export type AjusteLoteArgs = {
    id_lote: number;
    stock_disponible: number;
    notas?: string | null;
};

/** =========================
 * Helpers normalización
 * ========================= */

function toNum(v: any, fallback = 0): number {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
}

function toNumOrNull(v: any): number | null {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
}

function toPositiveIntOrNull(v: any): number | null {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? Math.trunc(n) : null;
}

function toStr(v: any, fallback = ""): string {
    const s = String(v ?? "").trim();
    return s ? s : fallback;
}

function toStrOrNull(v: any): string | null {
    const s = String(v ?? "").trim();
    return s ? s : null;
}

function pick<T = any>(obj: any, keys: string[], fallback?: any): T {
    for (const k of keys) {
        if (obj && Object.prototype.hasOwnProperty.call(obj, k)) {
            return obj[k] as T;
        }
    }
    return fallback as T;
}

function normalizeIdList(values: any[]): number[] {
    const ids = (values ?? []).map(toNum).filter((n) => n > 0);
    ids.sort((a, b) => a - b);
    return Array.from(new Set(ids));
}

function extractRemoteNumber(data: any, keys: string[]): number | null {
    if (typeof data === "number" && Number.isFinite(data) && data > 0) {
        return Math.trunc(data);
    }

    const candidates = [
        data,
        data?.result,
        data?.data,
        data?.row,
        data?.item,
        data?.created,
        data?.updated,
        data?.categoria,
        data?.producto,
        data?.lote,
    ];

    for (const candidate of candidates) {
        if (!candidate || typeof candidate !== "object") continue;
        const value = pick<any>(candidate, keys, undefined);
        const n = Number(value);
        if (Number.isFinite(n) && n > 0) {
            return Math.trunc(n);
        }
    }

    return null;
}

function extractProductoId(raw: any): number | null {
    return extractRemoteNumber(raw, ["id_producto", "idProducto", "ID_Producto"]);
}

/** =========================
 * Normalizadores backend -> frontend
 * ========================= */

function normalizeCategoria(row: any): CategoriaRow {
    return {
        ID_Categoria: toNum(
            pick(row, ["ID_Categoria", "id_categoria", "idCategoria"]),
            0,
        ),
        Nombre: toStr(pick(row, ["Nombre", "nombre"]), "—"),
        Nombre_Imagen: toStr(
            pick(row, ["Nombre_Imagen", "nombre_imagen", "nombreImagen"]),
            "",
        ),
        Ruta_Imagen: toStr(
            pick(row, ["Ruta_Imagen", "ruta_imagen", "rutaImagen"]),
            "",
        ),
        Vendible: pick(row, ["Vendible", "vendible"], undefined),
        Pasa_Cocina: pick(row, ["Pasa_Cocina", "pasa_cocina"], undefined),
    };
}

function normalizeProveedorMini(row: any): ProveedorMiniRow {
    return {
        ID_Proveedor: toNum(
            pick(row, ["ID_Proveedor", "id_proveedor", "idProveedor"]),
            0,
        ),
        Nombre_Empresa: toStr(
            pick(row, ["Nombre_Empresa", "nombre_empresa", "nombreEmpresa"]),
            "—",
        ),
        Email: toStrOrNull(pick(row, ["Email", "email"])),
    };
}

function normalizeProductoBase(row: any): ProductoRow {
    return {
        ID_Producto: toNum(
            pick(row, ["ID_Producto", "id_producto", "idProducto"]),
            0,
        ),
        ID_Categoria: toNum(
            pick(row, ["ID_Categoria", "id_categoria", "idCategoria"]),
            0,
        ),
        ID_Proveedor: toPositiveIntOrNull(
            pick(row, ["ID_Proveedor", "id_proveedor", "idProveedor"], null),
        ),
        Nombre: toStr(pick(row, ["Nombre", "nombre"]), "—"),
        Precio_Venta: toNumOrNull(
            pick(row, ["Precio_Venta", "precio_venta", "precioVenta"]),
        ),
        Stock_Minimo: toNumOrNull(
            pick(row, ["Stock_Minimo", "stock_minimo", "stockMinimo"]),
        ),
        Unidad_Medida: toStrOrNull(
            pick(row, ["Unidad_Medida", "unidad_medida", "unidadMedida"]),
        ),
        Nombre_Imagen: toStrOrNull(
            pick(row, ["Nombre_Imagen", "nombre_imagen", "nombreImagen"]),
        ),
        Ruta_Imagen: toStrOrNull(
            pick(row, ["Ruta_Imagen", "ruta_imagen", "rutaImagen"]),
        ),
        Cantidad_Pedido_Esperada: toNumOrNull(
            pick(row, [
                "Cantidad_Pedido_Esperada",
                "cantidad_pedido_esperada",
                "cantidadPedidoEsperada",
            ]),
        ),
    };
}

function normalizeProductoList(row: any): ProductoListRow {
    const base = normalizeProductoBase(row);

    return {
        ...base,
        Stock_Actual: toNumOrNull(
            pick(row, ["Stock_Actual", "stock_actual", "stockActual"]),
        ),
        Caducidad_Proxima: toStrOrNull(
            pick(row, [
                "Caducidad_Proxima",
                "caducidad_proxima",
                "caducidadProxima",
            ]),
        ),
        Lote_Proximo: toStrOrNull(
            pick(row, ["Lote_Proximo", "lote_proximo", "loteProximo"]),
        ),
    };
}

function normalizeResumen(row: any): ProductoResumen {
    return {
        Nombre: toStr(pick(row, ["Nombre", "nombre"]), "—"),
        Stock_Actual: toNumOrNull(
            pick(row, [
                "Stock_Actual",
                "stock_actual",
                "stockActual",
                "Stock_Disponible",
                "stock_disponible",
                "stockDisponible",
            ]),
        ),
        Unidad_Medida: toStrOrNull(
            pick(row, ["Unidad_Medida", "unidad_medida", "unidadMedida"]),
        ),
        Caducidad_Proxima: toStrOrNull(
            pick(row, [
                "Caducidad_Proxima",
                "caducidad_proxima",
                "caducidadProxima",
                "Caducidad",
                "caducidad",
            ]),
        ),
        Lote: toStrOrNull(
            pick(row, ["Lote", "lote", "Codigo_Lote", "codigo_lote", "codigoLote"]),
        ),
        Precio_Venta: toNumOrNull(
            pick(row, ["Precio_Venta", "precio_venta", "precioVenta"]),
        ),
    };
}

function normalizeAlergeno(row: any): AlergenoRow {
    return {
        ID_Alergeno: toNum(
            pick(row, ["ID_Alergeno", "id_alergeno", "idAlergeno"]),
            0,
        ),
        Nombre: toStr(pick(row, ["Nombre", "nombre"]), "—"),
        Nombre_Imagen: toStrOrNull(
            pick(row, ["Nombre_Imagen", "nombre_imagen", "nombreImagen"]),
        ),
        Ruta_Imagen: toStrOrNull(
            pick(row, ["Ruta_Imagen", "ruta_imagen", "rutaImagen"]),
        ),
    };
}

function normalizeLote(row: any): LoteRow {
    return {
        ID_Lote: toNum(pick(row, ["ID_Lote", "id_lote", "idLote"]), 0),
        ID_Producto: toNum(
            pick(row, ["ID_Producto", "id_producto", "idProducto"]),
            0,
        ),
        Codigo_Lote: toStr(
            pick(row, ["Codigo_Lote", "codigo_lote", "codigoLote"]),
            "",
        ),
        Fecha_Entrada: toStr(
            pick(row, ["Fecha_Entrada", "fecha_entrada", "fechaEntrada"]),
            "",
        ),
        Caducidad: toStrOrNull(pick(row, ["Caducidad", "caducidad"])),
        Cantidad_Inicial: toNum(
            pick(row, ["Cantidad_Inicial", "cantidad_inicial", "cantidadInicial"]),
            0,
        ),
        Stock_Disponible: toNum(
            pick(row, ["Stock_Disponible", "stock_disponible", "stockDisponible"]),
            0,
        ),
        Coste_Unitario: toNumOrNull(
            pick(row, ["Coste_Unitario", "coste_unitario", "costeUnitario"]),
        ),
        ID_Proveedor: toPositiveIntOrNull(
            pick(row, ["ID_Proveedor", "id_proveedor", "idProveedor"], null),
        ),
        Notas: toStrOrNull(pick(row, ["Notas", "notas"])),
    };
}

/** =========================
 * API
 * ========================= */

export const inventarioAPI = {
    async listCategorias(): Promise<CategoriaRow[]> {
        const rows = await invokeClient<any[]>("inventario_list_categorias");
        return (rows ?? []).map(normalizeCategoria);
    },

    async createCategoria(args: CreateCategoriaArgs): Promise<void> {
        await invokeClient("inventario_create_categoria", {
            args: {
                nombre: toStr(args.nombre),
                nombre_imagen: toStr(args.nombre_imagen),
                ruta_imagen: toStr(args.ruta_imagen),
                vendible: !!args.vendible,
                pasa_cocina: !!args.pasa_cocina,
            },
        });
    },

    async listProveedoresMini(): Promise<ProveedorMiniRow[]> {
        const rows = await invokeClient<any[]>("inventario_list_proveedores_mini");
        return (rows ?? []).map(normalizeProveedorMini);
    },

    async listProductosByCategoria(
        id_categoria: number,
    ): Promise<ProductoListRow[]> {
        const rows = await invokeClient<any[]>(
            "inventario_list_productos_by_categoria",
            { args: { id_categoria: toNum(id_categoria) } },
        );
        return (rows ?? []).map(normalizeProductoList);
    },

    async deleteProducto(id_producto: number): Promise<void> {
        await invokeClient("inventario_delete_producto", {
            args: { id_producto: toNum(id_producto) },
        });
    },

    async upsertProducto(args: UpsertProductoArgs): Promise<number | null> {
        const domainArgs = {
            ...(args.id_producto == null
                ? {}
                : { id_producto: toNum(args.id_producto) }),

            id_categoria: toNum(args.id_categoria),
            id_proveedor:
                args.id_proveedor == null ? null : toNum(args.id_proveedor),

            nombre: toStr(args.nombre),

            precio_venta:
                args.precio_venta == null ? null : toNumOrNull(args.precio_venta),

            stock_minimo:
                args.stock_minimo == null ? null : toNumOrNull(args.stock_minimo),

            unidad_medida: toStrOrNull(args.unidad_medida),

            nombre_imagen: toStrOrNull(args.nombre_imagen),
            ruta_imagen: toStrOrNull(args.ruta_imagen),

            cantidad_pedido_esperada:
                args.cantidad_pedido_esperada == null
                    ? null
                    : toNumOrNull(args.cantidad_pedido_esperada),

            ids_alergenos: normalizeIdList(args.ids_alergenos ?? []),
        };

        const raw = await invokeClient<any>("inventario_upsert_producto", {
            args: domainArgs,
        });
        return extractProductoId(raw);
    },

    async getResumen(): Promise<{
        proximos: ProductoResumen[];
        menos: ProductoResumen[];
    }> {
        const data = await invokeClient<any>("inventario_get_resumen", {
            args: {},
        });

        const proximosRaw = pick<any[]>(
            data,
            ["proximos", "proximosCaducar", "proximos_caducar"],
            [],
        );
        const menosRaw = pick<any[]>(
            data,
            ["menos", "menosCantidad", "menos_cantidad"],
            [],
        );

        return {
            proximos: (proximosRaw ?? []).map(normalizeResumen),
            menos: (menosRaw ?? []).map(normalizeResumen),
        };
    },

    async listAlergenos(): Promise<AlergenoRow[]> {
        const rows = await invokeClient<any[]>("inventario_list_alergenos");
        return (rows ?? []).map(normalizeAlergeno);
    },

    async getAlergenosProducto(id_producto: number): Promise<number[]> {
        const data = await invokeClient<any[]>(
            "inventario_get_alergenos_producto",
            { args: { id_producto: toNum(id_producto) } },
        );

        if (Array.isArray(data) && typeof data[0] === "number") {
            return normalizeIdList(data);
        }

        return (data ?? [])
            .map((row) =>
                toNum(pick(row, ["ID_Alergeno", "id_alergeno", "idAlergeno"]), 0),
            )
            .filter((id) => id > 0);
    },

    async setAlergenosProducto(
        id_producto: number,
        ids_alergenos: number[],
    ): Promise<void> {
        await invokeClient("inventario_set_alergenos_producto", {
            args: {
                id_producto: toNum(id_producto),
                ids_alergenos: normalizeIdList(ids_alergenos ?? []),
            },
        });
    },

    async getProductoDetalle(id_producto: number): Promise<ProductoDetalle> {
        const data = await invokeClient<any>("inventario_get_product_detail", {
            args: { id_producto: toNum(id_producto) },
        });

        const prodRaw = pick<any>(data, ["producto"], null);
        if (!prodRaw) {
            throw new Error("Producto no encontrado");
        }

        const alergenosRaw = pick<any[]>(data, ["alergenos"], []);
        const alergs = (alergenosRaw ?? []).map(normalizeAlergeno).map((a) => ({
            ID_Alergeno: a.ID_Alergeno,
            Nombre: a.Nombre,
            Ruta_Imagen: a.Ruta_Imagen,
        }));

        return {
            ...normalizeProductoBase(prodRaw),
            alergs,
        };
    },

    async listLotesByProducto(id_producto: number): Promise<LoteRow[]> {
        const rows = await invokeClient<any[]>(
            "inventario_list_lotes_by_producto",
            { args: { id_producto: toNum(id_producto) } },
        );
        return (rows ?? []).map(normalizeLote);
    },

    async createLote(args: CreateLoteArgs): Promise<void> {
        await invokeClient("inventario_create_lote", {
            args: {
                id_producto: toNum(args.id_producto),
                codigo_lote: toStr(args.codigo_lote),

                caducidad: toStrOrNull(args.caducidad),
                cantidad_inicial: toNum(args.cantidad_inicial),

                ...(args.stock_disponible == null
                    ? {}
                    : { stock_disponible: toNum(args.stock_disponible) }),

                fecha_entrada: toStrOrNull(args.fecha_entrada),
                coste_unitario:
                    args.coste_unitario == null
                        ? null
                        : toNumOrNull(args.coste_unitario),
                id_proveedor:
                    args.id_proveedor == null ? null : toNum(args.id_proveedor),
                notas: toStrOrNull(args.notas),
            },
        });
    },

    async ajustarLote(args: AjusteLoteArgs): Promise<void> {
        await invokeClient("inventario_ajustar_lote", {
            args: {
                id_lote: toNum(args.id_lote),
                stock_disponible: toNum(args.stock_disponible),
                notas: toStrOrNull(args.notas),
            },
        });
    },
};
