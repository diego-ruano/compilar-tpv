// src/components/ventaRapida/ventaRapidaAPI.ts
import { invoke } from "@tauri-apps/api/core";
import { dualCall } from "../../net/dualCall";

/* =========================================================
  Tipos
========================================================= */

export type CategoriaRow = {
    ID_Categoria: number;
    Nombre: string;
    Nombre_Imagen: string | null;
    Ruta_Imagen: string | null;
    Vendible?: number | null;
};

export type ProductoRow = {
    ID_Producto: number;
    ID_Categoria: number;
    Nombre: string;

    Precio_Venta: number | null;
    Stock_Actual: number | null;
    Stock_Minimo: number | null;

    Unidad_Medida: string | null;
    Nombre_Imagen: string | null;
    Ruta_Imagen: string | null;
};

export type ComandaBarraRow = {
    ID_Comanda: number;
    Fecha_Hora_Apertura: string;
    Estado: string;

    Total_Pendiente: number;
    Total_Comanda: number;

    Pendientes_Cocina: number;
    Pendientes_Pago: number;
};

export type LineaComandaRow = {
    ID_Detalle: number;
    ID_Comanda: number;
    ID_Producto: number;
    Cantidad: number;
    Precio_Unitario: number;
    Notas: string | null;
    Estado_Cocina?: string | null;
    Pagado?: 0 | 1;
    Nombre: string;
};

export type VerTicketsDetalleRow = {
    ID_Detalle: number;
    ID_Producto: number;
    Nombre: string;
    Cantidad: number;
    Precio_Unitario: number;
    Estado_Cocina: string;
    Pagado: 0 | 1;
    Notas: string | null;
};

export type IndexRow = {
    ID_Comanda: number;
    Productos: string | null;
    NumLineas: number;
    Unidades: number;
};

export type StockItem = {
    productoId: number;
    cantidad: number;
};

export type VrAddLineaComandaResult = {
    ok: boolean;
    idDetalle: number | null;
};

export type VrCobrarFraccionadoResult = {
    ok: boolean;
    idPago: number | null;

    /**
     * Presente cuando el cobro falla por stock insuficiente.
     * El cobro descuenta stock e inserta Lote_Consumos en la misma
     * transacción, así que un fallo de stock implica que NO se creó el pago.
     */
    error?: "insufficient_stock" | string;
    productoId?: number;
    requested?: number;
    available?: number;
};

export type VrBootstrapResult = {
    idComanda: number;
    id_comanda: number;
    categorias: CategoriaRow[];
    lineas: LineaComandaRow[];
};

/* =========================================================
  Constantes
========================================================= */

const COMMANDS = {
    getOrCreateComandaBarra: "comandas.getOrCreateBarra",
    createComandaBarra: "vr.createComandaBarra",
    addLineaComanda: "vr.addLineaComanda",
    removeLastUnpaidLinea: "vr.removeLastUnpaidLinea",
    deleteLineaIfUnpaid: "vr.deleteLineaIfUnpaid",
    updateNotaDetalle: "vr.updateNotaDetalle",
    cobrarFraccionado: "vr.cobrarFraccionado",
    restarStock: "vr.restarStock",
    deleteComandaIfSafe: "vr.deleteComandaIfSafe",
} as const;

/* =========================================================
  Helpers
========================================================= */

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

function unwrapEnvelopeKeepingRoot(x: any): any {
    if (!x || typeof x !== "object") return x;
    if (!("ok" in x)) return x;

    if (!x.ok) {
        const msg = String(x.error ?? x.message ?? "remote_ok_false");
        throw new Error(msg);
    }

    return x;
}

function pick<T = any>(obj: any, keys: string[], fallback?: any): T {
    for (const k of keys) {
        if (obj && Object.prototype.hasOwnProperty.call(obj, k)) {
            return obj[k] as T;
        }
    }

    return fallback as T;
}

function toNum(v: any, fallback = 0): number {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
}

function normalizePositiveIds(values: number[]): number[] {
    return (values ?? [])
        .map(Number)
        .filter((n) => Number.isFinite(n) && n > 0)
        .map((n) => Math.trunc(n));
}

