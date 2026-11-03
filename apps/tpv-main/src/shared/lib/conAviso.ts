import { toAppError } from "@tpv/client";
import { captureException } from "../observability/sentry";
import { avisosFueraDeReact } from "../toast";

/**
 * Convierte una función asíncrona en un manejador que no pierde su error.
 *
 * React —y `setTimeout`, y cualquier callback que espere `void`— llama al manejador y tira lo que
 * devuelve: si es una promesa que rechaza, nadie la recoge. El `GlobalErrorListener` la manda a
 * Sentry, pero quien pulsó el botón no se entera: pulsa «Guardar» y no pasa nada, que es la forma
 * del bug FIS-01. Esto hace lo que faltaba: la reporta **y** lo dice en pantalla. Lo exige la regla
 * `@typescript-eslint/no-misused-promises` (ver `eslint.config.mjs`).
 *
 * Si la función ya captura sus errores y avisa por su cuenta, esto no hace nada —una promesa que no
 * rechaza no llega al `catch`—, así que se puede usar sin mirar dentro.
 *
 * Lo que NO es: un sustituto del `try/catch` del caso concreto. Un aviso genérico dice que algo ha
 * fallado; el manejador que sabe qué estaba haciendo puede decir qué y dejar la pantalla como
 * corresponde (el modal abierto, el botón habilitado otra vez). Esto es la red, no el trapecio.
 */
export function conAviso<A extends unknown[]>(
    fn: (...args: A) => unknown,
    titulo = "No se ha podido completar la acción",
): (...args: A) => void {
    return (...args) => {
        // Un error SÍNCRONO no se captura a propósito: sigue llegando a `window.onerror`, que es
        // quien sabe que la interfaz ha quedado en un estado indefinido.
        Promise.resolve(fn(...args)).catch((e: unknown) => avisarDelFallo(titulo, e));
    };
}

/**
 * Reporta un fallo a Sentry —si no lo registró ya `invocar`— y lo enseña en pantalla (o en
 * consola, si no hay avisos montados).
 */
export function avisarDelFallo(titulo: string, e: unknown): void {
    captureException(e, { titulo });
    const avisos = avisosFueraDeReact();
    if (avisos) avisos.error(titulo, toAppError(e).message);
    else console.error(titulo, e);
}
