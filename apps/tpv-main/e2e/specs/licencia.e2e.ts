// Qué hace el TPV cuando la licencia deja de valer.
//
// Es lo más tedioso de probar a mano y lo más caro de descubrir tarde: si el bloqueo no funciona,
// alguien sigue vendiendo con una licencia anulada; y si funciona de más, un cliente al día se
// queda sin caja en hora punta. Nadie lo mira porque para verlo hay que esperar meses (caducidad) o
// romperle la licencia a alguien (anulación).
//
// Los dos casos se provocan por el API de administración: `shorten` mueve la caducidad al pasado y
// `revoke`/`unrevoke` anulan y deshacen. La licencia es de esta tanda, así que romperla no le hace
// nada a los demás recorridos.
//
// ⚠️ El pulso que se entera del cambio es el job `licencia`, cada 6 horas, y en la aplicación NO hay
// ningún botón de "comprobar ahora" mientras todo va bien (sólo aparece uno —«Reintentar»— cuando ya
// estás bloqueado, y ése sí se usa aquí al final). Como no se pueden esperar seis horas, el
// recorrido llama a `license_check_now`, que es exactamente lo que ejecuta el job.

import { $, browser, expect } from "@wdio/globals";

import { activarLicencia, estrenarEquipo, ficharYEntrar } from "../helpers/arranque.js";
import { cargarDotEnv } from "../helpers/entorno.js";
import { acortar, alargar, desrevocar, revocar } from "../helpers/licencias.js";
import { conTexto, leerDeLaApp, pulsar } from "../helpers/ui.js";

cargarDotEnv();

const NEGOCIO = "Bar E2E licencia";
const PIN = "9012";

/** El id de la licencia de esta tanda, para poder manipularla desde el API de administración. */
function idLicencia(): string {
    const id = process.env.TPV_E2E_LICENCIA_ID_LICENCIA;
    if (!id) throw new Error("Falta TPV_E2E_LICENCIA_ID_LICENCIA (lo pone onPrepare).");
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
    it("1 · estrena el equipo con una licencia buena", async () => {
        await estrenarEquipo(NEGOCIO, PIN);
    });

    it("2 · anulada: el TPV deja de trabajar y vuelve a pedir la licencia", async () => {
        await revocar(idLicencia());

        const gate = await comprobarLicencia();
        expect(gate.allowed).toBe(false);
        expect(gate.reason).toBe("revoked");

        // Con la app abierta, esto es lo que ve el TPV, y lo ve EN EL ACTO: el comando emite
        // `license:changed` y la pantalla se bloquea sin que nadie recargue nada.
        await conTexto("h1", "Licencia anulada").waitForDisplayed({ timeout: 60_000 });

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
