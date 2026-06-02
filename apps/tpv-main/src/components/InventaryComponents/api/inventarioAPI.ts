// src/components/inventario/api/inventarioApi.ts
import { invoke } from "@tauri-apps/api/core";
import { dualCall } from "../../../net/dualCall";

/** =========================
 *  Tipos frontend
 *  =========================
 *  - Producto = ficha estable
 *  - Lote = stock real
 */

// ─────────────────────────────────────────────────────────────
// Categorías
// ─────────────────────────────────────────────────────────────

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

// ─────────────────────────────────────────────────────────────
// Productos
// ─────────────────────────────────────────────────────────────

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

// ─────────────────────────────────────────────────────────────
// Lotes
// ─────────────────────────────────────────────────────────────

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

// ─────────────────────────────────────────────────────────────
// Resumen
// ─────────────────────────────────────────────────────────────

export type ProductoResumen = {
    Nombre: string;
    Stock_Actual: number | null;
    Unidad_Medida: string | null;

    Caducidad_Proxima: string | null;
    Lote: string | null;

    Precio_Venta: number | null;
};

// ─────────────────────────────────────────────────────────────
// Alérgenos
// ─────────────────────────────────────────────────────────────

export type AlergenoRow = {
    ID_Alergeno: number;
    Nombre: string;
    Nombre_Imagen: string | null;
    Ruta_Imagen: string | null;
};

export type ProductoDetalle = ProductoRow & {
    alergs: Array<Pick<AlergenoRow, "ID_Alergeno" | "Nombre" | "Ruta_Imagen">>;
};

// ─────────────────────────────────────────────────────────────
// Inputs frontend
// ─────────────────────────────────────────────────────────────

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

type CommandBody<TArgs extends Record<string, any>> = {
    op_id: string;
    command_name: string;
    args: TArgs;
};

type LocalWriteArgs<TArgs extends Record<string, any>> = TArgs & {
    op_id: string;
    enqueue_outbox?: boolean;
};

/** =========================
 * Constantes
 * ========================= */

const COMMANDS = {
    createCategoria: "inventario.createCategoria",
    deleteProducto: "inventario.deleteProducto",
    upsertProducto: "inventario.upsertProducto",
    setAlergenosProducto: "inventario.setAlergenosProducto",
    createLote: "inventario.createLote",
    ajustarLote: "inventario.ajustarLote",
} as const;

const INVENTARIO_REMOTE = {
    listCategorias: {
        path: "/v1/inventario/categorias",
        method: "GET" as const,
    },
    createCategoria: {
        path: "/v1/inventario/categoria/create",
        method: "POST" as const,
    },
    listProveedoresMini: {
        path: "/v1/inventario/proveedores-mini",
        method: "GET" as const,
    },
    listProductosByCategoria: {
        path: "/v1/inventario/productos/by-categoria",
        method: "POST" as const,
    },
    deleteProducto: {
        path: "/v1/inventario/producto/delete",
        method: "POST" as const,
    },
    upsertProducto: {
        path: "/v1/inventario/producto/upsert",
        method: "POST" as const,
    },
    getResumen: {
        path: "/v1/inventario/resumen",
        method: "POST" as const,
    },
    listAlergenos: {
        path: "/v1/inventario/alergenos",
        method: "GET" as const,
    },
    getAlergenosProducto: {
        path: "/v1/inventario/alergenos/by-producto",
        method: "POST" as const,
    },
    setAlergenosProducto: {
        path: "/v1/inventario/alergenos/set-producto",
        method: "POST" as const,
    },
    getProductoDetalle: {
        path: "/v1/inventario/producto/detail",
        method: "POST" as const,
    },
    listLotesByProducto: {
        path: "/v1/inventario/lotes/by-producto",
        method: "POST" as const,
    },
    createLote: {
        path: "/v1/inventario/lote/create",
        method: "POST" as const,
    },
    ajustarLote: {
        path: "/v1/inventario/lote/ajustar",
        method: "POST" as const,
    },
} as const;

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

