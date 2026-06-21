// src/features/mesasComponents/mesasApi.ts
//
// API de mesas / comandas / ticket / cocina — Local-First puro. Sustituye dualCall
// (remoto + local + outbox + op_id + afterRemoteOk) por invocación directa del comando
// Tauri vía @tpv/client. Las firmas exportadas y los tipos NO cambian; los 5 componentes
// consumidores siguen igual. Se conservan los nombres de comando del backend hexagonal.
//
// UUIDv7: todos los IDs de negocio son `string` (idénticos en local y nube).

import { invokeClient } from "@tpv/client";
import type { Salon, MesaMeta } from "./types";

/* =========================
   DTOs que usa MesaComandaModal
========================= */

export type CategoriaDTO = {
    ID_Categoria: string;
    Nombre: string;
    Ruta_Imagen: string | null;
};

export type ProductoDTO = {
    ID_Producto: string;
    ID_Categoria: string;
    Nombre: string;
    Precio_Venta: number | null;
    Ruta_Imagen: string | null;
};

export type KitchenRow = {
    ID_Comanda: string;
    ID_Detalle: string;
    Cantidad: number;
    Nombre_Producto: string;
    Notas: string | null;
    Estado_Cocina: "PENDIENTE" | "PREPARADO" | string;
    Pagado: 0 | 1;
    Numero_Mesa: string | null;
    Fecha_Hora_Apertura: string | null;
};

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

function toId(v: any): string {
    return String(v ?? "").trim();
}

function toNullableStr(v: any): string | null {
    if (v == null) return null;
    const s = String(v).trim();
    return s ? s : null;
}

// Acepta el id crudo (UUID) o la clave de UI `db-mesa-<uuid>`. Devuelve el id o null.
function parseAnyMesaId(k: string): string | null {
    const s = String(k ?? "").trim();
    if (!s) return null;

    const m = s.match(/^db-mesa-(.+)$/);
    if (m) return m[1].trim() || null;

    return s;
}

/* =========================
   Normalización DTO
========================= */

