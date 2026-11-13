import type { MesaLineaComandaRow,MesaMetaOut } from "@tpv/contracts";
import { mesasAbrirORetomar,mesasAddDetalle,mesasDeleteDetalle,mesasEnsureOpenComanda,mesasLoadTicket,mesasRemoveOnePendingDetalle } from "./mesasApi";
import type { ProductoDisplay,TicketItem } from "./tiposComanda";

/* =========================
   Helpers ticket (sin SQL)
========================= */

/**
 * Abre o retoma la mesa: el id de su comanda abierta y su ticket, en un paso (en la Handy, un viaje
 * en vez de cuatro). El trabajador lo pone el backend, el de la sesión, si a la comanda le faltaba.
 */
export async function abrirORetomarMesa(
    idMesa: string,
    reservaActiva?: { idReserva: string } | null,
): Promise<{ idComanda: string; ticket: TicketItem[] }> {
    const r = await mesasAbrirORetomar({ idMesa, idReserva: reservaActiva?.idReserva ?? null });
    return { idComanda: r.comanda.id_comanda, ticket: mapTicketRows(r.lineas) };
}

export async function ensureOpenComanda(
    idMesa: string,
    idUsuario: string | null,
    reservaActiva?: { idReserva: string } | null,
): Promise<string> {
    return await mesasEnsureOpenComanda({
        idMesa,
        idUsuario,
        idReserva: reservaActiva?.idReserva ?? null,
    });
}

export function mapTicketRows(rows: MesaLineaComandaRow[]): TicketItem[] {
    const mapped: TicketItem[] = rows.map((r) => {
        const pasa = r.Pasa_Cocina === 1;
        return {
            id: r.ID_Detalle,
            productoId: r.ID_Producto,
            nombre: r.Nombre,
            precio: r.Precio_Unitario,
            pagado: r.Pagado === 1,
            seleccionado: false,
            estadoCocina: pasa ? r.Estado_Cocina || "PENDIENTE" : "NO_COCINA",
            pasaCocina: pasa,
            notas: r.Notas,
            // Tipo de IVA congelado en la línea al venderla (null = el del negocio). Va al ticket.
            iva_percent: r.IVA_Percent ?? null,
        };
    });
    const hayPendientes = mapped.some((t) => !t.pagado);
    if (!hayPendientes) return [];
    return mapped;
}

export async function loadTicketForComanda(idComanda: string): Promise<TicketItem[]> {
    const rows = await mesasLoadTicket(idComanda);
    return mapTicketRows(rows);
}

export async function addDetalle(
    idComanda: string,
    p: ProductoDisplay,
    operadorId: string | null,
): Promise<TicketItem[]> {
    const rows = await mesasAddDetalle({
        idComanda,
        idProducto: p.ID_Producto,
        cantidad: 1,
        idUsuario: operadorId,
    });
    return mapTicketRows(rows);
}

export async function removeOnePendingDetalle(idComanda: string, productoId: string) {
    await mesasRemoveOnePendingDetalle({ idComanda, idProducto: productoId });
}

export async function deleteDetalleById(idDetalle: string) {
    await mesasDeleteDetalle(idDetalle);
}

export function fmtReserva(res: NonNullable<MesaMetaOut["reserva"]>) {
    const min = res.minutosPara;
    if (res.estado === "ACTIVA") {
        if (min < 0) return `Reserva activa · llegó hace ${Math.abs(min)} min`;
        return `Reserva activa · es ahora`;
    }
    // Pasada su hora, la que aún no ha llegado sigue por llegar, con retraso.
    if (min < 0) return `llega tarde: ${-min} min`;
    return `Reserva en ${min} min`;
}
