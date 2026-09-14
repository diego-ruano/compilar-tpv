// Qué hace el TPV cuando la licencia deja de valer.
//
// Es lo más tedioso de probar a mano y lo más caro de descubrir tarde: si el bloqueo no funciona,
// alguien sigue vendiendo con una licencia anulada; y si funciona de más, un cliente al día se
// queda sin caja en hora punta. Nadie lo mira porque para verlo hay que esperar meses (caducidad) o
// romperle la licencia a alguien (anulación).
//
// Los dos casos se provocan por el API de administración: `shorten` mueve la caducidad al pasado y
// `revoke`/`unrevoke` anulan y deshacen. La licencia es la de la tanda y el equipo es el que dejaron
// los recorridos anteriores, así que éste va el ÚLTIMO: romperle la licencia deja inservible el
// equipo que comparten todos.
//
// Hay DOS pulsos que enteran al equipo de que su licencia ha cambiado, y el recorrido usa los dos:
//
//   · **anular empuja**: el endpoint de administración le pide al `TenantHub` que cierre el socket
//     de la Main, y el rechazo del ticket al reconectar es lo que dispara el bloqueo. Por eso este
//     recorrido corre con la NUBE ENCENDIDA: sin socket abierto no hay nada que cortar, y el test
//     pasaría sin haber probado el camino. Se comprueba SIN llamar a nada, mirando la pantalla.
//   · **caducar no empuja**: nadie avisa a nadie, se descubre en la siguiente vuelta del job
//     `licencia` —cada 6 horas— y en la aplicación no hay botón de "comprobar ahora" mientras todo
//     va bien (sólo aparece uno —«Reintentar»— cuando ya estás bloqueado, y ése sí se usa al
//     final). Como no se pueden esperar seis horas, ahí el recorrido llama a `license_check_now`,
//     que es exactamente lo que ejecuta el job.

import { $, browser, expect } from "@wdio/globals";

import { activarLicencia, ficharYEntrar } from "../helpers/arranque.js";
import { cargarDotEnv } from "../helpers/entorno.js";
import { NEGOCIO, PIN } from "../helpers/equipo.js";
import { acortar, alargar, desrevocar, revocar } from "../helpers/licencias.js";
import { esperarNubeAlDia } from "../helpers/nube.js";
import { conTexto, leerDeLaApp, pulsar } from "../helpers/ui.js";

cargarDotEnv();

/** El id de la licencia de esta tanda, para poder manipularla desde el API de administración. */
function idLicencia(): string {
    const id = process.env.TPV_E2E_LICENCIA_ID;
    if (!id) throw new Error("Falta TPV_E2E_LICENCIA_ID (lo pone onPrepare).");
    return id;
}

type Gate = { allowed: boolean; reason: string | null };

/**
 * Hace lo que haría el job `licencia` en su siguiente vuelta.
 *
 * No hace falta recargar nada: `license_check_now` emite `license:changed` y la pantalla se entera
 * sola. Que sea así importa fuera del test — es lo que permite que el WebSocket, cuando la nube le
 * rechaza el ticket por licencia, convierta ese rechazo en un bloqueo de verdad en vez de dejarlo
 * en un badge de conectividad mientras el TPV sigue vendiendo.
 *
 * Devuelve lo que contestó el gate, que es donde se ve el motivo exacto: la pantalla lo traduce a
 * un título (o a otra pantalla entera), pero el motivo es lo que decide.
 */
async function comprobarLicencia(): Promise<Gate> {
    return leerDeLaApp<Gate>("license_check_now");
}