function isOkFromRaw(raw: any): boolean {
    if (typeof raw === "boolean") return raw;

    if (raw && typeof raw === "object") {
        if ("ok" in raw) return Boolean(raw.ok);

        const data = unwrapMaybeOkEnvelope<any>(raw);

        if (typeof data === "boolean") return data;

        if (data && typeof data === "object" && "ok" in data) {
            return Boolean(data.ok);
        }
    }

    return true;
}

function boolResultFromRaw(raw: any, keys: string[] = ["result"]): boolean {
    if (typeof raw === "boolean") return raw;

    const root = unwrapEnvelopeKeepingRoot(raw);
    const data = (() => {
        try {
            return unwrapMaybeOkEnvelope<any>(raw);
        } catch {
            return null;
        }
    })();

    const candidates = [root, root?.result, root?.data, data];

    for (const candidate of candidates) {
        if (typeof candidate === "boolean") return candidate;
        if (typeof candidate === "number") return candidate > 0;
        if (!candidate || typeof candidate !== "object") continue;

        for (const key of keys) {
            if (!Object.prototype.hasOwnProperty.call(candidate, key)) continue;

            const value = candidate[key];
            if (typeof value === "boolean") return value;
            if (typeof value === "number") return value > 0;
            if (typeof value === "string") {
                const clean = value.trim().toLowerCase();
                if (["true", "1", "yes", "si", "sí"].includes(clean)) return true;
                if (["false", "0", "no"].includes(clean)) return false;
            }
        }
    }

    return isOkFromRaw(raw);
}

function extractRemoteNumber(raw: any, keys: string[]): number | null {
    const root = unwrapEnvelopeKeepingRoot(raw);

    const candidates = [
        root,
        root?.result,
        root?.data,
        root?.row,
        root?.item,
        root?.comanda,
        root?.detalle,
        root?.linea,
        root?.pago,
        unwrapMaybeOkEnvelope<any>(raw),
    ];

    for (const candidate of candidates) {
        if (typeof candidate === "number") {
            return Number.isFinite(candidate) && candidate > 0
                ? Math.trunc(candidate)
                : null;
        }

        if (!candidate || typeof candidate !== "object") continue;

        const value = pick<any>(candidate, keys, undefined);
        const n = Number(value);

        if (Number.isFinite(n) && n > 0) {
            return Math.trunc(n);
        }
    }

    return null;
}

function extractComandaId(raw: any): number | null {
    return extractRemoteNumber(raw, [
        "id_comanda",
        "idComanda",
        "ID_Comanda",
    ]);
}

function extractDetalleId(raw: any): number | null {
    return extractRemoteNumber(raw, [
        "id_detalle",
        "idDetalle",
        "ID_Detalle",
    ]);
}

function extractPagoId(raw: any): number | null {
    return extractRemoteNumber(raw, ["id_pago", "idPago", "ID_Pago"]);
}

function asArray<T>(value: any, keys: string[] = []): T[] {
    if (Array.isArray(value)) return value as T[];

    if (value && typeof value === "object") {
        for (const key of keys) {
            const candidate = value[key];
            if (Array.isArray(candidate)) return candidate as T[];
        }

        if (Array.isArray(value.result)) return value.result as T[];
        if (Array.isArray(value.data)) return value.data as T[];
        if (Array.isArray(value.rows)) return value.rows as T[];
        if (Array.isArray(value.items)) return value.items as T[];
    }

    return [];
}

function normalizeBootstrap(raw: any): VrBootstrapResult {
    const data = unwrapMaybeOkEnvelope<any>(raw);
    const root = unwrapEnvelopeKeepingRoot(raw);

    const id =
        extractComandaId(data) ??
        extractComandaId(root) ??
        extractComandaId(raw) ??
        0;

    const categorias =
        asArray<CategoriaRow>(data, ["categorias", "categories"]) ??
        asArray<CategoriaRow>(root, ["categorias", "categories"]);

    const lineas =
        asArray<LineaComandaRow>(data, ["lineas", "lines"]) ??
        asArray<LineaComandaRow>(root, ["lineas", "lines"]);

    return {
        idComanda: id,
        id_comanda: id,
        categorias,
        lineas,
    };
}

