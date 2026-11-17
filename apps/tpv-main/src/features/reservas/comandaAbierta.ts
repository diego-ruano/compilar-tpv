// RES-04: una mesa con una comanda abierta no se puede reservar para hoy, a ninguna hora (no se sabe
// cuándo se irán quienes están sentados); para mañana sí. Es la misma regla que el backend
// (`SQL_CHOQUE_COMANDA` en la Main, `chocaConUnaComanda` en el worker): aquí sólo se enseña antes de
// guardar.
import type { MesaMetaOut, ReservaDto } from "@tpv/contracts";

/**
 * Lo que pinta el plano para elegir mesa: con el día de hoy, las mesas con comanda abierta como
 * ocupadas (igual que en Mesas), sin su reserva; otro día, ninguna.
 */
export function mesasConComandaHoy(
    meta: Record<string, MesaMetaOut> | undefined,
    esHoy: boolean,
): Record<string, MesaMetaOut> {
    const out: Record<string, MesaMetaOut> = {};
    if (!esHoy) return out;
    for (const [id, m] of Object.entries(meta ?? {})) {
        const { reserva: _reserva, ...comanda } = m;
        if (m.ocupada) out[id] = { ...comanda, estado: "PENDIENTE" };
    }
    return out;
}

/**
 * ¿La comanda abierta de la mesa elegida impide guardar? No, si la reserva que se edita ya era de
 * esa mesa ese día: cambiarle algo no crea el choque.
 */
export function comandaImpideReservar(
    conComanda: Record<string, MesaMetaOut>,
    idMesa: string,
    dia: string,
    editada: Pick<ReservaDto, "id_mesa" | "dia_ymd"> | undefined,
): boolean {
    if (!idMesa || !conComanda[idMesa]) return false;
    return !(editada && editada.id_mesa === idMesa && editada.dia_ymd === dia);
}
