// src/features/mesasComponents/mesasApi.ts
//
// API de mesas / comandas / ticket / cocina: una función por comando Tauri, con los tipos que genera
// ts-rs desde Rust. Aquí no se redeclaran tipos ni se normaliza lo que vuelve (RI-53): el precio de
// una línea y el pendiente de una mesa llegan como `Dinero`.
//
// El plano (`Salon`/`Table`, en `./types`) sigue con su tipo de la pantalla: es la geometría del
// editor, no un dato de negocio. Pasa a los generados con RI-87.
//
// UUIDv7: todos los IDs de negocio son `string` (idénticos en local y nube).

import { invokeClient } from "@tpv/client";
import type {
    CategoriaVendibleOut,
    ComandaRow,
    DestinatarioInput,
    Dinero,
    KitchenRow,
    MesaLineaComandaRow,
    MesaMetaOut,
    MesasAbrirComandaInput,
    MesasAddLineaComandaInput,
    MesasCobrarDetallesInput,
    ProductoVendibleOut,
} from "@tpv/contracts";

import { CERO } from "../../shared/lib/dinero";
import type { Salon } from "./types";

export type { CategoriaVendibleOut, KitchenRow, MesaLineaComandaRow, MesaMetaOut, ProductoVendibleOut };

// Acepta el id crudo (UUID) o la clave de UI `db-mesa-<uuid>`. Devuelve el id o null.
function parseAnyMesaId(k: string): string | null {
    const s = String(k ?? "").trim();
    if (!s) return null;

    const m = s.match(/^db-mesa-(.+)$/);
    if (m) return m[1].trim() || null;

    return s;
}

/* =========================
   Layout / Meta mesas
========================= */

export async function mesasLoadLayout(): Promise<Salon[]> {
    const rows = await invokeClient<Salon[]>("load_layout");
    return rows ?? [];
}

export async function mesasSaveLayout(salons: Salon[]): Promise<void> {
    // El contrato Rust (TableInput) tipa x/y/width/height/radius como i64. El editor
    // produce coordenadas de mundo fraccionarias al arrastrar con zoom ≠ 100 %, así que
    // redondeamos a entero aquí (chokepoint único de guardado) para no romper la
    // deserialización serde en la frontera Tauri.
    const list = Array.isArray(salons) ? salons : [];
    const safe = list.map((s) => ({
        ...s,
        tables: (s.tables ?? []).map((t) => ({
            ...t,
            x: Math.round(t.x),
            y: Math.round(t.y),
            width: Math.round(t.width),
            height: Math.round(t.height),
            radius: t.radius == null ? t.radius : Math.round(t.radius),
        })),
    }));

    await invokeClient<string>("save_layout", {
        args: { salons: safe },
    });
}

/** Estado de cada mesa del plano, indexado por el id de la mesa. */
export async function mesasLoadMesaMeta(): Promise<Record<string, MesaMetaOut>> {
    const out: Record<string, MesaMetaOut> = {};
    try {
        const raw = await invokeClient<Record<string, MesaMetaOut>>("mesas_meta_all");
        for (const [k, v] of Object.entries(raw)) {
            const idMesa = parseAnyMesaId(k);
            // `parseAnyMesaId` normaliza la clave a UUID puro, que es la que usan los lookups
            // (TableNode/Mesas vía `parseMesaId`). Una sola clave.
            if (idMesa) out[idMesa] = v;
        }
    } catch {
        // Sólo si el detalle falla: al menos que el plano distinga libre de ocupada.
        const ocupadas = await invokeClient<Record<string, boolean>>("get_mesas_ocupadas");
        for (const [k, ocupada] of Object.entries(ocupadas)) {
            const idMesa = parseAnyMesaId(k);
            if (!idMesa) continue;
            out[idMesa] = {
                ocupada,
                id_comanda: "",
                idComanda: "",
                totalPendiente: CERO,
                pendientesPago: 0,
                pendientesCocina: 0,
                estado: ocupada ? "PENDIENTE" : "LIBRE",
            };
        }
    }
    return out;
}

/* =========================
   Reservas
========================= */

async function reservaSetEstado(
    idReserva: string,
    estado: "ACTIVA" | "FINALIZADA",
): Promise<void> {
    const id = idReserva.trim();
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
    const idMesa = params.idMesa.trim();
    if (!idMesa) throw new Error("id_mesa inválido");
    const idUsuario = params.idUsuario?.trim() || undefined;

    const abierta = await invokeClient<ComandaRow | null>("get_comanda_abierta_by_mesa", {
        args: { id_mesa: idMesa },
    });

    if (abierta?.id_comanda) {
        if (idUsuario) {
            try {
                await invokeClient<boolean>("comanda_set_trabajador_if_null", {
                    args: { id_comanda: abierta.id_comanda, id_usuario: idUsuario },
                });
            } catch {
                // No bloqueamos cargar/abrir la comanda por esto.
            }
        }
        return abierta.id_comanda;
    }

    const args: MesasAbrirComandaInput = {
        id_mesa: idMesa,
        id_usuario: idUsuario,
        id_reserva: params.idReserva?.trim() || undefined,
    };
    const creada = await invokeClient<ComandaRow | null>("abrir_comanda", { args });

    if (!creada?.id_comanda) throw new Error("ID_Comanda inválido");
    return creada.id_comanda;
}

