import { invoke } from "@tauri-apps/api/core";
import { dualCall } from "../../net/dualCall";
import type { Salon, MesaMeta } from "./types";

/* =========================
   DTOs que usa MesaComandaModal
========================= */

export type CategoriaDTO = {
    ID_Categoria: number;
    Nombre: string;
    Ruta_Imagen: string | null;
};

export type ProductoDTO = {
    ID_Producto: number;
    ID_Categoria: number;
    Nombre: string;
    Precio_Venta: number | null;
    Ruta_Imagen: string | null;
};

export type KitchenRow = {
    ID_Comanda: number;
    ID_Detalle: number;
    Cantidad: number;
    Nombre_Producto: string;
    Notas: string | null;
    Estado_Cocina: "PENDIENTE" | "PREPARADO" | string;
    Pagado: 0 | 1;
    Numero_Mesa: string | null;
    Fecha_Hora_Apertura: string | null;
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
    mesasSaveLayout: "mesas.saveLayout",

    reservasSetEstado: "reservas.setEstado",

    comandasAbrir: "comandas.abrir",
    comandasAddLinea: "comandas.addLinea",
    comandasSetTrabajadorIfNull: "comandas.setTrabajadorIfNull",

    ticketRemoveOnePending: "ticket.removeOnePending",
    ticketDeleteDetalle: "ticket.deleteDetalle",
    ticketUpdateDetalleNota: "ticket.updateDetalleNota",
    ticketCobrarDetalles: "ticket.cobrarDetalles",

    kitchenSetLineaEstado: "kitchen.setLineaEstado",
} as const;

/* =========================
   Helpers
========================= */

function pick(obj: any, keys: string[]): any {
    for (const k of keys) {
        if (obj && obj[k] != null) return obj[k];
    }

    return undefined;
}

function toNum(v: any, fallback = 0): number {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
}

function toStr(v: any, fallback = ""): string {
    if (v == null) return fallback;
    return String(v);
}

function toNullableStr(v: any): string | null {
    if (v == null) return null;

    const s = String(v).trim();
    return s ? s : null;
}