function makeOpId(scope: string): string {
    const prefix = scope.replace(/[^a-zA-Z0-9_-]/g, "_");

    if (
        typeof crypto !== "undefined" &&
        typeof crypto.randomUUID === "function"
    ) {
        return `${prefix}-${crypto.randomUUID()}`;
    }

    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function commandBody<TArgs extends Record<string, any>>(
    opId: string,
    commandName: string,
    args: TArgs,
): CommandBody<TArgs> {
    return {
        op_id: opId,
        command_name: commandName,
        args,
    };
}

function localWriteArgs<TArgs extends Record<string, any>>(
    opId: string,
    args: TArgs,
    enqueueOutbox = true,
): LocalWriteArgs<TArgs> {
    return {
        op_id: opId,
        ...args,
        enqueue_outbox: enqueueOutbox,
    };
}

function unwrapMaybeOkEnvelope<T>(x: any): T {
    if (!x || typeof x !== "object") return x as T;
    if (!("ok" in x)) return x as T;

    if (!x.ok) {
        const msg = String(x.error ?? x.message ?? "remote_ok_false");
        throw new Error(msg);
    }

    if ("result" in x) return x.result as T;
    if ("user" in x) return x.user as T;
    if ("status" in x) return x.status as T;
    if ("data" in x) return x.data as T;

    return x as T;
}

/** =========================
 * Helpers Tauri local
 * ========================= */

async function invokeLocalRead<T>(
    command: string,
    args?: Record<string, any>,
): Promise<T> {
    if (args === undefined) {
        return await invoke<T>(command);
    }

    return await invoke<T>(command, { args });
}

async function invokeLocalWrite<T>(
    command: string,
    args: Record<string, any>,
): Promise<T> {
    return await invoke<T>(command, { args });
}

/** =========================
 * Helpers respuesta remota
 * ========================= */

function extractRemoteNumber(raw: any, keys: string[]): number | null {
    const data = unwrapMaybeOkEnvelope<any>(raw);

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

function extractCategoriaId(raw: any): number | null {
    return extractRemoteNumber(raw, [
        "id_categoria",
        "idCategoria",
        "ID_Categoria",
    ]);
}

function extractProductoId(raw: any): number | null {
    return extractRemoteNumber(raw, [
        "id_producto",
        "idProducto",
        "ID_Producto",
    ]);
}

function extractLoteId(raw: any): number | null {
    return extractRemoteNumber(raw, ["id_lote", "idLote", "ID_Lote"]);
}

/** =========================
 * Normalizadores backend/local -> frontend
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
            pick(row, [
                "Lote",
                "lote",
                "Codigo_Lote",
                "codigo_lote",
                "codigoLote",
            ]),
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
            pick(row, [
                "Cantidad_Inicial",
                "cantidad_inicial",
                "cantidadInicial",
            ]),
            0,
        ),
        Stock_Disponible: toNum(
            pick(row, [
                "Stock_Disponible",
                "stock_disponible",
                "stockDisponible",
            ]),
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
        const raw = await dualCall<any[]>(
            {
                ...INVENTARIO_REMOTE.listCategorias,
                unwrapOkEnvelope: true,
            },
            () => invokeLocalRead<any[]>("inventario_list_categorias"),
            {
                kind: "read",
                debugTag: "inventario:listCategorias",
                fallbackToLocalOnAvailabilityError: true,
            },
        );

        const rows = unwrapMaybeOkEnvelope<any[]>(raw);
        return (rows ?? []).map(normalizeCategoria);
    },

    async createCategoria(args: CreateCategoriaArgs): Promise<void> {
        const opId = makeOpId("inventario_create_categoria");

        const domainArgs = {
            nombre: toStr(args.nombre),
            nombre_imagen: toStr(args.nombre_imagen),
            ruta_imagen: toStr(args.ruta_imagen),
            vendible: !!args.vendible,
            pasa_cocina: !!args.pasa_cocina,
        };

        const localArgs = localWriteArgs(opId, domainArgs, true);

        await dualCall<any>(
            {
                ...INVENTARIO_REMOTE.createCategoria,
                body: commandBody(opId, COMMANDS.createCategoria, domainArgs),
                unwrapOkEnvelope: true,
            },
            () => invokeLocalWrite("inventario_create_categoria", localArgs),
            {
                kind: "write",
                commandName: COMMANDS.createCategoria,
                debugTag: "inventario:createCategoria",
                fallbackToLocalOnAvailabilityError: true,
                afterRemoteOk: async (remoteResult) => {
                    const idCategoria = extractCategoriaId(remoteResult);

                    if (!idCategoria) {
                        throw new Error("remote_id_categoria_missing");
                    }

                    await invokeLocalWrite("inventario_create_categoria", {
                        ...localArgs,
                        id_categoria: idCategoria,
                        enqueue_outbox: false,
                    });
                },
            },
        );
    },

    async listProveedoresMini(): Promise<ProveedorMiniRow[]> {
        const raw = await dualCall<any[]>(
            {
                ...INVENTARIO_REMOTE.listProveedoresMini,
                unwrapOkEnvelope: true,
            },
            () => invokeLocalRead<any[]>("inventario_list_proveedores_mini"),
            {
                kind: "read",
                debugTag: "inventario:listProveedoresMini",
                fallbackToLocalOnAvailabilityError: true,
            },
        );

        const rows = unwrapMaybeOkEnvelope<any[]>(raw);
        return (rows ?? []).map(normalizeProveedorMini);
    },

    async listProductosByCategoria(
        id_categoria: number,
    ): Promise<ProductoListRow[]> {
        const args = {
            id_categoria: toNum(id_categoria),
        };

        const raw = await dualCall<any[]>(
            {
                ...INVENTARIO_REMOTE.listProductosByCategoria,
                body: args,
                unwrapOkEnvelope: true,
            },
            () =>
                invokeLocalRead<any[]>(
                    "inventario_list_productos_by_categoria",
                    args,
                ),
            {
                kind: "read",
                debugTag: "inventario:listProductosByCategoria",
                fallbackToLocalOnAvailabilityError: true,
            },
        );

        const rows = unwrapMaybeOkEnvelope<any[]>(raw);
        return (rows ?? []).map(normalizeProductoList);
    },

    async deleteProducto(id_producto: number): Promise<void> {
        const opId = makeOpId("inventario_delete_producto");

        const domainArgs = {
            id_producto: toNum(id_producto),
        };

        const localArgs = localWriteArgs(opId, domainArgs, true);

        await dualCall<any>(
            {
                ...INVENTARIO_REMOTE.deleteProducto,
                body: commandBody(opId, COMMANDS.deleteProducto, domainArgs),
                unwrapOkEnvelope: true,
            },
            () => invokeLocalWrite("inventario_delete_producto", localArgs),
            {
                kind: "write",
                commandName: COMMANDS.deleteProducto,
                debugTag: "inventario:deleteProducto",
                fallbackToLocalOnAvailabilityError: true,
                afterRemoteOk: async () => {
                    await invokeLocalWrite("inventario_delete_producto", {
                        ...localArgs,
                        enqueue_outbox: false,
                    });
                },
            },
        );
    },

    async upsertProducto(args: UpsertProductoArgs): Promise<number | null> {
        const opId = makeOpId("inventario_upsert_producto");

        const domainArgs = {
            ...(args.id_producto == null
                ? {}
                : { id_producto: toNum(args.id_producto) }),

            id_categoria: toNum(args.id_categoria),
            id_proveedor:
                args.id_proveedor == null ? null : toNum(args.id_proveedor),

            nombre: toStr(args.nombre),

            precio_venta:
                args.precio_venta == null
                    ? null
                    : toNumOrNull(args.precio_venta),

            stock_minimo:
                args.stock_minimo == null
                    ? null
                    : toNumOrNull(args.stock_minimo),

            unidad_medida: toStrOrNull(args.unidad_medida),

            nombre_imagen: toStrOrNull(args.nombre_imagen),
            ruta_imagen: toStrOrNull(args.ruta_imagen),

            cantidad_pedido_esperada:
                args.cantidad_pedido_esperada == null
                    ? null
                    : toNumOrNull(args.cantidad_pedido_esperada),

            ids_alergenos: normalizeIdList(args.ids_alergenos ?? []),
        };

        const localArgs = localWriteArgs(opId, domainArgs, true);

        let localAfterRemoteProductoId: number | null = null;

        const raw = await dualCall<any>(
            {
                ...INVENTARIO_REMOTE.upsertProducto,
                body: commandBody(opId, COMMANDS.upsertProducto, domainArgs),
                unwrapOkEnvelope: true,
            },
            () => invokeLocalWrite<any>("inventario_upsert_producto", localArgs),
            {
                kind: "write",
                commandName: COMMANDS.upsertProducto,
                debugTag: "inventario:upsertProducto",
                fallbackToLocalOnAvailabilityError: true,
                afterRemoteOk: async (remoteResult) => {
                    const remoteId = extractProductoId(remoteResult);
                    const finalId =
                        remoteId ?? toPositiveIntOrNull(domainArgs.id_producto);

                    if (!finalId) {
                        throw new Error("remote_id_producto_missing");
                    }

                    const localRaw = await invokeLocalWrite<any>(
                        "inventario_upsert_producto",
                        {
                            ...localArgs,
                            id_producto: finalId,
                            enqueue_outbox: false,
                        },
                    );

                    const localData = unwrapMaybeOkEnvelope<any>(localRaw);

                    localAfterRemoteProductoId = toPositiveIntOrNull(
                        pick(
                            localData,
                            ["id_producto", "idProducto", "ID_Producto"],
                            null,
                        ),
                    );
                },
            },
        );

        return extractProductoId(raw) ?? localAfterRemoteProductoId;
    },

    async getResumen(): Promise<{
        proximos: ProductoResumen[];
        menos: ProductoResumen[];
    }> {
        const raw = await dualCall<any>(
            {
                ...INVENTARIO_REMOTE.getResumen,
                body: {},
                unwrapOkEnvelope: true,
            },
            () => invokeLocalRead<any>("inventario_get_resumen", {}),
            {
                kind: "read",
                debugTag: "inventario:getResumen",
                fallbackToLocalOnAvailabilityError: true,
            },
        );

        const data = unwrapMaybeOkEnvelope<any>(raw);

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
        const raw = await dualCall<any[]>(
            {
                ...INVENTARIO_REMOTE.listAlergenos,
                unwrapOkEnvelope: true,
            },
            () => invokeLocalRead<any[]>("inventario_list_alergenos"),
            {
                kind: "read",
                debugTag: "inventario:listAlergenos",
                fallbackToLocalOnAvailabilityError: true,
            },
        );

        const rows = unwrapMaybeOkEnvelope<any[]>(raw);
        return (rows ?? []).map(normalizeAlergeno);
    },

    async getAlergenosProducto(id_producto: number): Promise<number[]> {
        const args = {
            id_producto: toNum(id_producto),
        };

        const raw = await dualCall<any[]>(
            {
                ...INVENTARIO_REMOTE.getAlergenosProducto,
                body: args,
                unwrapOkEnvelope: true,
            },
            () =>
                invokeLocalRead<any[]>(
                    "inventario_get_alergenos_producto",
                    args,
                ),
            {
                kind: "read",
                debugTag: "inventario:getAlergenosProducto",
                fallbackToLocalOnAvailabilityError: true,
            },
        );

        const data = unwrapMaybeOkEnvelope<any[]>(raw);

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
        const opId = makeOpId("inventario_set_alergenos_producto");

        const domainArgs = {
            id_producto: toNum(id_producto),
            ids_alergenos: normalizeIdList(ids_alergenos ?? []),
        };

        const localArgs = localWriteArgs(opId, domainArgs, true);

        await dualCall<any>(
            {
                ...INVENTARIO_REMOTE.setAlergenosProducto,
                body: commandBody(
                    opId,
                    COMMANDS.setAlergenosProducto,
                    domainArgs,
                ),
                unwrapOkEnvelope: true,
            },
            () =>
                invokeLocalWrite(
                    "inventario_set_alergenos_producto",
                    localArgs,
                ),
            {
                kind: "write",
                commandName: COMMANDS.setAlergenosProducto,
                debugTag: "inventario:setAlergenosProducto",
                fallbackToLocalOnAvailabilityError: true,
                afterRemoteOk: async () => {
                    await invokeLocalWrite(
                        "inventario_set_alergenos_producto",
                        {
                            ...localArgs,
                            enqueue_outbox: false,
                        },
                    );
                },
            },
        );
    },

    async getProductoDetalle(id_producto: number): Promise<ProductoDetalle> {
        const args = {
            id_producto: toNum(id_producto),
        };

        const raw = await dualCall<any>(
            {
                ...INVENTARIO_REMOTE.getProductoDetalle,
                body: args,
                unwrapOkEnvelope: true,
            },
            () =>
                invokeLocalRead<any>(
                    "inventario_get_product_detail",
                    args,
                ),
            {
                kind: "read",
                debugTag: "inventario:getProductoDetalle",
                fallbackToLocalOnAvailabilityError: true,
            },
        );

        const data = unwrapMaybeOkEnvelope<any>(raw);

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
        const args = {
            id_producto: toNum(id_producto),
        };

        const raw = await dualCall<any[]>(
            {
                ...INVENTARIO_REMOTE.listLotesByProducto,
                body: args,
                unwrapOkEnvelope: true,
            },
            () =>
                invokeLocalRead<any[]>(
                    "inventario_list_lotes_by_producto",
                    args,
                ),
            {
                kind: "read",
                debugTag: "inventario:listLotesByProducto",
                fallbackToLocalOnAvailabilityError: true,
            },
        );

        const rows = unwrapMaybeOkEnvelope<any[]>(raw);
        return (rows ?? []).map(normalizeLote);
    },

    async createLote(args: CreateLoteArgs): Promise<void> {
        const opId = makeOpId("inventario_create_lote");

        const domainArgs = {
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
        };

        const localArgs = localWriteArgs(opId, domainArgs, true);

        await dualCall<any>(
            {
                ...INVENTARIO_REMOTE.createLote,
                body: commandBody(opId, COMMANDS.createLote, domainArgs),
                unwrapOkEnvelope: true,
            },
            () => invokeLocalWrite("inventario_create_lote", localArgs),
            {
                kind: "write",
                commandName: COMMANDS.createLote,
                debugTag: "inventario:createLote",
                fallbackToLocalOnAvailabilityError: true,
                afterRemoteOk: async (remoteResult) => {
                    const idLote = extractLoteId(remoteResult);

                    if (!idLote) {
                        throw new Error("remote_id_lote_missing");
                    }

                    await invokeLocalWrite("inventario_create_lote", {
                        ...localArgs,
                        id_lote: idLote,
                        enqueue_outbox: false,
                    });
                },
            },
        );
    },

    async ajustarLote(args: AjusteLoteArgs): Promise<void> {
        const opId = makeOpId("inventario_ajustar_lote");

        const domainArgs = {
            id_lote: toNum(args.id_lote),
            stock_disponible: toNum(args.stock_disponible),
            notas: toStrOrNull(args.notas),
        };

        const localArgs = localWriteArgs(opId, domainArgs, true);

        await dualCall<any>(
            {
                ...INVENTARIO_REMOTE.ajustarLote,
                body: commandBody(opId, COMMANDS.ajustarLote, domainArgs),
                unwrapOkEnvelope: true,
            },
            () => invokeLocalWrite("inventario_ajustar_lote", localArgs),
            {
                kind: "write",
                commandName: COMMANDS.ajustarLote,
                debugTag: "inventario:ajustarLote",
                fallbackToLocalOnAvailabilityError: true,
                afterRemoteOk: async () => {
                    await invokeLocalWrite("inventario_ajustar_lote", {
                        ...localArgs,
                        enqueue_outbox: false,
                    });
                },
            },
        );
    },
};