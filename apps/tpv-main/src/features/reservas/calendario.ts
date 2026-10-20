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