function makeOpId(scope: string): string {
    const prefix = String(scope || "op").replace(/[^a-zA-Z0-9_-]/g, "_");

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

function extractIdComanda(x: any): number | null {
    const data = unwrapMaybeOkEnvelope<any>(x);

    if (typeof data === "number" && Number.isFinite(data) && data > 0) {
        return Math.trunc(data);
    }

    const id = toNum(
        pick(data, [
            "id_comanda",
            "idComanda",
            "ID_Comanda",
            "idComandaAbierta",
            "comandaId",
            "ID",
            "id",
        ]),
        0,
    );

    return id > 0 ? id : null;
}

function extractIdDetalle(x: any): number | null {
    const data = unwrapMaybeOkEnvelope<any>(x);

    if (typeof data === "number" && Number.isFinite(data) && data > 0) {
        return Math.trunc(data);
    }

    const id = toNum(
        pick(data, [
            "id_detalle",
            "idDetalle",
            "ID_Detalle",
            "detalleId",
            "ID",
            "id",
        ]),
        0,
    );

    return id > 0 ? id : null;
}

function extractIdPago(x: any): number | null {
    const data = unwrapMaybeOkEnvelope<any>(x);

    if (typeof data === "number" && Number.isFinite(data) && data > 0) {
        return Math.trunc(data);
    }

    const id = toNum(
        pick(data, ["id_pago", "idPago", "ID_Pago", "pagoId", "ID", "id"]),
        0,
    );

    return id > 0 ? id : null;
}

function parseAnyMesaId(k: string): number | null {
    const direct = Number(k);
    if (Number.isFinite(direct) && direct > 0) return direct;

    const m1 = String(k).match(/db-mesa-(\d+)/);
    if (m1) return Number(m1[1]);

    const m2 = String(k).match(/(\d+)(?!.*\d)/);
    if (m2) return Number(m2[1]);

    return null;
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
   Normalización DTO
========================= */

function normalizeCategoria(r: any): CategoriaDTO {
    return {
        ID_Categoria: toNum(
            pick(r, [
                "ID_Categoria",
                "id_categoria",
                "idCategoria",
                "IdCategoria",
                "IDcategoria",
            ]),
            0,
        ),
        Nombre: toStr(pick(r, ["Nombre", "nombre"]), ""),
        Ruta_Imagen: toNullableStr(
            pick(r, ["Ruta_Imagen", "ruta_imagen", "rutaImagen", "RutaImagen"]),
        ),
    };
}

function normalizeProducto(r: any): ProductoDTO {
    const precioRaw = pick(r, ["Precio_Venta", "precio_venta", "precioVenta"]);

    return {
        ID_Producto: toNum(
            pick(r, ["ID_Producto", "id_producto", "idProducto", "IdProducto"]),
            0,
        ),
        ID_Categoria: toNum(
            pick(r, [
                "ID_Categoria",
                "id_categoria",
                "idCategoria",
                "IdCategoria",
            ]),
            0,
        ),
        Nombre: toStr(pick(r, ["Nombre", "nombre"]), ""),
        Precio_Venta:
            precioRaw == null || !Number.isFinite(Number(precioRaw))
                ? null
                : Number(precioRaw),
        Ruta_Imagen: toNullableStr(
            pick(r, ["Ruta_Imagen", "ruta_imagen", "rutaImagen", "RutaImagen"]),
        ),
    };
}

/* =========================
   Layout / Meta mesas
========================= */

export async function mesasLoadLayout(): Promise<Salon[]> {
    const raw = await dualCall<Salon[]>(
        {
            path: "/v1/mesas/layout/load",
            method: "GET",
            unwrapOkEnvelope: true,
        },
        () => invokeLocalRead<Salon[]>("load_layout"),
        {
            kind: "read",
            debugTag: "mesas:layoutLoad",
            fallbackToLocalOnAvailabilityError: true,
        },
    );

    return unwrapMaybeOkEnvelope<Salon[]>(raw);
}

export async function mesasSaveLayout(salons: Salon[]): Promise<void> {
    const opId = makeOpId("mesas_save_layout");

    const args = {
        salons: Array.isArray(salons) ? salons : [],
    };

    await dualCall<void>(
        {
            path: "/v1/mesas/layout/save",
            method: "POST",
            body: commandBody(opId, COMMANDS.mesasSaveLayout, args),
            unwrapOkEnvelope: true,
        },
        () => invokeLocalWrite<void>("save_layout", localWriteArgs(opId, args, true)),
        {
            kind: "write",
            commandName: COMMANDS.mesasSaveLayout,
            debugTag: "mesas:layoutSave",
            fallbackToLocalOnAvailabilityError: true,
            afterRemoteOk: async () => {
                await invokeLocalWrite<void>(
                    "save_layout",
                    localWriteArgs(opId, args, false),
                );
            },
        },
    );
}

export async function mesasLoadMesaMeta(): Promise<Record<any, MesaMeta>> {
    try {
        const raw0 = await dualCall<Record<string, any>>(
            {
                path: "/v1/mesas/meta/all",
                method: "GET",
                unwrapOkEnvelope: true,
            },
            () => invokeLocalRead<Record<string, any>>("mesas_meta_all"),
            {
                kind: "read",
                debugTag: "mesas:metaAll",
                fallbackToLocalOnAvailabilityError: true,
            },
        );

        const raw = unwrapMaybeOkEnvelope<Record<string, any>>(raw0);
        const out: Record<any, any> = {};

        for (const [k, v] of Object.entries(raw ?? {})) {
            const idMesa = parseAnyMesaId(k);
            if (!idMesa) continue;

            const totalPendiente = toNum(
                pick(v, [
                    "total_pendiente",
                    "totalPendiente",
                    "Total_Pendiente",
                    "importe_pendiente",
                    "importePendiente",
                ]),
                0,
            );

            const pendientesPago = toNum(
                pick(v, ["pendientes_pago", "pendientesPago", "Pendientes_Pago"]),
                0,
            );

            const pendientesCocina = toNum(
                pick(v, [
                    "pendientes_cocina",
                    "pendientesCocina",
                    "Pendientes_Cocina",
                ]),
                0,
            );

            const meta = {
                ...(v ?? {}),
                totalPendiente,
                pendientesPago,
                pendientesCocina,
            };

            out[idMesa] = meta;
            out[String(idMesa)] = meta;
            out[`db-mesa-${idMesa}`] = meta;
        }

        return out as any;
    } catch {
        const ocupadas0 = await dualCall<Record<string, boolean>>(
            {
                path: "/v1/mesas/ocupadas",
                method: "GET",
                unwrapOkEnvelope: true,
            },
            () => invokeLocalRead<Record<string, boolean>>("get_mesas_ocupadas"),
            {
                kind: "read",
                debugTag: "mesas:ocupadasFallback",
                fallbackToLocalOnAvailabilityError: true,
            },
        );

        const ocupadas = unwrapMaybeOkEnvelope<Record<string, boolean>>(ocupadas0);
        const out: Record<any, any> = {};

        for (const [k, v] of Object.entries(ocupadas ?? {})) {
            const idMesa = parseAnyMesaId(k);
            if (!idMesa) continue;

            const meta = {
                estado: v ? "PENDIENTE" : "LIBRE",
                reserva: null,
            };

            out[idMesa] = meta;
            out[String(idMesa)] = meta;
            out[`db-mesa-${idMesa}`] = meta;
        }

        return out as any;
    }
}

/* =========================
   Reservas
========================= */

async function reservaSetEstado(
    idReserva: number,
    estado: "ACTIVA" | "FINALIZADA",
): Promise<void> {
    const id = toNum(idReserva, 0);
    if (!id) throw new Error("id_reserva inválido");

    const opId = makeOpId("reservas_set_estado");

    const args = {
        id_reserva: id,
        estado,
    };

    await dualCall<void>(
        {
            path: "/v1/reservas/set-estado",
            method: "POST",
            body: commandBody(opId, COMMANDS.reservasSetEstado, args),
            unwrapOkEnvelope: true,
        },
        () =>
            invokeLocalWrite<void>(
                "set_reserva_estado",
                localWriteArgs(opId, args, true),
            ),
        {
            kind: "write",
            commandName: COMMANDS.reservasSetEstado,
            debugTag: `reservas:setEstado:${estado}`,
            fallbackToLocalOnAvailabilityError: true,
            afterRemoteOk: async () => {
                await invokeLocalWrite<void>(
                    "set_reserva_estado",
                    localWriteArgs(opId, args, false),
                );
            },
        },
    );
}

export async function reservaMarcarActivaAhora(
    idReserva: number,
): Promise<void> {
    await reservaSetEstado(idReserva, "ACTIVA");
}

export async function reservaFinalizar(idReserva: number): Promise<void> {
    await reservaSetEstado(idReserva, "FINALIZADA");
}

/* =========================
   Comandas / Ticket
========================= */

export async function mesasEnsureOpenComanda(params: {
    idMesa: number;
    idUsuario: number | null;
    idReserva: number | null;
}): Promise<number> {
    const idMesa = toNum(params.idMesa, 0);
    if (!idMesa) throw new Error("id_mesa inválido");

    const idUsuario =
        params.idUsuario != null ? toNum(params.idUsuario, 0) : null;

    const abierta0 = await dualCall<any>(
        {
            path: "/v1/comandas/get-abierta-by-mesa",
            method: "POST",
            body: { id_mesa: idMesa },
            unwrapOkEnvelope: true,
        },
        () =>
            invokeLocalRead<any>("get_comanda_abierta_by_mesa", {
                id_mesa: idMesa,
            }),
        {
            kind: "read",
            debugTag: "comandas:getAbiertaByMesa",
            fallbackToLocalOnAvailabilityError: true,
        },
    );

    const abierta = unwrapMaybeOkEnvelope<any>(abierta0);

    const idAbierta = toNum(
        pick(abierta, ["id_comanda", "ID_Comanda", "idComanda", "id"]),
        0,
    );

    if (idAbierta > 0) {
        if (idUsuario && idUsuario > 0) {
            const opId = makeOpId("comandas_set_trabajador_if_null");

            const args = {
                id_comanda: idAbierta,
                id_usuario: idUsuario,
                id_trabajador: null,
            };

            try {
                await dualCall<void>(
                    {
                        path: "/v1/comandas/set-trabajador-if-null",
                        method: "POST",
                        body: commandBody(
                            opId,
                            COMMANDS.comandasSetTrabajadorIfNull,
                            args,
                        ),
                        unwrapOkEnvelope: true,
                    },
                    () =>
                        invokeLocalWrite<void>(
                            "comanda_set_trabajador_if_null",
                            localWriteArgs(opId, args, true),
                        ),
                    {
                        kind: "write",
                        commandName: COMMANDS.comandasSetTrabajadorIfNull,
                        debugTag: "comandas:setTrabajadorIfNull",
                        fallbackToLocalOnAvailabilityError: true,
                        afterRemoteOk: async () => {
                            await invokeLocalWrite<void>(
                                "comanda_set_trabajador_if_null",
                                localWriteArgs(opId, args, false),
                            );
                        },
                    },
                );
            } catch {
                // No bloqueamos cargar/abrir la comanda por esto.
            }
        }

        return idAbierta;
    }

    const idReserva =
        params.idReserva != null ? toNum(params.idReserva, 0) : null;

    const opId = makeOpId("comandas_abrir");

    const args = {
        id_mesa: idMesa,
        id_usuario: idUsuario,
        id_trabajador: null,
        id_reserva: idReserva,
        id_comanda: null,
    };

    const creada = await dualCall<any>(
        {
            path: "/v1/comandas/abrir",
            method: "POST",
            body: commandBody(opId, COMMANDS.comandasAbrir, args),
            unwrapOkEnvelope: true,
        },
        () => invokeLocalWrite<any>("abrir_comanda", localWriteArgs(opId, args, true)),
        {
            kind: "write",
            commandName: COMMANDS.comandasAbrir,
            debugTag: "comandas:abrir",
            fallbackToLocalOnAvailabilityError: true,
            afterRemoteOk: async (remoteResult: any) => {
                const remoteId = extractIdComanda(remoteResult);

                await invokeLocalWrite<any>(
                    "abrir_comanda",
                    localWriteArgs(
                        opId,
                        {
                            ...args,
                            id_comanda: remoteId,
                        },
                        false,
                    ),
                );
            },
        },
    );

    const creadaData = unwrapMaybeOkEnvelope<any>(creada);

    const idCreada = toNum(
        pick(creadaData, ["id_comanda", "ID_Comanda", "idComanda", "id"]),
        0,
    );

    if (!idCreada) throw new Error("ID_Comanda inválido");
    return idCreada;
}

export async function mesasLoadTicket(idComanda: number): Promise<any[]> {
    const id = toNum(idComanda, 0);
    if (!id) return [];

    const raw = await dualCall<any[]>(
        {
            path: "/v1/comandas/get-lineas",
            method: "POST",
            body: { id_comanda: id },
            unwrapOkEnvelope: true,
        },
        () =>
            invokeLocalRead<any[]>("get_lineas_comanda", {
                id_comanda: id,
            }),
        {
            kind: "read",
            debugTag: "comandas:getLineas",
            fallbackToLocalOnAvailabilityError: true,
        },
    );

    return unwrapMaybeOkEnvelope<any[]>(raw) ?? [];
}

export async function mesasAddDetalle(params: {
    idComanda: number;
    idProducto: number;
    cantidad?: number;
    precio: number;
    idUsuario?: number | null;
}): Promise<void> {
    const idComanda = toNum(params.idComanda, 0);
    const idProducto = toNum(params.idProducto, 0);
    const cantidad = toNum(params.cantidad ?? 1, 1);
    const precio = Number(params.precio);
    const idUsuario =
        params.idUsuario != null ? toNum(params.idUsuario, 0) : null;

    if (!idComanda) throw new Error("id_comanda inválido");
    if (!idProducto) throw new Error("id_producto inválido");
    if (!Number.isFinite(precio)) throw new Error("precio inválido");

    const opId = makeOpId("comandas_add_linea");

    const args = {
        id_comanda: idComanda,
        id_producto: idProducto,
        cantidad,
        precio,
        id_usuario: idUsuario,
        id_trabajador: null,
        id_detalle: null,
    };

    await dualCall<void>(
        {
            path: "/v1/comandas/add-linea",
            method: "POST",
            body: commandBody(opId, COMMANDS.comandasAddLinea, args),
            unwrapOkEnvelope: true,
        },
        () =>
            invokeLocalWrite<void>(
                "add_linea_comanda",
                localWriteArgs(opId, args, true),
            ),
        {
            kind: "write",
            commandName: COMMANDS.comandasAddLinea,
            debugTag: "comandas:addLinea",
            fallbackToLocalOnAvailabilityError: true,
            afterRemoteOk: async (remoteResult: any) => {
                const remoteIdDetalle = extractIdDetalle(remoteResult);

                await invokeLocalWrite<void>(
                    "add_linea_comanda",
                    localWriteArgs(
                        opId,
                        {
                            ...args,
                            id_detalle: remoteIdDetalle,
                        },
                        false,
                    ),
                );
            },
        },
    );
}

/* =========================
   Productos / Catálogo vendible
========================= */

export async function productosListCategoriasVendibles(): Promise<
    CategoriaDTO[]
> {
    const raw = await dualCall<any[]>(
        {
            path: "/v1/catalogo/categorias",
            method: "GET",
            unwrapOkEnvelope: true,
        },
        () => invokeLocalRead<any[]>("list_categorias_vendibles"),
        {
            kind: "read",
            debugTag: "catalogo:listCategorias",
            fallbackToLocalOnAvailabilityError: true,
        },
    );

    const rows = unwrapMaybeOkEnvelope<any[]>(raw);

    return (rows ?? [])
        .map(normalizeCategoria)
        .filter((c) => c.ID_Categoria > 0);
}

export async function productosListByCategoria(
    idCategoria: number,
): Promise<ProductoDTO[]> {
    const idCat = toNum(idCategoria, 0);
    if (!idCat) throw new Error("id_categoria inválido");

    const args = { id_categoria: idCat };

    const raw = await dualCall<any[]>(
        {
            path: "/v1/catalogo/productos/by-categoria",
            method: "POST",
            body: args,
            unwrapOkEnvelope: true,
        },
        () => invokeLocalRead<any[]>("list_productos_by_categoria", args),
        {
            kind: "read",
            debugTag: "catalogo:listByCategoria",
            fallbackToLocalOnAvailabilityError: true,
        },
    );

    const rows = unwrapMaybeOkEnvelope<any[]>(raw);

    return (rows ?? [])
        .map(normalizeProducto)
        .filter((p) => p.ID_Producto > 0);
}

export async function productosSearchByNombre(
    q: string,
): Promise<ProductoDTO[]> {
    const query = String(q ?? "").trim();
    if (!query) return [];

    const args = { query };

    const raw = await dualCall<any[]>(
        {
            path: "/v1/catalogo/productos/search",
            method: "POST",
            body: args,
            unwrapOkEnvelope: true,
        },
        () => invokeLocalRead<any[]>("search_productos_by_nombre", args),
        {
            kind: "read",
            debugTag: "catalogo:search",
            fallbackToLocalOnAvailabilityError: true,
        },
    );

    const rows = unwrapMaybeOkEnvelope<any[]>(raw);

    return (rows ?? [])
        .map(normalizeProducto)
        .filter((p) => p.ID_Producto > 0);
}

/* =========================
   Ticket / MesaComandaModal
========================= */

export async function mesasRemoveOnePendingDetalle(params: {
    idComanda: number;
    idProducto: number;
}): Promise<void> {
    const idComanda = toNum(params.idComanda, 0);
    const idProducto = toNum(params.idProducto, 0);
    if (!idComanda || !idProducto) return;

    const opId = makeOpId("ticket_remove_one_pending");

    const args = {
        id_comanda: idComanda,
        id_producto: idProducto,
    };

    await dualCall<void>(
        {
            path: "/v1/ticket/remove-one-pending",
            method: "POST",
            body: commandBody(opId, COMMANDS.ticketRemoveOnePending, args),
            unwrapOkEnvelope: true,
        },
        () =>
            invokeLocalWrite<void>(
                "remove_one_pending_detalle",
                localWriteArgs(opId, args, true),
            ),
        {
            kind: "write",
            commandName: COMMANDS.ticketRemoveOnePending,
            debugTag: "ticket:removeOnePending",
            fallbackToLocalOnAvailabilityError: true,
            afterRemoteOk: async () => {
                await invokeLocalWrite<void>(
                    "remove_one_pending_detalle",
                    localWriteArgs(opId, args, false),
                );
            },
        },
    );
}

export async function mesasDeleteDetalle(idDetalle: number): Promise<void> {
    const id = toNum(idDetalle, 0);
    if (!id) return;

    const opId = makeOpId("ticket_delete_detalle");

    const args = {
        id_detalle: id,
    };

    await dualCall<void>(
        {
            path: "/v1/ticket/delete-detalle",
            method: "POST",
            body: commandBody(opId, COMMANDS.ticketDeleteDetalle, args),
            unwrapOkEnvelope: true,
        },
        () =>
            invokeLocalWrite<void>(
                "delete_detalle",
                localWriteArgs(opId, args, true),
            ),
        {
            kind: "write",
            commandName: COMMANDS.ticketDeleteDetalle,
            debugTag: "ticket:deleteDetalle",
            fallbackToLocalOnAvailabilityError: true,
            afterRemoteOk: async () => {
                await invokeLocalWrite<void>(
                    "delete_detalle",
                    localWriteArgs(opId, args, false),
                );
            },
        },
    );
}

export async function mesasUpdateDetalleNota(params: {
    idDetalle: number;
    nota: string | null;
}): Promise<void> {
    const id = toNum(params.idDetalle, 0);
    if (!id) return;

    const opId = makeOpId("ticket_update_detalle_nota");

    const args = {
        id_detalle: id,
        nota: params.nota,
    };

    await dualCall<void>(
        {
            path: "/v1/ticket/update-detalle-notas",
            method: "POST",
            body: commandBody(opId, COMMANDS.ticketUpdateDetalleNota, args),
            unwrapOkEnvelope: true,
        },
        () =>
            invokeLocalWrite<void>(
                "update_detalle_nota",
                localWriteArgs(opId, args, true),
            ),
        {
            kind: "write",
            commandName: COMMANDS.ticketUpdateDetalleNota,
            debugTag: "ticket:updateDetalleNota",
            fallbackToLocalOnAvailabilityError: true,
            afterRemoteOk: async () => {
                await invokeLocalWrite<void>(
                    "update_detalle_nota",
                    localWriteArgs(opId, args, false),
                );
            },
        },
    );
}

export async function mesasCobrarDetalles(params: {
    idComanda: number;
    metodo: "Tarjeta" | "Efectivo";
    tipo: "TOTAL" | "FRACCIONADO";
    detalleIds: number[];
    idUsuario: number | null;
}): Promise<void> {
    const idComanda = toNum(params.idComanda, 0);
    const detalleIds = (params.detalleIds ?? [])
        .map((x) => toNum(x, 0))
        .filter((n) => n > 0);

    const idUsuario =
        params.idUsuario != null ? toNum(params.idUsuario, 0) : null;

    if (!idComanda || !detalleIds.length) return;

    const opId = makeOpId("ticket_cobrar_detalles");

    const args = {
        id_comanda: idComanda,
        metodo: params.metodo,
        tipo: params.tipo,
        detalle_ids: detalleIds,
        id_usuario: idUsuario,
        id_pago: null,
    };

    await dualCall<void>(
        {
            path: "/v1/ticket/cobrar-detalles",
            method: "POST",
            body: commandBody(opId, COMMANDS.ticketCobrarDetalles, args),
            unwrapOkEnvelope: true,
        },
        () =>
            invokeLocalWrite<void>(
                "cobrar_detalles",
                localWriteArgs(opId, args, true),
            ),
        {
            kind: "write",
            commandName: COMMANDS.ticketCobrarDetalles,
            debugTag: "ticket:cobrarDetalles",
            fallbackToLocalOnAvailabilityError: true,
            afterRemoteOk: async (remoteResult: any) => {
                const remoteIdPago = extractIdPago(remoteResult);

                await invokeLocalWrite<void>(
                    "cobrar_detalles",
                    localWriteArgs(
                        opId,
                        {
                            ...args,
                            id_pago: remoteIdPago,
                        },
                        false,
                    ),
                );
            },
        },
    );
}

/* =========================
   Cocina / KitchenBoard
========================= */

export async function cocinaListHoyPendientes(): Promise<KitchenRow[]> {
    const raw = await dualCall<any[]>(
        {
            path: "/v1/kitchen/today/pending",
            method: "GET",
            unwrapOkEnvelope: true,
        },
        () => invokeLocalRead<any[]>("cocina_list_hoy_pendientes"),
        {
            kind: "read",
            debugTag: "kitchen:listTodayPending",
            fallbackToLocalOnAvailabilityError: true,
        },
    );

    const rows = unwrapMaybeOkEnvelope<any[]>(raw);

    return (rows ?? []).map((r: any) => ({
        ID_Comanda: toNum(
            pick(r, ["ID_Comanda", "id_comanda", "idComanda"]),
            0,
        ),
        ID_Detalle: toNum(
            pick(r, ["ID_Detalle", "id_detalle", "idDetalle"]),
            0,
        ),
        Cantidad: toNum(pick(r, ["Cantidad", "cantidad"]), 1),
        Nombre_Producto: toStr(
            pick(r, ["Nombre_Producto", "productoNombre", "Nombre", "nombre"]),
            "",
        ),
        Notas: toNullableStr(pick(r, ["Notas", "notas"])),
        Estado_Cocina: toStr(
            pick(r, ["Estado_Cocina", "estado_cocina", "estadoCocina"]),
            "PENDIENTE",
        ),
        Pagado: toNum(pick(r, ["Pagado", "pagado"]), 0) ? 1 : 0,
        Numero_Mesa: toNullableStr(
            pick(r, ["Numero_Mesa", "numero_mesa", "mesaNombre", "mesa"]),
        ),
        Fecha_Hora_Apertura: toNullableStr(
            pick(r, [
                "Fecha_Hora_Apertura",
                "fecha_hora_apertura",
                "fechaHora",
                "fecha_hora",
            ]),
        ),
    }));
}

export async function cocinaSetLineaEstado(params: {
    idDetalle: number;
    idUsuarioCocinero: number | null;
    estado: "PENDIENTE" | "PREPARADO";
}): Promise<void> {
    const idDetalle = toNum(params.idDetalle, 0);
    const idUsuarioCocinero =
        params.idUsuarioCocinero != null
            ? toNum(params.idUsuarioCocinero, 0)
            : 0;

    if (!idDetalle || !idUsuarioCocinero) return;

    const opId = makeOpId("kitchen_set_line_state");

    const args = {
        id_detalle: idDetalle,
        estado: params.estado,
        id_usuario_cocinero: idUsuarioCocinero,
    };

    await dualCall<void>(
        {
            path: "/v1/kitchen/set-line-state",
            method: "POST",
            body: commandBody(opId, COMMANDS.kitchenSetLineaEstado, args),
            unwrapOkEnvelope: true,
        },
        () =>
            invokeLocalWrite<void>(
                "cocina_set_linea_estado",
                localWriteArgs(opId, args, true),
            ),
        {
            kind: "write",
            commandName: COMMANDS.kitchenSetLineaEstado,
            debugTag: "kitchen:setLineaEstado",
            fallbackToLocalOnAvailabilityError: true,
            afterRemoteOk: async () => {
                await invokeLocalWrite<void>(
                    "cocina_set_linea_estado",
                    localWriteArgs(opId, args, false),
                );
            },
        },
    );
}