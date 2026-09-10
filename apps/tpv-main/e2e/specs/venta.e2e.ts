// TEST-01 · Un E2E del camino del dinero.
//
// Un solo recorrido, en orden, sobre la app COMPILADA: React → IPC de Tauri → comandos Rust →
// SQLite → y vuelta. No cubre el frontend ni lo pretende: comprueba que esa costura aguanta, que
// es lo único que hoy no mira ningún test.
//
// Los pasos 1-4 (activación, PIN, login) parecen andamiaje y no lo son: son el estreno de un
// cliente real, y tampoco los prueba nadie.
//
// El recorrido está pensado para que la última cifra lo verifique todo: si algo se rompe entre
// React y SQLite, el arqueo del paso 9 deja de cuadrar.
//
// Los gestos de montar la carta, abrir la mesa y cobrar viven en `helpers/vender.ts` porque los
// comparte con `fiscal.e2e.ts`. Un recorrido NO puede importar a otro —importar un spec lo
// EJECUTA—, así que lo común va en `helpers/`.

import fs from "node:fs";
import path from "node:path";

import { $, browser, expect } from "@wdio/globals";

import {
    activarLicencia,
    elegirModoTpv,
    elegirPin,
    ficharYEntrar,
} from "../helpers/arranque.js";
import { APP_ID_E2E, cargarDotEnv, dirDatosE2E } from "../helpers/entorno.js";
import { declararDatosFiscales } from "../helpers/fiscal.js";
import { conTexto, irA, leerDeLaApp, literalXPath, pulsar, pulsarXPath } from "../helpers/ui.js";
import {
    abrirMesa,
    anadirLineas,
    cerrarElModalDeLaMesa,
    cobrarTodoEnEfectivo,
    crearZonaConMesa,
    entradasDeCaja,
    esperarMesaLibre,
    esperarTotalPendiente,
    estadoDeMesa,
    montarLaCarta,
    type Producto,
} from "../helpers/vender.js";

cargarDotEnv();

/* ── Los datos del recorrido ──────────────────────────────────────────────────
   Elegidos para que las cuentas salgan redondas y un descuadre se vea a simple
   vista: 2 × 5,00 € = 10,00 €, que se paga con UN billete de 10 y se cuenta con
   UN billete de 10. Con fondo de partida 0, lo que debería haber en el cajón es
   exactamente lo cobrado.                                                     */
const NEGOCIO = "Bar E2E TEST-01";
const PIN = "4321"; // distinto del 1234 del seed: así el login prueba el PIN elegido, no el sembrado
const ZONA = "Salón E2E";
const MESA = "M1";
const UNIDADES = 2;
const TOTAL = "10,00";

const PRODUCTO: Producto = {
    categoria: "Bebidas E2E",
    nombre: "Caña E2E",
    precio: "5.00",
    iva: "10",
};

/** El id de la mesa creada por el test (UUID de la BD). Lo rellena el paso 5b. */
let idMesa = "";

