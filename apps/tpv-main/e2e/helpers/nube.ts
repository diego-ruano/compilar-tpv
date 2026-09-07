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
};

/**
 * Espera a que no quede nada por subir ni nada en cuarentena.
 *
 * Que el outbox llegue a cero es además la única señal que el IPC ofrece de que el WebSocket está
 * conectado de verdad: el estado de la conexión vive en un store de React, no en un comando.
 */
export async function esperarNubeAlDia(timeout = 180_000): Promise<Salud> {
    let ultima: Salud | null = null;

    const alDia = await browser
        .waitUntil(
            async () => {
                ultima = await leerDeLaApp<Salud>("sync_health");
                return ultima.outbox_pending === 0 && ultima.quarantined === 0;
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
