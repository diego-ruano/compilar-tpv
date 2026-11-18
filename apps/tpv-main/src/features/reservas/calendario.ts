// El calendario de la pantalla de Reservas: el día elegido va siempre con el mes que se ve. La lista
// del día sale de las reservas del mes cargado, así que un día de otro mes salía vacío («No hay
// reservas para este día») aunque las tuviera.

/** ¿Caen en el mismo mes? */
export function mismoMes(a: Date, b: Date): boolean {
    return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth();
}

/** El día que se elige al pasar a otro mes: hoy si cae en él; si no, el día 1. */
export function diaAlCambiarDeMes(mes: Date, hoy: Date): Date {
    return mismoMes(mes, hoy) ? hoy : new Date(mes.getFullYear(), mes.getMonth(), 1);
}

/** El día de un `YYYY-MM-DD`, a medianoche local, o `null` si no es un día del calendario (un 30 de
 *  febrero, un texto cualquiera). */
export function diaDeYmd(ymd: unknown): Date | null {
    if (typeof ymd !== "string") return null;
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
    if (!m) return null;
    const [a, mes, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    const dia = new Date(a, mes - 1, d);
    return dia.getFullYear() === a && dia.getMonth() === mes - 1 && dia.getDate() === d ? dia : null;
}

/** La reserva a la que lleva un aviso (`state` de la navegación, `features/notificaciones/acciones.ts`). */
export type ReservaAvisada = { id_reserva: string; dia_ymd: string };

/** La reserva que trae el estado de la navegación, si es válida: su id y un día que existe. */
export function reservaAvisada(state: unknown): (ReservaAvisada & { dia: Date }) | null {
    const r = (state as { reserva?: unknown } | null | undefined)?.reserva as Partial<ReservaAvisada> | undefined;
    if (!r || typeof r.id_reserva !== "string" || !r.id_reserva.trim()) return null;
    const dia = diaDeYmd(r.dia_ymd);
    return dia ? { id_reserva: r.id_reserva, dia_ymd: r.dia_ymd as string, dia } : null;
}