describe("El camino del dinero", () => {
    it("1 · arranca en un equipo recién instalado", async () => {
        const titulo = conTexto("h1", "¿Cómo vas a usar este dispositivo?");
        await titulo.waitForDisplayed({ timeout: 60_000 });
    });

    it("2 · se configura como TPV y activa la licencia contra el worker real", async () => {
        await elegirModoTpv();

        // La comprobación que sostiene el montaje entero: elegir modo TPV es lo que abre la base, y
        // esa base tiene que nacer en la carpeta del identificador de E2E. Si apareciera en la de
        // producción, este test estaría vendiendo contra los datos de trabajo del equipo.
        const dir = dirDatosE2E();
        expect(dir.endsWith(APP_ID_E2E)).toBe(true);
        await browser.waitUntil(() => fs.existsSync(path.join(dir, "data.db")), {
            timeout: 60_000,
            timeoutMsg: `No apareció data.db en ${dir}`,
        });

        await activarLicencia(NEGOCIO);
    });

    it("3 · elige el PIN del primer arranque", async () => {
        await elegirPin(PIN);
    });

    it("4 · ficha entrada e inicia sesión con ese PIN", async () => {
        await ficharYEntrar(PIN);
    });

    it("5 · declara quién factura, sin lo cual no se puede cobrar", async () => {
        // Desde FISCAL-01 cada cobro expide una factura, y una factura necesita saber quién la
        // emite: sin NIF ni razón social, `emitir_cobro` corta la transacción del cobro. La
        // activación NO los rellena (su "nombre legal" va a la licencia), así que esto es parte del
        // estreno de un equipo, no andamiaje del test. Lo que prueba de verdad es lo de siempre:
        // que el camino del dinero funciona de punta a punta, y ahora ese camino pasa por aquí.
        await declararDatosFiscales("Bar E2E TEST-01 SL", "B12345674");
    });

    it("6a · crea una categoría y un producto con precio, IVA y stock", async () => {
        await montarLaCarta(PRODUCTO);
    });

    it("6b · crea una zona con una mesa y guarda el plano", async () => {
        idMesa = await crearZonaConMesa(ZONA, MESA);
        expect(idMesa.length).toBeGreaterThan(0);
    });

    it("7 · abre la mesa y le añade dos líneas", async () => {
        await abrirMesa(MESA);
        await anadirLineas(PRODUCTO, UNIDADES);
        await esperarTotalPendiente(TOTAL);

        // Con la comanda abierta y sin cobrar, la mesa figura como PENDIENTE. Se comprueba aquí
        // para que el "vuelve a libre" del paso 8 signifique algo: sin esto, ver que la mesa no
        // está ocupada pasaría igual con una mesa que nunca llegó a estarlo.
        expect(await estadoDeMesa(idMesa)).toBe("PENDIENTE");
    });

    it("8 · cobra en efectivo, con el importe exacto", async () => {
        // Un billete de 10 € para 10,00 €: cambio 0.
        await cobrarTodoEnEfectivo("10€");

        await cerrarElModalDeLaMesa(MESA);

        // La mesa vuelve a libre. El plano es un `<canvas>`, así que el estado se lee por el mismo
        // comando con el que lo pinta la app.
        await esperarMesaLibre(idMesa);

        // Y el cobro salió con número de ticket. No se pinta en ninguna pantalla —viaja al
        // ESC/POS—, así que se lee por el mismo comando que usa la reimpresión de Cuentas.
        const entradas = await entradasDeCaja();
        expect(entradas.length).toBe(1);
        expect(entradas[0].metodo).toBe("Efectivo");
        expect(entradas[0].importe).toBeCloseTo(10, 2);

        const ticket = await leerDeLaApp<{ numero_ticket: string | null }>(
            "cuentas_ticket_para_reimprimir",
            { idPago: entradas[0].id },
        );
        expect(ticket.numero_ticket).toBeTruthy();
    });

    it("9 · cierra caja: lo que debería haber es lo cobrado, y el descuadre es 0", async () => {
        await irA("/Cuentas");
        await pulsar("Cerrar caja");

        await conTexto("h3", "Cerrar caja").waitForDisplayed({ timeout: 30_000 });

        // Primer cierre: hay que declarar con cuánto se empezó. Con 0, lo esperado es exactamente
        // lo cobrado en efectivo, que es lo que hace la comprobación legible.
        const fondo = $('//input[@placeholder="150"]');
        await fondo.waitForDisplayed({ timeout: 20_000 });
        await fondo.setValue("0");

        // El valor de la tarjeta, no la tarjeta entera: el texto del contenedor arrastra las otras
        // cifras del arqueo y una comprobación así pasaría por casualidad.
        const deberiaHaber = $('//p[contains(., "Debería haber")]/following-sibling::p[1]');
        await browser.waitUntil(async () => (await deberiaHaber.getText()).includes(TOTAL), {
            timeout: 20_000,
            timeoutMsg: `"Debería haber" no mostró ${TOTAL} €`,
        });

        // Se cuenta el cajón: un billete de 10, lo mismo que entró.
        await contarEnElCajon("10€");

        // La cifra que justifica el test entero.
        await conTexto("p", "Cuadra").waitForDisplayed({ timeout: 20_000 });

        // El de confirmar, no el de la pantalla de detrás: los dos dicen "Cerrar caja".
        await pulsarXPath(
            '//button[normalize-space(.)="Cancelar"]/following-sibling::button[contains(., "Cerrar caja")]',
            "botón de confirmar el cierre",
        );

        // El arqueo queda guardado y sale en el histórico de la pantalla.
        await conTexto("h3", "Cierres de caja").waitForDisplayed({ timeout: 30_000 });
        await browser.waitUntil(
            async () => {
                const cierres = await leerDeLaApp<Array<{ descuadre: number }>>("cierre_listar", {
                    args: { limite: 10 },
                });
                return cierres.length === 1 && Math.abs(cierres[0].descuadre) < 0.005;
            },
            { timeout: 30_000, timeoutMsg: "El cierre no quedó guardado con descuadre 0" },
        );
    });
});

/* ── Gestos que no son un `click` en un selector ─────────────────────────── */

/** Suma un billete al recuento del cajón del cierre (hay dos contadores: se acota por el título). */
async function contarEnElCajon(etiqueta: string): Promise<void> {
    await pulsarXPath(
        `//h3[contains(., "Cuenta el cajón")]/ancestor::div[contains(@class,"rounded-2xl")][1]` +
            `//button[@aria-label=${literalXPath(`Añadir ${etiqueta}`)}]`,
        `"+" de ${etiqueta} en el recuento del cajón`,
    );
}
