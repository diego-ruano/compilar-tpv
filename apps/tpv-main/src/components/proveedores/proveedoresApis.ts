import { invoke } from "@tauri-apps/api/core";
import { dualCall } from "../../net/dualCall";

/* =========================
   Tipos UI
========================= */

export type ProveedorRow = {
    ID_Proveedor: number;
    Nombre_Empresa: string;
    Contacto: string | null;
    Telefono: string | null;
    Email: string | null;
    CIF: string | null;
    Informacion_adicional: string | null;
    Nombre_Imagen: string | null;
    Ruta_Imagen: string | null;
};

export type Categoria = {
    ID_Categoria: number;
    Nombre: string;
    Nombre_Imagen: string | null;
    Ruta_Imagen: string | null;
};

export type ProductoRow = {
    ID_Producto: number;
    ID_Categoria: number | null;
    ID_Proveedor: number | null;
    Nombre: string;
    Precio_Venta: number | null;
    Stock_Actual: number | null;
    Stock_Minimo: number | null;
    Unidad_Medida: string | null;
    Nombre_Imagen: string | null;
    Ruta_Imagen: string | null;

    Cantidad_Pedido_Esperada: number | null;
    Ultima_Entrada: string | null;
    Caducidad_Proxima: string | null;
};

export type ProveedorSaveInput = {
    idProveedor?: number | null;

    nombreEmpresa: string;
    contacto?: string | null;
    telefono?: string | null;
    email?: string | null;
    cif?: string | null;
    informacionAdicional?: string | null;

    nombreImagen?: string | null;
    rutaImagen?: string | null;
};

