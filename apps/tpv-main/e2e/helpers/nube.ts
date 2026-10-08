// Esperar a que la nube esté al día con este equipo.
//
// Lo quieren dos recorridos por motivos distintos, y en los dos es la diferencia entre un test
// determinista y una carrera:
//
//   · copias, porque una copia tomada con el outbox a medias no coincide con lo que la nube conoce
//     y la reconciliación del tramo siguiente no converge;
//   · licencia, porque lo que prueba es que anular la licencia **corta el socket**, y para eso el
//     socket tiene que estar abierto. Sin esta espera, un equipo que nunca llegó a conectarse se
//     bloquearía igual —su primer ticket ya sería un 403— y el test pasaría sin haber probado nada.

import { browser } from "@wdio/globals";

import { leerDeLaApp } from "./ui.js";

export type Salud = {
    outbox_pending: number;
    last_seq: number;
    failing: number;
    quarantined: number;
    /** SYNC-20 · dirección de SUBIDA: rechazos acumulados que aún se reintentan. */
    subida_fallando: number;
    /** SYNC-20 · dirección de SUBIDA: operaciones que la nube no va a aceptar nunca. */
    subida_en_cuarentena: number;
};

/**
 * Espera a que no quede nada por subir ni nada en cuarentena, **en las dos direcciones**.
 *
 * Que el outbox llegue a cero es además la única señal que el IPC ofrece de que el WebSocket está
 * conectado de verdad: el estado de la conexión vive en un store de React, no en un comando.
 *
 * ⚠️ `subida_en_cuarentena` NO es opcional aquí, y es lo que impide que SYNC-20 debilite este
 * recorrido sin que se note. Desde que una operación rechazada se aparta en vez de atascar la cola,
 * `outbox_pending` puede llegar a cero **rindiéndose**: la nube no tendría ese dato y el test daría
 * verde igual. Comprobar las dos cosas es la diferencia entre "la nube está al día" y "ya no queda
 * nadie intentándolo".
 */
export async function esperarNubeAlDia(timeout = 180_000): Promise<Salud> {
    let ultima: Salud | null = null;

    const alDia = await browser
        .waitUntil(
            async () => {
                ultima = await leerDeLaApp("sync_health");
                return (
                    ultima.outbox_pending === 0 &&
                    ultima.quarantined === 0 &&
                    ultima.subida_en_cuarentena === 0
                );
            },
            { timeout },
        )
        .then(
            () => true,
            () => false,
        );

    if (!alDia) {
        throw new Error(`La nube no llegó a tener todo lo de este equipo: ${JSON.stringify(ultima)}`);
    }

    return ultima as unknown as Salud;
}
