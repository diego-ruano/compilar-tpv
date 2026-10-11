// TEST-01 · El camino del dinero, y la factura que expide cada cobro.
//
// Un solo recorrido, en orden, sobre la app COMPILADA: React → IPC de Tauri → comandos Rust →
// SQLite → y vuelta. No cubre el frontend ni lo pretende: comprueba que esa costura aguanta, que
// es lo único que hoy no mira ningún test.
//
// Los pasos 1-4 (activación, PIN, login) parecen andamiaje y no lo son: son el estreno de un
// cliente real, y tampoco los prueba nadie.
//
// Lleva dentro lo que antes era un recorrido aparte, la factura de cada cobro (FISCAL-01): los dos
// estrenaban un equipo idéntico para vender lo mismo (TEST-03). Los pasos 9 y 10 son su corazón. El
// registro de facturación se emite DENTRO de la transacción del cobro, en Rust, y de él salen el
// número del papel y la URL del QR. Hay ~100 tests de Rust sobre la huella y la persistencia, y ni
// uno solo que recorra React → IPC → cobro → registro → vuelta al papel, que es justo la costura
// donde vive lo que se rompe sin que nadie se entere: el papel sale sin QR y ya está.
//
// Y termina con la cifra que lo verifica todo: si algo se rompe entre React y SQLite, el arqueo
// del paso 13 deja de cuadrar.
//
// El equipo que deja es el que usan los recorridos siguientes (ver las recetas de `wdio.conf.ts`),
// así que el negocio y el PIN viven en `helpers/equipo.ts`. Los gestos de montar la carta, abrir la
// mesa y cobrar viven en `helpers/vender.ts`. Un recorrido NO puede importar a otro —importar un
// spec lo EJECUTA—, así que lo común va en `helpers/`.

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
import { NEGOCIO, NIF, PIN, RAZON_SOCIAL } from "../helpers/equipo.js";
import {
    avisoDeDatosFiscalesVisible,
    declararDatosFiscales,
    irASeccionFiscal,
    verifactuEstado,
    verifactuListar,
    ticketDelCobro,
    type RegistroFiscal,
} from "../helpers/fiscal.js";
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
   vista: 2 × 5,00 € = 10,00 €, que se paga con UN billete de 10. Se vende dos
   veces, así que con fondo de partida 0 lo que debería haber en el cajón son
   20,00 €, exactamente lo cobrado, y se cuenta con dos billetes de 10.

   El 10 % tampoco es casual: la base se redondea a 9,09 € y la cuota es LO QUE
   FALTA para llegar al total, 0,91 €. Redondeando las dos por separado saldría
   0,92 y el papel diría que 9,09 + 0,92 = 10,00, que es un documento mal
   emitido.                                                                    */
const ZONA = "Salón E2E";
const MESA = "M1";
const UNIDADES = 2;
const BILLETE = "10€";
const TOTAL = "10,00";
const EN_EL_CAJON = "20,00";

const PRODUCTO: Producto = {
    categoria: "Bebidas E2E",
    nombre: "Caña E2E",
    precio: "5.00",
    iva: "10",
};