function makeOpId(scope: string): string {
    const prefix = scope.replace(/[^a-zA-Z0-9_-]/g, "_");

    if (
        typeof crypto !== "undefined" &&
        typeof crypto.randomUUID === "function"
    ) {
        return `${prefix}-${crypto.randomUUID()}`;
    }

    return `${prefix}-${Date.now()}-${Math.random()
        .toString(36)
        .slice(2, 10)}`;
}

function withOpId<T extends Record<string, any>>(
    scope: string,
    payload: T,
): T & { op_id: string } {
    return {
        ...payload,
        op_id: makeOpId(scope),
    };
}

function withoutOutbox<T extends Record<string, any>>(
    payload: T,
): T & { enqueue_outbox: false } {
    return {
        ...payload,
        enqueue_outbox: false,
    };
}

/* =========================================================
  Tauri local helpers
========================================================= */

async function invokeLocalRead<T>(
    command: string,
    args?: Record<string, any>,
): Promise<T> {
    if (args === undefined) {
        return await invoke<T>(command);
    }

    return await invoke<T>(command, args);
}

async function invokeLocalArgsRead<T>(
    command: string,
    args: Record<string, any>,
): Promise<T> {
    return await invoke<T>(command, { args });
}

async function invokeLocalWrite<T>(
    command: string,
    args: Record<string, any>,
): Promise<T> {
    return await invoke<T>(command, { args });
}

async function invokeLocalWriteWithoutOutbox<T>(
    command: string,
    args: Record<string, any>,
): Promise<T> {
    return await invokeLocalWrite<T>(command, withoutOutbox(args));
}

/* =========================================================
  BOOTSTRAP
========================================================= */

export async function vrBootstrap(
    idTrabajador: number | null,
): Promise<VrBootstrapResult> {
    const args = withOpId("vr_bootstrap", {
        id_trabajador: idTrabajador == null ? null : Number(idTrabajador),
    });

    const raw = await dualCall<any>(
        {
            path: "/v1/vr/bootstrap",
            method: "POST",
            body: args,
            unwrapOkEnvelope: true,
        },
        async () => {
            const idRaw = await invokeLocalWrite<any>(
                "vr_create_comanda_barra",
                args,
            );

            const idComanda = extractComandaId(idRaw) ?? toNum(idRaw, 0);

            if (!(idComanda > 0)) {
                throw new Error("local_bootstrap_id_comanda_missing");
            }

            const [categorias, lineas] = await Promise.all([
                invokeLocalRead<CategoriaRow[]>("vr_list_categorias_vendibles"),
                invokeLocalRead<LineaComandaRow[]>("vr_get_lineas_comanda", {
                    idComanda,
                }),
            ]);

            return {
                id_comanda: idComanda,
                idComanda,
                categorias: categorias ?? [],
                lineas: lineas ?? [],
            };
        },
        {
            kind: "write",
            commandName: COMMANDS.getOrCreateComandaBarra,
            debugTag: "vr:bootstrap",
            fallbackToLocalOnAvailabilityError: true,
            afterRemoteOkMode: "background",
            afterRemoteOk: async (remoteResult) => {
                const data = unwrapMaybeOkEnvelope<any>(remoteResult);
                const remoteId =
                    extractComandaId(data) ?? extractComandaId(remoteResult);

                if (!remoteId) {
                    return;
                }

                await invokeLocalWriteWithoutOutbox<any>(
                    "vr_create_comanda_barra",
                    {
                        ...args,
                        id_comanda: remoteId,
                    },
                );
            },
        },
    );

    const result = normalizeBootstrap(raw);

    if (!(result.idComanda > 0)) {
        throw new Error("bootstrap_id_comanda_missing");
    }

    return result;
}

/* =========================================================
  READS
========================================================= */