export type ProductoCreateInput = {
    idCategoria: number;
    idProveedor: number;

    nombre: string;
    precioVenta?: number | null;
    stockActual?: number | null;
    stockMinimo?: number | null;
    unidadMedida?: string | null;
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

/* =========================
   Constantes
========================= */

const COMMANDS = {
    proveedoresSave: "proveedores.save",
    proveedoresDelete: "proveedores.delete",
    proveedoresSetVinculos: "proveedores.setVinculos",
    proveedoresCreateProducto: "proveedores.createProducto",
} as const;

/* =========================
   Helpers
========================= */

function toNum(v: any, fallback = 0): number {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
}

function toNumOrNull(v: any): number | null {
    if (v === null || v === undefined || v === "") return null;

    const n = Number(v);
    return Number.isFinite(n) ? n : null;
}

function toNullableStr(v: any): string | null {
    if (v == null) return null;

    const s = String(v).trim();
    return s ? s : null;
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

function resolveReturnedId(data: any, keys: string[]): number {
    const unwrapped = unwrapMaybeOkEnvelope<any>(data);

    if (typeof unwrapped === "number") {
        return toNum(unwrapped, 0);
    }

    if (unwrapped && typeof unwrapped === "object") {
        for (const k of keys) {
            const n = toNum(unwrapped?.[k], 0);
            if (n > 0) return n;
        }
    }

    return 0;
}

/* =========================
   Helpers Tauri local
========================= */

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

/* =========================
   Mappers
========================= */

function mapProveedor(r: any): ProveedorRow {
    return {
        ID_Proveedor: toNum(
            r?.id_proveedor ?? r?.ID_Proveedor ?? r?.idProveedor,
            0,
        ),
        Nombre_Empresa: String(
            r?.nombre_empresa ?? r?.Nombre_Empresa ?? r?.nombreEmpresa ?? "",
        ),
        Contacto: toNullableStr(r?.contacto ?? r?.Contacto),
        Telefono: toNullableStr(r?.telefono ?? r?.Telefono),
        Email: toNullableStr(r?.email ?? r?.Email),
        CIF: toNullableStr(r?.cif ?? r?.CIF),
        Informacion_adicional: toNullableStr(
            r?.informacion_adicional ??
            r?.Informacion_adicional ??
            r?.informacionAdicional,
        ),
        Nombre_Imagen: toNullableStr(
            r?.nombre_imagen ?? r?.Nombre_Imagen ?? r?.nombreImagen,
        ),
        Ruta_Imagen: toNullableStr(
            r?.ruta_imagen ?? r?.Ruta_Imagen ?? r?.rutaImagen,
        ),
    };
}

function mapCategoria(r: any): Categoria {
    return {
        ID_Categoria: toNum(
            r?.id_categoria ?? r?.ID_Categoria ?? r?.idCategoria,
            0,
        ),
        Nombre: String(r?.nombre ?? r?.Nombre ?? ""),
        Nombre_Imagen: toNullableStr(
            r?.nombre_imagen ?? r?.Nombre_Imagen ?? r?.nombreImagen,
        ),
        Ruta_Imagen: toNullableStr(
            r?.ruta_imagen ?? r?.Ruta_Imagen ?? r?.rutaImagen,
        ),
    };
}

function mapProducto(r: any): ProductoRow {
    return {
        ID_Producto: toNum(
            r?.id_producto ?? r?.ID_Producto ?? r?.idProducto,
            0,
        ),
        ID_Categoria: toNumOrNull(
            r?.id_categoria ?? r?.ID_Categoria ?? r?.idCategoria ?? null,
        ),
        ID_Proveedor: toNumOrNull(
            r?.id_proveedor ?? r?.ID_Proveedor ?? r?.idProveedor ?? null,
        ),
        Nombre: String(r?.nombre ?? r?.Nombre ?? ""),
        Precio_Venta: toNumOrNull(
            r?.precio_venta ?? r?.Precio_Venta ?? r?.precioVenta ?? null,
        ),
        Stock_Actual: toNumOrNull(
            r?.stock_actual ?? r?.Stock_Actual ?? r?.stockActual ?? null,
        ),
        Stock_Minimo: toNumOrNull(
            r?.stock_minimo ?? r?.Stock_Minimo ?? r?.stockMinimo ?? null,
        ),
        Unidad_Medida: toNullableStr(
            r?.unidad_medida ?? r?.Unidad_Medida ?? r?.unidadMedida,
        ),
        Nombre_Imagen: toNullableStr(
            r?.nombre_imagen ?? r?.Nombre_Imagen ?? r?.nombreImagen,
        ),
        Ruta_Imagen: toNullableStr(
            r?.ruta_imagen ?? r?.Ruta_Imagen ?? r?.rutaImagen,
        ),

        Cantidad_Pedido_Esperada: toNumOrNull(
            r?.cantidad_pedido_esperada ??
            r?.Cantidad_Pedido_Esperada ??
            r?.cantidadPedidoEsperada ??
            null,
        ),
        Ultima_Entrada: toNullableStr(
            r?.ultima_entrada ?? r?.Ultima_Entrada ?? r?.ultimaEntrada,
        ),
        Caducidad_Proxima: toNullableStr(
            r?.caducidad_proxima ??
            r?.Caducidad_Proxima ??
            r?.caducidadProxima,
        ),
    };
}

/* =========================
   API lectura
========================= */

export async function proveedoresGetAll(): Promise<ProveedorRow[]> {
    const raw = await dualCall<any[]>(
        {
            path: "/v1/proveedores/all",
            method: "GET",
            unwrapOkEnvelope: true,
        },
        () => invokeLocalRead<any[]>("proveedores_get_all"),
        {
            kind: "read",
            debugTag: "proveedores:getAll",
            fallbackToLocalOnAvailabilityError: true,
        },
    );

    const rows = unwrapMaybeOkEnvelope<any[]>(raw);
    return Array.isArray(rows) ? rows.map(mapProveedor) : [];
}

export async function proveedoresGetProductos(params: {
    idProveedor: number;
}): Promise<ProductoRow[]> {
    const args = {
        id_proveedor: Number(params.idProveedor),
    };

    const raw = await dualCall<any[]>(
        {
            path: "/v1/proveedores/productos",
            method: "POST",
            body: args,
            unwrapOkEnvelope: true,
        },
        () => invokeLocalRead<any[]>("proveedores_get_productos", args),
        {
            kind: "read",
            debugTag: "proveedores:getProductos",
            fallbackToLocalOnAvailabilityError: true,
        },
    );

    const rows = unwrapMaybeOkEnvelope<any[]>(raw);
    return Array.isArray(rows) ? rows.map(mapProducto) : [];
}

export async function proveedoresGetCategorias(): Promise<Categoria[]> {
    const raw = await dualCall<any[]>(
        {
            path: "/v1/proveedores/categorias",
            method: "GET",
            unwrapOkEnvelope: true,
        },
        () => invokeLocalRead<any[]>("proveedores_get_categorias"),
        {
            kind: "read",
            debugTag: "proveedores:getCategorias",
            fallbackToLocalOnAvailabilityError: true,
        },
    );

    const rows = unwrapMaybeOkEnvelope<any[]>(raw);
    return Array.isArray(rows) ? rows.map(mapCategoria) : [];
}

export async function proveedoresGetProductosAll(): Promise<ProductoRow[]> {
    const raw = await dualCall<any[]>(
        {
            path: "/v1/proveedores/productos/all",
            method: "GET",
            unwrapOkEnvelope: true,
        },
        () => invokeLocalRead<any[]>("proveedores_get_productos_all"),
        {
            kind: "read",
            debugTag: "proveedores:getProductosAll",
            fallbackToLocalOnAvailabilityError: true,
        },
    );

    const rows = unwrapMaybeOkEnvelope<any[]>(raw);
    return Array.isArray(rows) ? rows.map(mapProducto) : [];
}

/* =========================
   Escrituras
========================= */

export async function proveedoresSave(
    input: ProveedorSaveInput,
): Promise<boolean> {
    const opId = makeOpId("proveedores_save");

    const args = {
        id_proveedor: input.idProveedor ?? null,

        nombre_empresa: String(input.nombreEmpresa ?? ""),
        contacto: input.contacto ?? null,
        telefono: input.telefono ?? null,
        email: input.email ?? null,
        cif: input.cif ?? null,
        informacion_adicional: input.informacionAdicional ?? null,

        nombre_imagen: input.nombreImagen ?? null,
        ruta_imagen: input.rutaImagen ?? null,
    };

    const raw = await dualCall<any>(
        {
            path: "/v1/proveedores/save",
            method: "POST",
            body: commandBody(opId, COMMANDS.proveedoresSave, args),
            unwrapOkEnvelope: true,
        },
        () =>
            invokeLocalWrite<any>(
                "proveedores_save",
                localWriteArgs(opId, args, true),
            ),
        {
            kind: "write",
            commandName: COMMANDS.proveedoresSave,
            debugTag: "proveedores:save",
            fallbackToLocalOnAvailabilityError: true,
            afterRemoteOk: async (remoteRaw: any) => {
                const returnedId = resolveReturnedId(remoteRaw, [
                    "id_proveedor",
                    "idProveedor",
                    "ID_Proveedor",
                ]);

                const finalId = args.id_proveedor ?? returnedId;

                if (!finalId || finalId <= 0) {
                    throw new Error("remote_id_proveedor_missing");
                }

                await invokeLocalWrite<any>(
                    "proveedores_save",
                    localWriteArgs(
                        opId,
                        {
                            ...args,
                            id_proveedor: finalId,
                        },
                        false,
                    ),
                );
            },
        },
    );

    const data = unwrapMaybeOkEnvelope<any>(raw);
    return typeof data === "boolean" ? data : true;
}

export async function proveedoresDelete(params: {
    idProveedor: number;
}): Promise<boolean> {
    const opId = makeOpId("proveedores_delete");

    const args = {
        id_proveedor: Number(params.idProveedor),
    };

    const raw = await dualCall<any>(
        {
            path: "/v1/proveedores/delete",
            method: "POST",
            body: commandBody(opId, COMMANDS.proveedoresDelete, args),
            unwrapOkEnvelope: true,
        },
        () =>
            invokeLocalWrite<any>(
                "proveedores_delete",
                localWriteArgs(opId, args, true),
            ),
        {
            kind: "write",
            commandName: COMMANDS.proveedoresDelete,
            debugTag: "proveedores:delete",
            fallbackToLocalOnAvailabilityError: true,
            afterRemoteOk: async () => {
                await invokeLocalWrite<any>(
                    "proveedores_delete",
                    localWriteArgs(opId, args, false),
                );
            },
        },
    );

    const data = unwrapMaybeOkEnvelope<any>(raw);
    return typeof data === "boolean" ? data : true;
}

export async function proveedoresSetVinculos(params: {
    idProveedor: number;
    productoIds: number[];
}): Promise<boolean> {
    const opId = makeOpId("proveedores_set_vinculos");

    const args = {
        id_proveedor: Number(params.idProveedor),
        producto_ids: (params.productoIds ?? [])
            .map(Number)
            .filter((n) => Number.isFinite(n) && n > 0),
    };

    const raw = await dualCall<any>(
        {
            path: "/v1/proveedores/set-vinculos",
            method: "POST",
            body: commandBody(opId, COMMANDS.proveedoresSetVinculos, args),
            unwrapOkEnvelope: true,
        },
        () =>
            invokeLocalWrite<any>(
                "proveedores_set_vinculos",
                localWriteArgs(opId, args, true),
            ),
        {
            kind: "write",
            commandName: COMMANDS.proveedoresSetVinculos,
            debugTag: "proveedores:setVinculos",
            fallbackToLocalOnAvailabilityError: true,
            afterRemoteOk: async () => {
                await invokeLocalWrite<any>(
                    "proveedores_set_vinculos",
                    localWriteArgs(opId, args, false),
                );
            },
        },
    );

    const data = unwrapMaybeOkEnvelope<any>(raw);
    return typeof data === "boolean" ? data : true;
}

export async function proveedoresCreateProducto(
    input: ProductoCreateInput,
): Promise<number> {
    const opId = makeOpId("proveedores_create_producto");

    const args = {
        id_producto: null as number | null,

        id_categoria: Number(input.idCategoria),
        id_proveedor: Number(input.idProveedor),
        nombre: String(input.nombre ?? ""),
        precio_venta: input.precioVenta ?? null,
        stock_actual: input.stockActual ?? null,
        stock_minimo: input.stockMinimo ?? null,
        unidad_medida: input.unidadMedida ?? null,
    };

    const raw = await dualCall<any>(
        {
            path: "/v1/proveedores/producto/create",
            method: "POST",
            body: commandBody(opId, COMMANDS.proveedoresCreateProducto, args),
            unwrapOkEnvelope: true,
        },
        () =>
            invokeLocalWrite<any>(
                "proveedores_create_producto",
                localWriteArgs(opId, args, true),
            ),
        {
            kind: "write",
            commandName: COMMANDS.proveedoresCreateProducto,
            debugTag: "proveedores:createProducto",
            fallbackToLocalOnAvailabilityError: true,
            afterRemoteOk: async (remoteRaw: any) => {
                const returnedId = resolveReturnedId(remoteRaw, [
                    "id_producto",
                    "idProducto",
                    "ID_Producto",
                ]);

                if (returnedId <= 0) {
                    throw new Error("remote_id_producto_missing");
                }

                await invokeLocalWrite<any>(
                    "proveedores_create_producto",
                    localWriteArgs(
                        opId,
                        {
                            ...args,
                            id_producto: returnedId,
                        },
                        false,
                    ),
                );
            },
        },
    );

    const data = unwrapMaybeOkEnvelope<any>(raw);

    return resolveReturnedId(data, [
        "id_producto",
        "idProducto",
        "ID_Producto",
    ]);
}