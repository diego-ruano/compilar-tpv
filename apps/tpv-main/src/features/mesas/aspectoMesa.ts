// El aspecto de una mesa en la sala de la Main: su color y sus textos según lo que pasa en ella.
// El dibujo es el del plano compartido (`@tpv/plano`), el mismo del widget de reservas web.

import type { MesaMetaOut } from "@tpv/contracts";
import type { AspectoMesa } from "@tpv/plano";

import type { Table } from "./types";
import { parseMesaId } from "./ParseMesaId";

type MesaMetaMap = Record<number, MesaMetaOut> & Record<string, MesaMetaOut>;

export function aspectoDeMesa(table: Table, mesaMetaById: MesaMetaMap, dark: boolean): AspectoMesa {
    const idMesa = parseMesaId(table.id);

    // `parseMesaId` devuelve el UUID puro, que es la clave con la que `mesasLoadMesaMeta`
    // indexa el mapa. Un único lookup directo.
    const meta: MesaMetaOut | undefined = idMesa ? mesaMetaById[idMesa] : undefined;

    const reserva = meta?.reserva ?? null;
    const isReservaActiva = reserva?.estado === "ACTIVA";
    const isReservaProxima = reserva?.estado === "PROXIMA";

    // Pendiente: lo dice el estado, y si no, que quede algo por cobrar o por preparar.
    const isPendiente =
        !!meta &&
        (meta.estado === "PENDIENTE" || meta.pendientesPago > 0 || meta.totalPendiente > 0 || meta.pendientesCocina > 0);

    // Prioridad: pendiente (naranja) > reserva activa (azul) > reserva próxima (borde azul) > libre.
    // "libre": oscuro sobre lienzo claro; un slate medio sobre lienzo oscuro.
    const libreFill = dark ? "rgba(71,85,105,0.95)" : "rgba(15,23,42,0.92)";

    const relleno = isPendiente ? "rgba(245,158,11,0.92)" : isReservaActiva ? "rgba(37,99,235,0.92)" : libreFill;
    const borde = isPendiente
        ? "rgba(245,158,11,0.92)"
        : isReservaProxima
            ? "rgba(37,99,235,0.95)"
            : "rgba(148,163,184,0.95)";
    const grosorBorde = isPendiente ? 3 : isReservaProxima ? 4 : 1;

    // Sobre amber (pendiente) el texto oscuro tiene más contraste; sobre slate/blue el claro.
    const texto = isPendiente ? "#1c1917" : "#e5e7eb";
    const subtexto = isPendiente ? "#44403c" : "#cbd5e1";

    const etiqueta =
        isReservaActiva && reserva?.clienteNombre ? `${table.name} · Reserva ${reserva.clienteNombre}` : table.name;
    const subetiqueta =
        isReservaProxima && reserva?.clienteNombre
            ? `Reserva ${reserva.clienteNombre} en ${Math.max(0, reserva.minutosPara)} min`
            : `${table.seats} pax`;

    return { relleno, borde, grosorBorde, texto, subtexto, etiqueta, subetiqueta, pulsable: !!idMesa };
}