export async function vrListCategoriasVendibles(): Promise<CategoriaRow[]> {
    const raw = await dualCall<CategoriaRow[]>(
        {
            path: "/v1/vr/list-categorias-vendibles",
            method: "POST",
            body: {},
            unwrapOkEnvelope: true,
        },
        () => invokeLocalRead<CategoriaRow[]>("vr_list_categorias_vendibles"),
        {
            kind: "read",
            debugTag: "vr:listCategoriasVendibles",
            fallbackToLocalOnAvailabilityError: true,
        },
    );

    return unwrapMaybeOkEnvelope<CategoriaRow[]>(raw) ?? [];
}

export async function vrListProductosByCategoria(
    idCategoria: number,
): Promise<ProductoRow[]> {
    const id_categoria = Number(idCategoria);

    const remoteBody = {
        id_categoria,
    };

    const raw = await dualCall<ProductoRow[]>(
        {
            path: "/v1/vr/list-productos-by-categoria",
            method: "POST",
            body: remoteBody,
            unwrapOkEnvelope: true,
        },
        () =>
            invokeLocalRead<ProductoRow[]>("vr_list_productos_by_categoria", {
                idCategoria: id_categoria,
            }),
        {
            kind: "read",
            debugTag: "vr:listProductosByCategoria",
            fallbackToLocalOnAvailabilityError: true,
        },
    );

    return unwrapMaybeOkEnvelope<ProductoRow[]>(raw) ?? [];
}

export async function vrSearchProductos(
    q: string,
    limit = 60,
): Promise<ProductoRow[]> {
    const query = String(q ?? "").trim();
    const lim = Number(limit);

    if (!query) return [];

    const remoteBody = {
        query,
        limit: lim,
    };

    const raw = await dualCall<ProductoRow[]>(
        {
            path: "/v1/vr/search-productos",
            method: "POST",
            body: remoteBody,
            unwrapOkEnvelope: true,
        },
        () =>
            invokeLocalRead<ProductoRow[]>("vr_search_productos", {
                query,
                limit: lim,
            }),
        {
            kind: "read",
            debugTag: "vr:searchProductos",
            fallbackToLocalOnAvailabilityError: true,
        },
    );

    return unwrapMaybeOkEnvelope<ProductoRow[]>(raw) ?? [];
}

export async function vrListComandasBarra(opts: {
    includePagadas: boolean;
    limit?: number;
}): Promise<ComandaBarraRow[]> {
    const args = {
        include_pagadas: Boolean(opts.includePagadas),
        limit: opts.limit == null ? null : Number(opts.limit),
    };

    const raw = await dualCall<ComandaBarraRow[]>(
        {
            path: "/v1/vr/list-comandas-barra",
            method: "POST",
            body: args,
            unwrapOkEnvelope: true,
        },
        () =>
            invokeLocalArgsRead<ComandaBarraRow[]>(
                "vr_list_comandas_barra",
                args,
            ),
        {
            kind: "read",
            debugTag: "vr:listComandasBarra",
            fallbackToLocalOnAvailabilityError: true,
        },
    );

    return unwrapMaybeOkEnvelope<ComandaBarraRow[]>(raw) ?? [];
}

export async function vrGetLineasComanda(
    idComanda: number,
): Promise<LineaComandaRow[]> {
    const id_comanda = Number(idComanda);

    const remoteBody = {
        id_comanda,
    };

    const raw = await dualCall<LineaComandaRow[]>(
        {
            path: "/v1/vr/get-lineas-comanda",
            method: "POST",
            body: remoteBody,
            unwrapOkEnvelope: true,
        },
        () =>
            invokeLocalRead<LineaComandaRow[]>("vr_get_lineas_comanda", {
                idComanda: id_comanda,
            }),
        {
            kind: "read",
            debugTag: "vr:getLineasComanda",
            fallbackToLocalOnAvailabilityError: true,
        },
    );

    return unwrapMaybeOkEnvelope<LineaComandaRow[]>(raw) ?? [];
}

