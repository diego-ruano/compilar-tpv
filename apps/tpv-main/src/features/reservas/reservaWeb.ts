// Reservas desde la web (docs/estudios/reservas-web.md §5.6): una reserva que hizo el cliente desde
// la web y aún está por venir no se cambia ni se cancela sin avisar, porque al cliente le llega un
// correo. La regla de qué le importa es la de `use_cases/reservas.rs::aviso_al_cliente`, que es la
// que decide de verdad si sale el correo: aquí sólo se pregunta antes.
import type { ReservaDto } from "@tpv/contracts";

/** «2026-10-20 17:30»: como se comparan el día y la hora de una reserva. */
function minutoLocal(d: Date): string {
    const dos = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${dos(d.getMonth() + 1)}-${dos(d.getDate())} ${dos(d.getHours())}:${dos(d.getMinutes())}`;
}

/**
 * Una reserva web que aún está por venir: cambiarla o cancelarla le escribe al cliente. Por venir es
 * que no ha llegado (`PROXIMA`) y que su hora no ha pasado: el aviso de una que ya pasó lo descarta la
 * cola sin mandarlo (`use_cases/reservas_web_avisos.rs`), y la pantalla no puede prometer el correo.
 */
export function esWebPorVenir(
    r: Pick<ReservaDto, "origen" | "estado" | "dia_ymd" | "hora">,
    ahora: Date = new Date(),
): boolean {
    return r.origen === "WEB" && r.estado === "PROXIMA" && `${r.dia_ymd} ${r.hora}` > minutoLocal(ahora);
}

/**
 * ¿Cancelarla le escribe al cliente? Si está por venir y su cliente tiene correo: sin correo no hay a
 * quién (`/avisos` contesta `enviado: false`), y la pantalla no lo puede prometer.
 */
export function cancelarLeEscribe(
    r: Pick<ReservaDto, "origen" | "estado" | "dia_ymd" | "hora" | "email_cliente">,
    ahora: Date = new Date(),
): boolean {
    return esWebPorVenir(r, ahora) && !!r.email_cliente?.trim();
}

/**
 * El correo al que irá el aviso de un cambio: el del cliente que lleve la reserva al guardarla. Uno
 * que ya existe conserva el suyo, y lo escrito sólo rellena el hueco (RES-01); uno nuevo, el escrito;
 * sin cliente, ninguno.
 */
export function correoTrasGuardar(
    cliente: { idCliente: string | null; nombreCliente: string | null; email: string | null },
    correoDelExistente: string | null,
): string | null {
    if (cliente.idCliente) return correoDelExistente?.trim() || cliente.email || null;
    if (cliente.nombreCliente) return cliente.email || null;
    return null;
}

/** Lo que el formulario va a guardar de lo que le importa al cliente. */
export type CambioDeReserva = { dia_ymd: string; hora: string; comensales: number; id_mesa: string | null };

/** ¿Le cambia algo al cliente? Otro día, otra hora, otras personas u otra mesa; una nota, no. */
export function cambiaParaElCliente(antes: ReservaDto, despues: CambioDeReserva): boolean {
    return (
        antes.dia_ymd !== despues.dia_ymd ||
        antes.hora !== despues.hora ||
        antes.comensales !== despues.comensales ||
        (antes.id_mesa || "") !== (despues.id_mesa || "")
    );
}
