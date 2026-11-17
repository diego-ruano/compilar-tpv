// RES-MEJ-02: una reserva de 5 en una mesa de 4 se guardaba sin que nadie lo dijera. No se impide (en
// un bar se juntan sillas), pero se avisa antes de guardar.

/** «Mesa 1 · 4 plazas». */
export function mesaConPlazas(numero: string, capacidad: number): string {
    return capacidad > 0 ? `${numero} · ${capacidad} ${capacidad === 1 ? "plaza" : "plazas"}` : numero;
}

/** El aviso si son más que las plazas de la mesa, o `null`. Una mesa sin plazas apuntadas no avisa. */
export function avisoDeAforo(comensales: number, capacidad: number): string | null {
    if (!(capacidad > 0) || !(comensales > capacidad)) return null;
    return `Son ${comensales} y la mesa es de ${capacidad}. Se puede guardar igualmente.`;
}