function normalizeCategoria(r: any): CategoriaDTO {
    return {
        ID_Categoria: toStr(
            pick(r, [
                "ID_Categoria",
                "id_categoria",
                "idCategoria",
                "IdCategoria",
                "IDcategoria",
            ]),
            "",
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
        ID_Producto: toStr(
            pick(r, ["ID_Producto", "id_producto", "idProducto", "IdProducto"]),
            "",
        ),
        ID_Categoria: toStr(
            pick(r, ["ID_Categoria", "id_categoria", "idCategoria", "IdCategoria"]),
            "",
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
    const rows = await invokeClient<Salon[]>("load_layout");
    return rows ?? [];
}

export async function mesasSaveLayout(salons: Salon[]): Promise<void> {
    await invokeClient<string>("save_layout", {
        args: { salons: Array.isArray(salons) ? salons : [] },
    });
}

export async function mesasLoadMesaMeta(): Promise<Record<any, MesaMeta>> {
    try {
        const raw = await invokeClient<Record<string, any>>("mesas_meta_all");
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
        const ocupadas = await invokeClient<Record<string, boolean>>(
            "get_mesas_ocupadas",
        );
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
    idReserva: string,
    estado: "ACTIVA" | "FINALIZADA",
): Promise<void> {
    const id = toId(idReserva);
    if (!id) throw new Error("id_reserva inválido");

    await invokeClient<string>("set_reserva_estado", {
        args: { id_reserva: id, estado },
    });
}

export async function reservaMarcarActivaAhora(
    idReserva: string,
): Promise<void> {
    await reservaSetEstado(idReserva, "ACTIVA");
}

export async function reservaFinalizar(idReserva: string): Promise<void> {
    await reservaSetEstado(idReserva, "FINALIZADA");
}

/* =========================
   Comandas / Ticket
========================= */

export async function mesasEnsureOpenComanda(params: {
    idMesa: string;
    idUsuario: string | null;
    idReserva: string | null;
}): Promise<string> {
    const idMesa = toId(params.idMesa);
    if (!idMesa) throw new Error("id_mesa inválido");

    const idUsuario =
        params.idUsuario != null ? toId(params.idUsuario) || null : null;

    const abierta = await invokeClient<any>("get_comanda_abierta_by_mesa", {
        args: { id_mesa: idMesa },
    });

    const idAbierta = toId(
        pick(abierta, ["id_comanda", "ID_Comanda", "idComanda", "id"]),
    );

    if (idAbierta) {
        if (idUsuario) {
            try {
                await invokeClient<boolean>("comanda_set_trabajador_if_null", {
                    args: {
                        id_comanda: idAbierta,
                        id_usuario: idUsuario,
                        id_trabajador: null,
                    },
                });
            } catch {
                // No bloqueamos cargar/abrir la comanda por esto.
            }
        }

        return idAbierta;
    }

    const idReserva =
        params.idReserva != null ? toId(params.idReserva) || null : null;

    const creada = await invokeClient<any>("abrir_comanda", {
        args: {
            id_mesa: idMesa,
            id_usuario: idUsuario,
            id_trabajador: null,
            id_reserva: idReserva,
        },
    });

    const idCreada = toId(
        pick(creada, ["id_comanda", "ID_Comanda", "idComanda", "id"]),
    );

    if (!idCreada) throw new Error("ID_Comanda inválido");
    return idCreada;
}

export async function mesasLoadTicket(idComanda: string): Promise<any[]> {
    const id = toId(idComanda);
    if (!id) return [];

    const rows = await invokeClient<any[]>("get_lineas_comanda", {
        args: { id_comanda: id },
    });
    return rows ?? [];
}

export async function mesasAddDetalle(params: {
    idComanda: string;
    idProducto: string;
    cantidad?: number;
    precio: number;
    idUsuario?: string | null;
}): Promise<any[]> {
    const idComanda = toId(params.idComanda);
    const idProducto = toId(params.idProducto);
    const cantidad = toNum(params.cantidad ?? 1, 1);
    const precio = Number(params.precio);
    const idUsuario =
        params.idUsuario != null ? toId(params.idUsuario) || null : null;

    if (!idComanda) throw new Error("id_comanda inválido");
    if (!idProducto) throw new Error("id_producto inválido");
    if (!Number.isFinite(precio)) throw new Error("precio inválido");

    return (
        (await invokeClient<any[]>("add_linea_comanda", {
            args: {
                id_comanda: idComanda,
                id_producto: idProducto,
                cantidad,
                precio,
                id_usuario: idUsuario,
                id_trabajador: null,
            },
        })) ?? []
    );
}

/* =========================
   Productos / Catálogo vendible
========================= */

export async function productosListCategoriasVendibles(): Promise<
    CategoriaDTO[]
> {
    const rows = await invokeClient<any[]>("list_categorias_vendibles");
    return (rows ?? [])
        .map(normalizeCategoria)
        .filter((c) => c.ID_Categoria.length > 0);
}

export async function productosListByCategoria(
    idCategoria: string,
): Promise<ProductoDTO[]> {
    const idCat = toId(idCategoria);
    if (!idCat) throw new Error("id_categoria inválido");

    const rows = await invokeClient<any[]>("list_productos_by_categoria", {
        args: { id_categoria: idCat },
    });
    return (rows ?? [])
        .map(normalizeProducto)
        .filter((p) => p.ID_Producto.length > 0);
}

export async function productosSearchByNombre(
    q: string,
): Promise<ProductoDTO[]> {
    const query = String(q ?? "").trim();
    if (!query) return [];

    const rows = await invokeClient<any[]>("search_productos_by_nombre", {
        args: { query },
    });
    return (rows ?? [])
        .map(normalizeProducto)
        .filter((p) => p.ID_Producto.length > 0);
}

/* =========================
   Ticket / MesaComandaModal
========================= */

export async function mesasRemoveOnePendingDetalle(params: {
    idComanda: string;
    idProducto: string;
}): Promise<void> {
    const idComanda = toId(params.idComanda);
    const idProducto = toId(params.idProducto);
    if (!idComanda || !idProducto) return;

    await invokeClient<string>("remove_one_pending_detalle", {
        args: { id_comanda: idComanda, id_producto: idProducto },
    });
}

export async function mesasDeleteDetalle(idDetalle: string): Promise<void> {
    const id = toId(idDetalle);
    if (!id) return;

    await invokeClient<string>("delete_detalle", {
        args: { id_detalle: id },
    });
}

export async function mesasUpdateDetalleNota(params: {
    idDetalle: string;
    nota: string | null;
}): Promise<void> {
    const id = toId(params.idDetalle);
    if (!id) return;

    await invokeClient<string>("update_detalle_nota", {
        args: { id_detalle: id, nota: params.nota },
    });
}

export async function mesasCobrarDetalles(params: {
    idComanda: string;
    metodo: "Tarjeta" | "Efectivo";
    tipo: "TOTAL" | "FRACCIONADO";
    detalleIds: string[];
    idUsuario: string | null;
}): Promise<void> {
    const idComanda = toId(params.idComanda);
    const detalleIds = (params.detalleIds ?? [])
        .map((x) => toId(x))
        .filter((s) => s.length > 0);

    const idUsuario =
        params.idUsuario != null ? toId(params.idUsuario) || null : null;

    if (!idComanda || !detalleIds.length) return;

    await invokeClient<string>("cobrar_detalles", {
        args: {
            id_comanda: idComanda,
            metodo: params.metodo,
            tipo: params.tipo,
            detalle_ids: detalleIds,
            id_usuario: idUsuario,
        },
    });
}

/* =========================
   Cocina / KitchenBoard
========================= */

export async function cocinaListHoyPendientes(): Promise<KitchenRow[]> {
    const rows = await invokeClient<any[]>("kitchen_list_today_pending");

    return (rows ?? []).map((r: any) => ({
        ID_Comanda: toStr(pick(r, ["ID_Comanda", "id_comanda", "idComanda"]), ""),
        ID_Detalle: toStr(pick(r, ["ID_Detalle", "id_detalle", "idDetalle"]), ""),
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
    idDetalle: string;
    idUsuarioCocinero: string | null;
    estado: "PENDIENTE" | "PREPARADO";
}): Promise<void> {
    const idDetalle = toId(params.idDetalle);
    const idUsuarioCocinero =
        params.idUsuarioCocinero != null ? toId(params.idUsuarioCocinero) : "";

    if (!idDetalle || !idUsuarioCocinero) return;

    await invokeClient<string>("kitchen_set_line_state", {
        args: {
            id_detalle: idDetalle,
            estado: params.estado,
            id_usuario_cocinero: idUsuarioCocinero,
        },
    });
}
