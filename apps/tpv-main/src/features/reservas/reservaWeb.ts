// Reservas desde la web (docs/estudios/reservas-web.md §5.6): una reserva que hizo el cliente desde
// la web y aún está por venir no se cambia ni se borra sin avisar, porque al cliente le llega un
// correo. La regla de qué le importa es la de `use_cases/reservas.rs::aviso_al_cliente`, que es la
// que decide de verdad si sale el correo: aquí sólo se pregunta antes.
import type { ReservaDto } from "@tpv/contracts";

/** Una reserva web que aún está por venir: cambiarla o borrarla le escribe al cliente. */
export function esWebPorVenir(r: Pick<ReservaDto, "origen" | "estado">): boolean {
    return r.origen === "WEB" && r.estado === "PROXIMA";
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