export async function vrGetIndexRows(idsHoy: number[]): Promise<IndexRow[]> {
    const ids = normalizePositiveIds(idsHoy);

    if (ids.length === 0) return [];

    const body = {
        ids,
    };

    const raw = await dualCall<IndexRow[]>(
        {
            path: "/v1/vr/get-index-rows",
            method: "POST",
            body,
            unwrapOkEnvelope: true,
        },
        () => invokeLocalRead<IndexRow[]>("vr_get_index_rows", body),
        {
            kind: "read",
            debugTag: "vr:getIndexRows",
            fallbackToLocalOnAvailabilityError: true,
        },
    );

    return unwrapMaybeOkEnvelope<IndexRow[]>(raw) ?? [];
}

export async function vrGetDetallesVerTicket(
    idComanda: number,
): Promise<VerTicketsDetalleRow[]> {
    const id_comanda = Number(idComanda);

    const remoteBody = {
        id_comanda,
    };

    const raw = await dualCall<VerTicketsDetalleRow[]>(
        {
            path: "/v1/vr/get-detalles-ver-ticket",
            method: "POST",
            body: remoteBody,
            unwrapOkEnvelope: true,
        },
        () =>
            invokeLocalRead<VerTicketsDetalleRow[]>(
                "vr_get_detalles_ver_ticket",
                {
                    idComanda: id_comanda,
                },
            ),
        {
            kind: "read",
            debugTag: "vr:getDetallesVerTicket",
            fallbackToLocalOnAvailabilityError: true,
        },
    );

    return unwrapMaybeOkEnvelope<VerTicketsDetalleRow[]>(raw) ?? [];
}

/* =========================================================
  WRITES
========================================================= */

export async function vrGetOrCreateComandaBarra(
    idTrabajador: number | null,
): Promise<number> {
    const args = withOpId("comandas_get_or_create_barra", {
        id_trabajador: idTrabajador == null ? null : Number(idTrabajador),
    });

    let localAfterRemoteId: number | null = null;

    const raw = await dualCall<any>(
        {
            path: "/v1/comandas/get-or-create-barra",
            method: "POST",
            body: args,
            unwrapOkEnvelope: true,
        },
        () => invokeLocalWrite<any>("vr_create_comanda_barra", args),
        {
            kind: "write",
            commandName: COMMANDS.getOrCreateComandaBarra,
            debugTag: "vr:getOrCreateComandaBarra",
            fallbackToLocalOnAvailabilityError: true,
            afterRemoteOkMode: "background",
            afterRemoteOk: async (remoteResult) => {
                const remoteId = extractComandaId(remoteResult);

                if (!remoteId) {
                    return;
                }

                const localRaw = await invokeLocalWriteWithoutOutbox<any>(
                    "vr_create_comanda_barra",
                    {
                        ...args,
                        id_comanda: remoteId,
                    },
                );

                localAfterRemoteId =
                    extractComandaId(localRaw) ?? toNum(localRaw, 0);
            },
        },
    );

    const data = unwrapMaybeOkEnvelope<any>(raw);
    const id = extractComandaId(data) ?? localAfterRemoteId ?? toNum(data, 0);

    if (!(id > 0)) {
        throw new Error("remote_id_comanda_missing");
    }

    return id;
}

export async function vrCreateComandaBarra(
    idTrabajador: number | null,
): Promise<number> {
    const args = withOpId("vr_create_comanda_barra", {
        id_trabajador: idTrabajador == null ? null : Number(idTrabajador),
    });

    let localAfterRemoteId: number | null = null;

    const raw = await dualCall<any>(
        {
            path: "/v1/vr/create-comanda-barra",
            method: "POST",
            body: args,
            unwrapOkEnvelope: true,
        },
        () => invokeLocalWrite<any>("vr_create_comanda_barra", args),
        {
            kind: "write",
            commandName: COMMANDS.createComandaBarra,
            debugTag: "vr:createComandaBarra",
            fallbackToLocalOnAvailabilityError: true,
            afterRemoteOkMode: "background",
            afterRemoteOk: async (remoteResult) => {
                const remoteId = extractComandaId(remoteResult);

                const localRaw = await invokeLocalWriteWithoutOutbox<any>(
                    "vr_create_comanda_barra",
                    {
                        ...args,
                        ...(remoteId ? { id_comanda: remoteId } : {}),
                    },
                );

                localAfterRemoteId = extractComandaId(localRaw);
            },
        },
    );

    const data = unwrapMaybeOkEnvelope<any>(raw);
    const id = extractComandaId(data) ?? localAfterRemoteId ?? toNum(data, 0);

    if (!(id > 0)) {
        throw new Error("remote_id_comanda_missing");
    }

    return id;
}