describe("La licencia deja de valer", () => {
    it("1 · vuelve a entrar en el equipo, con la licencia buena y conectado", async () => {
        await ficharYEntrar(PIN);

        // Que el outbox llegue a cero prueba que el WebSocket está abierto, que es la premisa del
        // paso siguiente. Sin esta espera, un equipo que nunca llegó a conectarse se bloquearía
        // igual —su primer ticket ya sería un 403— y el test daría verde sin probar el empujón.
        await esperarNubeAlDia();
    });

    it("2 · anulada: el TPV deja de trabajar SOLO, sin que nadie le pregunte", async () => {
        await revocar(idLicencia());

        // Y aquí no se llama a nada. La cadena entera tiene que ocurrir por su cuenta: el endpoint
        // de administración avisa al `TenantHub`, éste cierra el socket de la Main, el cliente
        // reconecta a los 3 s, `/v1/ws/ticket` le contesta 403, `useMainSocket` convierte ese
        // rechazo en un `license_check_now` y el `license:changed` que emite tapa la aplicación.
        //
        // Es lo único que separa "se entera en segundos" de "se entera dentro de seis horas", y
        // ninguna de esas piezas está probada por las otras: cada una vive en un proceso distinto.
        // Y ese título ES el motivo: `blockedCopy` ramifica por él, y una caducidad diría "Licencia
        // caducada". Preguntarle al gate por segunda vez no serviría: la comprobación que acaba de
        // hacer la aplicación ya borró el estado local —un rechazo definitivo lo borra a propósito—
        // así que a partir de aquí contesta `needs_activation`, que es el paso siguiente y no éste.
        //
        // ⚠️ La espera es CORTA a propósito, y no se puede alargar sin romper lo que prueba. El job
        // `licencia` tiene `retardo_inicial` de 2 minutos, o sea que con una espera generosa el
        // bloqueo podría llegar por el job —exactamente lo que este paso existe para descartar— y
        // el test daría verde con el empujón roto. Por el socket tarda unos segundos: cerrar,
        // reconectar (backoff base 3 s) y un `license_check_now`. Se comprobó quitando el aviso al
        // `TenantHub` en el worker: sin él, este paso falla.
        await conTexto("h1", "Licencia anulada").waitForDisplayed({ timeout: 45_000 });

        // Al reiniciar ya no hay estado que bloquear: un rechazo definitivo (`revoked`,
        // `device_replaced`, `license_not_found`) **borra el estado local** a propósito, así que el
        // equipo cae en la pantalla de activar. Son dos pantallas distintas del mismo hecho y las
        // dos tienen que contarlo.
        await browser.refresh();
        await conTexto("h1", "Activa tu TPV").waitForDisplayed({ timeout: 60_000 });

        // Y esa segunda explica por qué se está ahí. Sin el aviso es idéntica a la de un TPV recién
        // instalado, y quien llega no sabe si le han anulado la licencia o si tocó algo.
        await conTexto("p", "Esta licencia fue anulada").waitForDisplayed({ timeout: 20_000 });
    });

    it("3 · deshecha la anulación, la misma clave vuelve a activar", async () => {
        // Es el caso de "revoqué la que no era". Sin `unrevoke` la única salida era emitir otra
        // licencia y hacer pasar al cliente por el cambio de dispositivo, con su OTP por correo.
        await desrevocar(idLicencia());

        // Va directo al login: el equipo conserva sus usuarios, así que no hay setup que repetir.
        // Eso es lo que convierte una revocación por error en un susto y no en una pérdida.
        const destino = await activarLicencia(NEGOCIO);
        expect(destino).toBe("login");

        await ficharYEntrar(PIN);
    });

    it("4 · caducada: se bloquea, y por caducidad, no por otra cosa", async () => {
        // Dos años atrás: bastante para dejar atrás también el periodo de gracia, que a propósito
        // deja seguir vendiendo unos días (vender sin replicar es la peor combinación).
        const acortada = await acortar(idLicencia(), 24);
        expect(acortada.caducada).toBe(true);

        const gate = await comprobarLicencia();
        expect(gate.allowed).toBe(false);
        expect(gate.reason).toBe("expired");

        // Una caducidad NO borra el estado local —la licencia sigue siendo de este equipo, sólo que
        // vencida—, así que aquí sí sale la pantalla de bloqueo con su explicación.
        await conTexto("h1", "Licencia caducada").waitForDisplayed({ timeout: 60_000 });
    });

    it("5 · renovada, el propio botón de reintentar la desbloquea", async () => {
        await alargar(idLicencia(), 12);

        // Por el camino del usuario: el botón que la pantalla de bloqueo ofrece, que es el único
        // sitio de la aplicación desde donde se puede forzar una comprobación.
        await pulsar("Reintentar comprobación");

        // Se vuelve a DONDE SE ESTABA, no al login: el bloqueo tapa la aplicación pero no cierra la
        // sesión. Es lo que hay que querer en un bar a media faena — quien renueva la licencia no
        // tiene por qué volver a fichar y teclear el PIN con la cola esperando.
        await $('a[href="/Inventario"]').waitForDisplayed({ timeout: 60_000 });
    });
});
