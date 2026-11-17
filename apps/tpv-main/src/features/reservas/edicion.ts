// RES-INC-03 / SYN-INC-04: el formulario que edita una reserva mientras otro equipo la cambia.
//
// Antes se guardaba con todo lo que el formulario cargó al abrirse: la Handy que sólo tocó la nota
// volvía a escribir los comensales que la Main acababa de cambiar, y un formulario abierto mientras
// la cancelaban la cambiaba igual. Ahora:
// - lo que llega de otro equipo con el formulario abierto entra en los campos que no se han
//   tocado, y los tocados se quedan como los dejó quien edita (`rebasar`);
// - al guardar se manda lo que el formulario tiene por visto (`vistoDe`), y el backend no guarda si
//   la reserva ya no está así (lo que se cruce antes de que llegue la réplica);
// - si se cierra, se borra o se mueve de día, el formulario lo dice y no deja guardar.
import type { ReservaDto, ReservaVistaDto } from "@tpv/contracts";

import { ocupaMesa } from "./estadoReserva";

export type FormReserva = {
    nombreCliente: string;
    telefono: string;
    email: string;
    hora: string;
    comensales: number;
    /** `null` = la duración por defecto del negocio. */
    duracionMin: number | null;
    nota: string;
    idZona: string;
    idMesa: string;
};

/** El formulario con lo que tiene una reserva. */
export function formDeReserva(r: ReservaDto): FormReserva {
    return {
        nombreCliente: r.nombre_cliente,
        telefono: r.telefono_cliente ?? "",
        email: r.email_cliente ?? "",
        hora: r.hora,
        comensales: r.comensales,
        duracionMin: r.duracion_min,
        nota: r.nota ?? "",
        idZona: r.id_zona,
        idMesa: r.id_mesa,
    };
}

const CAMPOS: (keyof FormReserva)[] = [
    "nombreCliente", "telefono", "email", "hora", "comensales", "duracionMin", "nota", "idZona", "idMesa",
];

/**
 * El formulario tras llegar `fresca`, que era `base` cuando se cargó: cada campo que sigue como en
 * `base` (no se ha tocado) toma el valor de `fresca`; los tocados se quedan.
 */
export function rebasar(form: FormReserva, base: ReservaDto, fresca: ReservaDto): FormReserva {
    const antes = formDeReserva(base);
    const ahora = formDeReserva(fresca);
    const out = { ...form };
    for (const k of CAMPOS) {
        if (form[k] === antes[k]) (out as Record<string, unknown>)[k] = ahora[k];
    }
    return out;
}

/** ¿Siguen los datos del cliente como estaban? Entonces el cliente asignado es el de la reserva. */
export function clienteSinTocar(form: FormReserva, base: ReservaDto): boolean {
    const antes = formDeReserva(base);
    return form.nombreCliente === antes.nombreCliente && form.telefono === antes.telefono && form.email === antes.email;
}

/** Lo que se manda como visto: los valores de la lectura de la reserva. */
export function vistoDe(r: ReservaDto): ReservaVistaDto {
    return {
        id_mesa: r.id_mesa,
        dia_ymd: r.dia_ymd,
        hora: r.hora,
        comensales: r.comensales,
        duracion_min: r.duracion_min,
        nota: r.nota,
        id_cliente: r.id_cliente,
    };
}

/**
 * Por qué ya no se puede guardar lo que se edita, o `null`. `fresca` es la reserva en la lista del
 * mes (sin ella: se ha borrado o se ha ido a otro mes); `dia`, el día en el que se edita.
 */
export function motivoParaNoGuardar(fresca: ReservaDto | undefined, dia: string): string | null {
    if (!fresca) return "Esta reserva ya no está en este día: en otro equipo se ha borrado o se ha movido.";
    if (!ocupaMesa(fresca.estado)) return "Esta reserva se ha cerrado en otro equipo (cancelada, terminada o no vino): ya no se puede cambiar.";
    if (fresca.dia_ymd !== dia) return "Esta reserva se ha movido a otro día en otro equipo. Ábrela en su día.";
    return null;
}