export async function vrAddLineaComanda(
    idComanda: number,
    idProducto: number,
    cantidad: number,
    precioUnitario: number,
): Promise<VrAddLineaComandaResult> {
    const args = withOpId("vr_add_linea_comanda", {
        id_comanda: Number(idComanda),
        id_producto: Number(idProducto),
        cantidad: Number(cantidad),
        precio_unitario: Number(precioUnitario),
    });

    let localAfterRemoteDetalleId: number | null = null;

    const raw = await dualCall<any>(
        {
            path: "/v1/vr/add-linea-comanda",
            method: "POST",
            body: args,
            unwrapOkEnvelope: true,
        },
        () => invokeLocalWrite<any>("vr_add_linea_comanda", args),
        {
            kind: "write",
            commandName: COMMANDS.addLineaComanda,
            debugTag: "vr:addLineaComanda",
            fallbackToLocalOnAvailabilityError: true,
            afterRemoteOkMode: "background",
            afterRemoteOk: async (remoteResult) => {
                const idDetalle = extractDetalleId(remoteResult);

                const localRaw = await invokeLocalWriteWithoutOutbox<any>(
                    "vr_add_linea_comanda",
                    {
                        ...args,
                        ...(idDetalle ? { id_detalle: idDetalle } : {}),
                    },
                );

                localAfterRemoteDetalleId =
                    (extractDetalleId(localRaw) ?? toNum(localRaw, 0)) || null;
            },
        },
    );

    const data = unwrapMaybeOkEnvelope<any>(raw);
    const idDetalle =
        extractDetalleId(raw) ??
        extractDetalleId(data) ??
        localAfterRemoteDetalleId;

    return {
        ok: isOkFromRaw(raw),
        idDetalle,
    };
}

export async function vrRemoveLastUnpaidLinea(
    idComanda: number,
    idProducto: number,
): Promise<boolean> {
    const args = withOpId("vr_remove_last_unpaid_linea", {
        id_comanda: Number(idComanda),
        id_producto: Number(idProducto),
    });

    const raw = await dualCall<any>(
        {
            path: "/v1/vr/remove-last-unpaid-linea",
            method: "POST",
            body: args,
            unwrapOkEnvelope: true,
        },
        () => invokeLocalWrite<any>("vr_remove_last_unpaid_linea", args),
        {
            kind: "write",
            commandName: COMMANDS.removeLastUnpaidLinea,
            debugTag: "vr:removeLastUnpaidLinea",
            fallbackToLocalOnAvailabilityError: true,
            afterRemoteOkMode: "background",
            afterRemoteOk: async (remoteResult) => {
                if (!boolResultFromRaw(remoteResult, ["deleted", "result"])) return;

                await invokeLocalWriteWithoutOutbox<any>(
                    "vr_remove_last_unpaid_linea",
                    args,
                );
            },
        },
    );

    return boolResultFromRaw(raw, ["deleted", "result"]);
}

export async function vrDeleteLineaIfUnpaid(
    idComanda: number,
    idDetalle: number,
): Promise<boolean> {
    const args = withOpId("vr_delete_linea_if_unpaid", {
        id_comanda: Number(idComanda),
        id_detalle: Number(idDetalle),
    });

    const raw = await dualCall<any>(
        {
            path: "/v1/vr/delete-linea-if-unpaid",
            method: "POST",
            body: args,
            unwrapOkEnvelope: true,
        },
        () => invokeLocalWrite<any>("vr_delete_linea_if_unpaid", args),
        {
            kind: "write",
            commandName: COMMANDS.deleteLineaIfUnpaid,
            debugTag: "vr:deleteLineaIfUnpaid",
            fallbackToLocalOnAvailabilityError: true,
            afterRemoteOkMode: "background",
            afterRemoteOk: async (remoteResult) => {
                if (!boolResultFromRaw(remoteResult, ["deleted", "result"])) return;

                await invokeLocalWriteWithoutOutbox<any>(
                    "vr_delete_linea_if_unpaid",
                    args,
                );
            },
        },
    );

    return boolResultFromRaw(raw, ["deleted", "result"]);
}