/** El id de la mesa creada por el test (UUID de la BD). Lo rellena el paso 6b. */
let idMesa = "";
/** El registro de la primera venta, para comparar la cadena en el paso 11. */
let primero: RegistroFiscal | null = null;

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

    it("5 · un equipo recién estrenado no sabe quién factura, lo dice, y se declara", async () => {
        // Desde FISCAL-01 cada cobro expide una factura, y una factura necesita saber quién la
        // emite: sin NIF ni razón social, `emitir_cobro` corta la transacción del cobro. La
        // activación pide el nombre del negocio y el nombre legal, pero eso va a la LICENCIA: el
        // obligado tributario de `Business_Settings` nace vacío. Declararlo es parte del estreno
        // tanto como elegir el PIN, y lo que se comprueba es que la pantalla basta para salir de ahí.
        const antes = await verifactuEstado();
        expect(antes.datos_fiscales_completos).toBe(false);
        expect(antes.total_registros).toBe(0);

        await irASeccionFiscal();
        expect(await avisoDeDatosFiscalesVisible()).toBe(true);

        await declararDatosFiscales(RAZON_SOCIAL, NIF);

        const despues = await verifactuEstado();
        expect(despues.datos_fiscales_completos).toBe(true);
        expect(despues.razon_social).toBe(RAZON_SOCIAL);
        // El entorno por defecto es PRODUCCIÓN, y es lo correcto: un registro emitido contra
        // pruebas y creído bueno es una factura que la AEAT no tiene.
        expect(despues.entorno_pruebas).toBe(false);
        expect(despues.modo_prueba).toBe(false);
    });

    it("6a · crea una categoría y un producto con precio, IVA y stock", async () => {
        await montarLaCarta(PRODUCTO);
    });

    it("6b · crea una zona con una mesa y guarda el plano", async () => {
        idMesa = await crearZonaConMesa(ZONA, MESA);
        expect(idMesa.length).toBeGreaterThan(0);
    });

    it("6c · guarda una nota y quitar con − persiste al volver al ticket (RI-71)", async () => {
        await irA("/VentaRapida");
        await pulsar(PRODUCTO.categoria);
        const nombre = literalXPath(PRODUCTO.nombre);
        const quitar = $(`//p[normalize-space(.)=${nombre}]/ancestor::div[.//button[@aria-label="Quitar uno"]][1]//button[@aria-label="Quitar uno"]`);
        await pulsarXPath(`//div[@role="button"][.//p[normalize-space(.)=${nombre}]]`, "producto de venta rápida");
        await quitar.waitForEnabled({ timeout: 20_000 });
        await pulsarXPath('//button[@title="Añadir/editar nota"]', "nota de una línea guardada");
        const nota = $("textarea");
        await nota.waitForDisplayed();
        await nota.setValue("Sin hielo");
        await pulsar("Guardar nota");
        await nota.waitForExist({ reverse: true });
        await irA("/Inventario");
        await irA("/VentaRapida");
        await conTexto("p", "Sin hielo").waitForDisplayed({ timeout: 20_000 });
        await pulsar(PRODUCTO.categoria);
        await quitar.click();
        await browser.waitUntil(async () => !(await quitar.isEnabled()), { timeout: 20_000 });
        await irA("/Inventario");
        await irA("/VentaRapida");
        await pulsar(PRODUCTO.categoria);
        await quitar.waitForDisplayed({ timeout: 20_000 });
        expect(await quitar.isEnabled()).toBe(false);
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
        await cobrarTodoEnEfectivo(BILLETE);

        await cerrarElModalDeLaMesa(MESA);

        // La mesa vuelve a libre. El plano es un `<canvas>`, así que el estado se lee por el mismo
        // comando con el que lo pinta la app.
        await esperarMesaLibre(idMesa);

        const entradas = await entradasDeCaja();
        expect(entradas.length).toBe(1);
        expect(entradas[0].metodo).toBe("Efectivo");
        // En céntimos, como todo el dinero que cruza el IPC: 10,00 €.
        expect(entradas[0].importe).toBe(1000);
    });

    it("9 · el cobro expidió su factura, y su número ES el número del ticket", async () => {
        const entradas = await entradasDeCaja();

        // El número de ticket no se pinta en ninguna pantalla —viaja al ESC/POS—, así que se lee por
        // el mismo comando que compone el papel (RI-29).
        const ticket = await ticketDelCobro(entradas[0].id);
        expect(ticket.numero_ticket).toBeTruthy();

        const registros = await verifactuListar();
        expect(registros.length).toBe(1);

        const alta = registros[0];
        expect(alta.tipo).toBe("ALTA");
        // `F2` es la simplificada: el ticket de toda la vida. Sale del importe y de que no haya
        // datos del cliente, no del camino que llamó.
        expect(alta.tipo_factura).toBe("F2");
        expect(alta.id_pago).toBe(entradas[0].id);
        expect(alta.orden).toBe(1);

        // LA comprobación de la parte fiscal. `Pagos.Numero_Ticket` es lo que se imprime y lo que
        // busca la reimpresión; `Num_Serie_Factura` es la identidad de la factura ante la AEAT. En
        // cuanto dejan de ser el mismo dato, el papel deja de poder atarse a su registro.
        expect(alta.num_serie_factura).toBe(ticket.numero_ticket);

        // Los importes se guardan como TEXTO, ya formateados, porque entran en la cadena que se
        // hashea: recomputarlos al leer daría otra huella. La cuota es «lo que falta» para llegar
        // al total, no un redondeo aparte — 9,09 + 0,91 = 10,00 exactos.
        expect(alta.importe_total).toBe("10.00");
        expect(alta.cuota_total).toBe("0.91");

        // 64 hexadecimales en mayúsculas: SHA-256 de la cadena, sin firma. En Veri*factu lo que
        // garantiza la integridad es el encadenamiento, no un XAdES.
        expect(alta.huella).toMatch(/^[0-9A-F]{64}$/);

        // Emitido y encolado, pero no enviado: el equipo del test no tiene certificado. Nada se
        // pierde — el registro ya existe, que es lo que exige el art. 9.
        expect(alta.estado_envio).toBe("PENDIENTE");

        primero = alta;
    });

    it("10 · el ticket dice lo que dice su factura, y una reimpresión saca exactamente el mismo", async () => {
        const numero = primero!.num_serie_factura;
        const idPago = primero!.id_pago!;

        // Este es el camino literal de la vista previa y de la impresión: el papel lo compone Rust
        // desde el pago y su registro (RI-29). Sin QR, el papel saldría sin él.
        const ticket = await ticketDelCobro(idPago);
        const qr = ticket.qr_url;
        if (!qr) throw new Error(`El ticket ${numero} no lleva QR.`);

        expect(ticket.numero_ticket).toBe(numero);
        expect(ticket.qr_pruebas).toBe(false);
        expect(ticket.cif).toBe(NIF);
        expect(ticket.razon_social).toBe(RAZON_SOCIAL);
        // La fecha del papel es la de expedición, no la de hoy: una copia de mañana dice la misma.
        expect(ticket.fecha?.startsWith(primero!.fecha_expedicion.replace(/-/g, "/"))).toBe(true);
        // El total es el `Importe_Total` declarado: 10,00 €.
        expect(ticket.total).toBe(1000);

        // La URL de cotejo lleva los cuatro parámetros del art. 20, y sólo esos. El número va
        // percent-encoded porque una barra sin escapar parte la URL y el cotejo devuelve un error
        // de campo.
        expect(qr.startsWith("https://www2.agenciatributaria.gob.es/wlpl/TIKE-CONT/ValidarQR?")).toBe(true);
        expect(qr).toContain(`nif=${NIF}`);
        expect(qr).toContain(`numserie=${encodeURIComponent(numero)}`);
        expect(qr).toContain(`fecha=${primero!.fecha_expedicion}`);
        expect(qr).toContain("importe=10.00");
        // El parámetro que la especificación prohíbe expresamente en el QR de una factura.
        expect(qr).not.toContain("formato=json");

        // La copia es el mismo papel con la marca: todo se LEE de la fila, nada se recalcula. Lo
        // único que no repite es abrir el cajón: eso sólo lo hace el original de un cobro en efectivo.
        const copia = await ticketDelCobro(idPago, true);
        expect(copia.es_copia).toBe(true);
        expect(ticket.abre_cajon).toBe(true);
        expect(copia.abre_cajon).toBe(false);
        expect({ ...copia, es_copia: false, abre_cajon: true }).toEqual(ticket);
    });

    it("11 · la segunda venta avanza la cadena, y la cadena está sana", async () => {
        await abrirMesa(MESA);
        await anadirLineas(PRODUCTO, UNIDADES);
        await esperarTotalPendiente(TOTAL);
        await cobrarTodoEnEfectivo(BILLETE);
        await cerrarElModalDeLaMesa(MESA);
        await esperarMesaLibre(idMesa);

        const registros = await verifactuListar();
        expect(registros.length).toBe(2);

        const segundo = registros.find((r) => r.orden === 2);
        if (!segundo) throw new Error("La segunda venta no dejó un registro con Orden 2.");

        // Número correlativo y huella distinta. La huella cambia aunque el importe sea idéntico
        // porque entran en ella la hora de generación y la huella del eslabón anterior — que es
        // exactamente lo que hace la cadena una cadena.
        expect(segundo.num_serie_factura).not.toBe(primero!.num_serie_factura);
        expect(segundo.huella).not.toBe(primero!.huella);
        expect(segundo.tipo).toBe("ALTA");

        // Y la prueba de que el eslabón anterior era bueno la da la propia app: antes de generar un
        // registro comprueba que el último esté bien encadenado y que su fecha no vaya por delante
        // del reloj (art. 7.i). Una anomalía no impide facturar —nunca puede—, se anota. Cero
        // anomalías tras la segunda emisión significa que la primera pasó esa comprobación.
        const estado = await verifactuEstado();
        expect(estado.anomalias_sin_reconocer).toBe(0);
    });

    it("12 · las dos facturas están en la cola, y el panel dice por qué no han salido", async () => {
        const estado = await verifactuEstado();

        expect(estado.total_registros).toBe(2);
        expect(estado.pendientes).toBe(2);
        expect(estado.aceptados).toBe(0);
        expect(estado.rechazados).toBe(0);

        // Nada ha salido, y la aplicación DICE por qué. Eso es lo que fija este paso: una cola que
        // crece sin explicación es el fallo que deja a un bar sin remitir durante semanas.
        //
        // No se fija CUÁL de los dos motivos, y no es pereza. Hoy sale `sin_datos_del_productor`
        // —el NIF del productor del software sigue pendiente, ver `docs/pendientes.md`—
        // y el día que se rellene pasará a `sin_certificado`, porque el equipo del test tampoco
        // tiene certificado. El orden entre ellos es deliberado (`estado_fiscal`): primero lo que
        // puede arreglar el bar, después lo que sólo podemos arreglar nosotros. Atar el test a uno
        // concreto lo convertiría en rojo el día que se resuelva, que es justo al revés.
        expect(estado.certificado_ok).toBe(false);
        expect(["sin_datos_del_productor", "sin_certificado"]).toContain(estado.motivo_no_remite);

        // Y que no dé la lata todavía: por debajo de una hora, no remitir es funcionamiento normal
        // —la propia norma impone una espera entre envíos—, así que la escalera de avisos calla.
        expect(estado.escalon_aviso).toBe("ninguno");
    });

    it("13 · cierra caja: lo que debería haber es lo cobrado, y el descuadre es 0", async () => {
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
        await browser.waitUntil(async () => (await deberiaHaber.getText()).includes(EN_EL_CAJON), {
            timeout: 20_000,
            timeoutMsg: `"Debería haber" no mostró ${EN_EL_CAJON} €`,
        });

        // Se cuenta el cajón: un billete de 10 por cada cobro, lo mismo que entró.
        await contarEnElCajon(BILLETE);
        await contarEnElCajon(BILLETE);

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
                const cierres = await leerDeLaApp("cierre_listar", {
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