export async function mesasLoadTicket(idComanda: string): Promise<MesaLineaComandaRow[]> {
    const id = idComanda.trim();
    if (!id) return [];

    return invokeClient<MesaLineaComandaRow[]>("get_lineas_comanda", {
        args: { id_comanda: id },
    });
}

/** Añade una línea y devuelve todas las de la comanda. */
export async function mesasAddDetalle(params: {
    idComanda: string;
    idProducto: string;
    cantidad?: number;
    precio: Dinero;
    idUsuario?: string | null;
}): Promise<MesaLineaComandaRow[]> {
    const args: MesasAddLineaComandaInput = {
        id_comanda: params.idComanda.trim(),
        id_producto: params.idProducto.trim(),
        cantidad: params.cantidad ?? 1,
        precio: params.precio,
        id_usuario: params.idUsuario?.trim() || undefined,
    };
    if (!args.id_comanda) throw new Error("id_comanda inválido");
    if (!args.id_producto) throw new Error("id_producto inválido");

    return invokeClient<MesaLineaComandaRow[]>("add_linea_comanda", { args });
}

/* =========================
   Productos / Catálogo vendible
========================= */

export function productosListCategoriasVendibles(): Promise<CategoriaVendibleOut[]> {
    return invokeClient<CategoriaVendibleOut[]>("list_categorias_vendibles");
}

export async function productosListByCategoria(idCategoria: string): Promise<ProductoVendibleOut[]> {
    const idCat = idCategoria.trim();
    if (!idCat) throw new Error("id_categoria inválido");

    return invokeClient<ProductoVendibleOut[]>("list_productos_by_categoria", {
        args: { id_categoria: idCat },
    });
}

export async function productosSearchByNombre(q: string): Promise<ProductoVendibleOut[]> {
    const query = q.trim();
    if (!query) return [];

    return invokeClient<ProductoVendibleOut[]>("search_productos_by_nombre", {
        args: { query },
    });
}

/* =========================
   Ticket / MesaComandaModal
========================= */

export async function mesasRemoveOnePendingDetalle(params: {
    idComanda: string;
    idProducto: string;
}): Promise<void> {
    const idComanda = params.idComanda.trim();
    const idProducto = params.idProducto.trim();
    if (!idComanda || !idProducto) return;

    await invokeClient<string>("remove_one_pending_detalle", {
        args: { id_comanda: idComanda, id_producto: idProducto },
    });
}

export async function mesasDeleteDetalle(idDetalle: string): Promise<void> {
    const id = idDetalle.trim();
    if (!id) return;

    await invokeClient<string>("delete_detalle", {
        args: { id_detalle: id },
    });
}

export async function mesasUpdateDetalleNota(params: {
    idDetalle: string;
    nota: string | null;
}): Promise<void> {
    const id = params.idDetalle.trim();
    if (!id) return;

    await invokeClient<string>("update_detalle_nota", {
        args: { id_detalle: id, nota: params.nota ?? undefined },
    });
}

export async function mesasCobrarDetalles(params: {
    idComanda: string;
    metodo: "Tarjeta" | "Efectivo";
    tipo: "TOTAL" | "FRACCIONADO";
    detalleIds: string[];
    /**
     * FISCAL-02: datos del cliente cuando pide **factura completa** (`F1`), o cuando el importe pasa
     * del límite de la simplificada y entonces no hay alternativa.
     *
     * Ausente = ticket normal (`F2`). Si el importe pasa del límite y no va, el backend rechaza el
     * cobro con `factura_completa_requerida` y la pantalla abre `DatosFiscalesModal`.
     */
    destinatario?: DestinatarioInput;
    /** Devuelve el número de ticket del cobro (cadena vacía si no había nada que cobrar). */
}): Promise<string> {
    const idComanda = params.idComanda.trim();
    const detalleIds = params.detalleIds.map((x) => x.trim()).filter((s) => s.length > 0);

    if (!idComanda || !detalleIds.length) return "";

    const args: MesasCobrarDetallesInput = {
        id_comanda: idComanda,
        metodo: params.metodo,
        tipo: params.tipo,
        detalle_ids: detalleIds,
        // REV-17: quién cobra lo pone el backend desde la sesión (SEC-01).
        destinatario: params.destinatario,
    };
    return invokeClient<string>("cobrar_detalles", { args });
}

/* =========================
   Cocina / KitchenBoard
========================= */

export function cocinaListHoyPendientes(): Promise<KitchenRow[]> {
    return invokeClient<KitchenRow[]>("kitchen_list_today_pending");
}

export async function cocinaSetLineaEstado(params: {
    idDetalle: string;
    idUsuarioCocinero: string | null;
    estado: "PENDIENTE" | "PREPARADO";
}): Promise<void> {
    const idDetalle = params.idDetalle.trim();
    const idUsuarioCocinero = params.idUsuarioCocinero?.trim() ?? "";

    if (!idDetalle || !idUsuarioCocinero) return;

    await invokeClient<string>("kitchen_set_line_state", {
        args: {
            id_detalle: idDetalle,
            estado: params.estado,
            id_usuario_cocinero: idUsuarioCocinero,
        },
    });
}