export async function vrUpdateNotaDetalle(
    idDetalle: number,
    nota: string,
): Promise<boolean> {
    const args = withOpId("vr_update_nota_detalle", {
        id_detalle: Number(idDetalle),
        nota: String(nota ?? ""),
    });

    const raw = await dualCall<any>(
        {
            path: "/v1/vr/update-nota-detalle",
            method: "POST",
            body: args,
            unwrapOkEnvelope: true,
        },
        () => invokeLocalWrite<any>("vr_update_nota_detalle", args),
        {
            kind: "write",
            commandName: COMMANDS.updateNotaDetalle,
            debugTag: "vr:updateNotaDetalle",
            fallbackToLocalOnAvailabilityError: true,
            afterRemoteOkMode: "background",
            afterRemoteOk: async (remoteResult) => {
                if (!boolResultFromRaw(remoteResult, ["updated", "result"])) return;

                await invokeLocalWriteWithoutOutbox<any>(
                    "vr_update_nota_detalle",
                    args,
                );
            },
        },
    );

    return boolResultFromRaw(raw, ["updated", "result"]);
}

/*
  Detecta el error de stock insuficiente que puede llegar:
  - del remoto, como "HTTP 409 { ...insufficient_stock... }"
  - del local (Rust), como "insufficient_stock:productoId:requested:available"
*/
function parseInsufficientStock(
    err: unknown,
): { productoId?: number; requested?: number; available?: number } | null {
    const msg = String((err as any)?.message ?? err ?? "");
    if (!msg.includes("insufficient_stock")) return null;

    const jsonMatch = msg.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
        try {
            const obj = JSON.parse(jsonMatch[0]);
            if (obj && obj.error === "insufficient_stock") {
                return {
                    productoId: Number(obj.productoId ?? obj.producto_id) || undefined,
                    requested: Number(obj.requested) || undefined,
                    available: Number(obj.available) || undefined,
                };
            }
        } catch {
            /* sigue con el formato local */
        }
    }

    const local = msg.match(/insufficient_stock:(\d+):([\d.]+):([\d.]+)/);
    if (local) {
        return {
            productoId: Number(local[1]) || undefined,
            requested: Number(local[2]) || undefined,
            available: Number(local[3]) || undefined,
        };
    }

    return {};
}

