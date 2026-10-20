// El estado de una reserva tal como lo enseña la pantalla. Los valores son los de `Reservas.Estado`
// (`tpv_domain::estados::EstadoReserva`): PROXIMA (aún no ha llegado), ACTIVA (el cliente está en la
// mesa), FINALIZADA (ya se fue), CANCELADA y NO_SHOW (no vino).
//
// Las dos primeras están vivas: ocupan la mesa y cuentan en el calendario. Las otras tres están
// cerradas: se ven atenuadas al final de la lista. Es la misma regla que el SQL de los solapes
// (`SQL_CHOQUE_RESERVA`: `Estado NOT IN ('CANCELADA','NO_SHOW','FINALIZADA')`).
import type { ReservaDto } from "@tpv/contracts";

const ETIQUETAS: Record<string, string> = {
    PROXIMA: "Próxima",
    ACTIVA: "En la mesa",
    FINALIZADA: "Terminada",
    CANCELADA: "Cancelada",
    NO_SHOW: "No vino",
};

/** ¿Sigue viva? Ocupa la mesa y cuenta en el calendario. */
export function ocupaMesa(estado: string): boolean {
    return estado !== "FINALIZADA" && estado !== "CANCELADA" && estado !== "NO_SHOW";
}

/** El estado como se lee en pantalla: «Cancelada», no `CANCELADA`. */
export function etiquetaEstado(estado: string): string {
    return ETIQUETAS[estado] ?? estado;
}

/** Las del día: primero las vivas y después las cerradas, cada grupo por hora. */
export function ordenarDelDia<R extends Pick<ReservaDto, "estado" | "hora">>(reservas: R[]): R[] {
    return [...reservas].sort(
        (a, b) => Number(!ocupaMesa(a.estado)) - Number(!ocupaMesa(b.estado)) || a.hora.localeCompare(b.hora),
    );
}

const CERRADAS: [estado: string, una: string, varias: string][] = [
    ["CANCELADA", "cancelada", "canceladas"],
    ["FINALIZADA", "terminada", "terminadas"],
    ["NO_SHOW", "no vino", "no vinieron"],
];

/** «Total: 2 · 1 cancelada»: el total cuenta sólo las vivas, y las cerradas van detrás. */
export function resumenDelDia(reservas: Pick<ReservaDto, "estado">[]): string {
    const partes = [`Total: ${reservas.filter((r) => ocupaMesa(r.estado)).length}`];
    for (const [estado, una, varias] of CERRADAS) {
        const n = reservas.filter((r) => r.estado === estado).length;
        if (n > 0) partes.push(`${n} ${n === 1 ? una : varias}`);
    }
    return partes.join(" · ");
}