export async function vrCobrarFraccionado(argsInput: {
    idComanda: number;
    metodo: "Tarjeta" | "Efectivo";
    importeTotal: number;
    idUsuarioCobrador: number | null;
    idTrabajadorCobrador: number | null;
    detalles: number[];
    opId?: string;
}): Promise<VrCobrarFraccionadoResult> {
    const args = {
        id_comanda: Number(argsInput.idComanda),
        metodo: argsInput.metodo === "Tarjeta" ? "Tarjeta" : "Efectivo",
        importe_total: Number(argsInput.importeTotal),
        id_usuario_cobrador:
            argsInput.idUsuarioCobrador == null
                ? null
                : Number(argsInput.idUsuarioCobrador),
        id_trabajador_cobrador:
            argsInput.idTrabajadorCobrador == null
                ? null
                : Number(argsInput.idTrabajadorCobrador),
        detalles: normalizePositiveIds(argsInput.detalles ?? []),
        op_id: String(argsInput.opId || "").trim() || makeOpId("vr_cobrar_fraccionado"),
    };

    let localAfterRemotePagoId: number | null = null;

    try {
        const raw = await dualCall<any>(
            {
                path: "/v1/vr/cobrar-fraccionado",
                method: "POST",
                body: args,
                unwrapOkEnvelope: true,
            },
            () => invokeLocalWrite<any>("vr_cobrar_fraccionado", args),
            {
                kind: "write",
                commandName: COMMANDS.cobrarFraccionado,
                debugTag: "vr:cobrarFraccionado",
                fallbackToLocalOnAvailabilityError: true,
                afterRemoteOkMode: "background",
                afterRemoteOk: async (remoteResult) => {
                    const idPago = extractPagoId(remoteResult);

                    const localRaw = await invokeLocalWriteWithoutOutbox<any>(
                        "vr_cobrar_fraccionado",
                        {
                            ...args,
                            ...(idPago ? { id_pago: idPago } : {}),
                        },
                    );

                    localAfterRemotePagoId =
                        (extractPagoId(localRaw) ?? toNum(localRaw, 0)) || null;
                },
            },
        );

        const data = unwrapMaybeOkEnvelope<any>(raw);
        const idPago =
            extractPagoId(raw) ?? extractPagoId(data) ?? localAfterRemotePagoId;

        return {
            ok: isOkFromRaw(raw),
            idPago,
        };
    } catch (e) {
        /*
          El cobro descuenta stock en la misma transacción. Si el backend
          (remoto o local) responde insufficient_stock, devolvemos un resultado
          estructurado para que la UI no marque las líneas como cobradas.
        */
        const stock = parseInsufficientStock(e);

        if (stock) {
            return {
                ok: false,
                idPago: null,
                error: "insufficient_stock",
                productoId: stock.productoId,
                requested: stock.requested,
                available: stock.available,
            };
        }

        throw e;
    }
}

export async function vrRestarStock(items: StockItem[], opId?: string): Promise<boolean> {
    const lineas = (items ?? [])
        .map((it) => ({
            producto_id: Number(it.productoId),
            cantidad: Number(it.cantidad),
        }))
        .filter(
            (it) =>
                Number.isFinite(it.producto_id) &&
                it.producto_id > 0 &&
                Number.isFinite(it.cantidad) &&
                it.cantidad > 0,
        );

    if (lineas.length === 0) {
        return true;
    }

    const args = {
        lineas,
        op_id: String(opId || "").trim() || makeOpId("vr_restar_stock"),
    };

    const raw = await dualCall<any>(
        {
            path: "/v1/vr/restar-stock",
            method: "POST",
            body: args,
            unwrapOkEnvelope: true,
        },
        () => invokeLocalWrite<any>("vr_restar_stock", args),
        {
            kind: "write",
            commandName: COMMANDS.restarStock,
            debugTag: "vr:restarStock",
            fallbackToLocalOnAvailabilityError: true,
            afterRemoteOkMode: "background",
            afterRemoteOk: async () => {
                await invokeLocalWriteWithoutOutbox<any>("vr_restar_stock", args);
            },
        },
    );

    return isOkFromRaw(raw);
}

export async function vrDeleteComandaIfSafe(
    idComanda: number,
): Promise<boolean> {
    const args = withOpId("vr_delete_comanda_if_safe", {
        id_comanda: Number(idComanda),
    });

    const raw = await dualCall<any>(
        {
            path: "/v1/vr/delete-comanda-if-safe",
            method: "POST",
            body: args,
            unwrapOkEnvelope: true,
        },
        () => invokeLocalWrite<any>("vr_delete_comanda_if_safe", args),
        {
            kind: "write",
            commandName: COMMANDS.deleteComandaIfSafe,
            debugTag: "vr:deleteComandaIfSafe",
            fallbackToLocalOnAvailabilityError: true,
            afterRemoteOkMode: "background",
            afterRemoteOk: async (remoteResult) => {
                if (!boolResultFromRaw(remoteResult, ["deleted", "result"])) return;

                await invokeLocalWriteWithoutOutbox<any>(
                    "vr_delete_comanda_if_safe",
                    args,
                );
            },
        },
    );

    return boolResultFromRaw(raw, ["deleted", "result"]);
}