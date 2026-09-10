// TEST-01 · La factura de cada cobro (FISCAL-01, Veri*factu).
//
// Lo que prueba, y que hoy no mira nada de punta a punta: que **cobrar expide una factura**. El
// registro de facturación se emite DENTRO de la transacción del cobro, en Rust, y de él salen el
// número del papel y la URL del QR. Hay 100 tests de Rust sobre la aritmética de la huella y sobre
// la persistencia, y ni uno solo que recorra React → IPC → cobro → registro → vuelta al papel, que
// es justo la costura donde vive lo que se rompe sin que nadie se entere.
//
// Los pasos 5 y 6 son el corazón: el número de la factura y el del ticket TIENEN que ser el mismo
// —dos numeraciones paralelas son dos cosas que pueden divergir— y el QR del papel tiene que salir
// de la fila guardada, no recomponerse al imprimir. Si esa cadena se parte, la aplicación no
// protesta: el papel sale sin QR y ya está.
//
// ── Lo que este recorrido NO cubre todavía, y por qué ────────────────────────────────────────
//
// El **modo formación** se queda fuera a propósito, no por olvido: hoy rompe justo la invariante
// del paso 5 (el cobro reserva el número en la serie del ejercicio y `emitir_alta` lo descarta para
// numerar en `PRU<año>`, así que `Pagos.Numero_Ticket` y `Num_Serie_Factura` dejan de coincidir y
// el ticket sale sin QR). Está anotado en `docs/analisis/HALLAZGOS.md`. Añadir aquí un paso que
// falla convertiría el E2E en un semáforo que nadie mira; cuando se arregle, el paso entra aquí.

import { expect } from "@wdio/globals";

import { estrenarEquipo } from "../helpers/arranque.js";
import {
    avisoDeDatosFiscalesVisible,
    bloqueDelTicket,
    irASeccionFiscal,
    declararDatosFiscales,
    verifactuEstado,
    verifactuListar,
    type RegistroFiscal,
} from "../helpers/fiscal.js";
import { cargarDotEnv } from "../helpers/entorno.js";
import { leerDeLaApp } from "../helpers/ui.js";
import {
    abrirMesa,
    anadirLineas,
    cerrarElModalDeLaMesa,
    cobrarTodoEnEfectivo,
    crearZonaConMesa,
    entradasDeCaja,
    esperarMesaLibre,
    esperarTotalPendiente,
    montarLaCarta,
    type Producto,
} from "../helpers/vender.js";

cargarDotEnv();

/* ── Los datos del recorrido ──────────────────────────────────────────────────
   2 × 5,00 € = 10,00 € al 10 %. Elegido para que el desglose sea comprobable a
   mano: la base se redondea a 9,09 € y la cuota es LO QUE FALTA para llegar al
   total, 0,91 €. Redondeando las dos por separado saldría 0,92 y el papel diría
   que 9,09 + 0,92 = 10,00, que es un documento mal emitido.                   */
const NEGOCIO = "Bar E2E FISCAL";
const PIN = "4321";
const ZONA = "Salón Fiscal";
const MESA = "F1";
const BILLETE = "10€";
const TOTAL = "10,00";
const UNIDADES = 2;

const RAZON_SOCIAL = "Hostelería E2E SL";
// Con dígito de control válido: `datos_obligado` revalida el NIF en Rust y se niega a emitir con
// uno que no cuadre, precisamente para que no vuelva como error admisible de la AEAT horas después.
const NIF = "B12345674";

const PRODUCTO: Producto = {
    categoria: "Bebidas Fiscal",
    nombre: "Caña Fiscal",
    precio: "5.00",
    iva: "10",
};

/** El id de la mesa creada por el test (UUID de la BD). Lo rellena el paso 3. */
let idMesa = "";
/** El registro de la primera venta, para comparar la cadena en el paso 7. */
let primero: RegistroFiscal | null = null;

describe("La factura de cada cobro", () => {
    it("1 · estrena el equipo: modo TPV, licencia, PIN y sesión", async () => {
        await estrenarEquipo(NEGOCIO, PIN);
    });

    it("2 · un equipo recién estrenado no sabe quién factura, y la pantalla lo dice", async () => {
        // La activación pide el nombre del negocio y el nombre legal, pero eso va a la LICENCIA: el
        // obligado tributario de `Business_Settings` nace vacío. Y sin él no se puede cobrar, así
        // que declararlo es parte del estreno tanto como elegir el PIN.
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
        expect(despues.formacion).toBe(false);
    });

    it("3 · monta la carta y una mesa donde vender", async () => {
        await montarLaCarta(PRODUCTO);
        idMesa = await crearZonaConMesa(ZONA, MESA);
        expect(idMesa.length).toBeGreaterThan(0);
    });

    it("4 · vende dos cañas y las cobra en efectivo", async () => {
        await abrirMesa(MESA);
        await anadirLineas(PRODUCTO, UNIDADES);
        await esperarTotalPendiente(TOTAL);

        await cobrarTodoEnEfectivo(BILLETE);

        await cerrarElModalDeLaMesa(MESA);
        await esperarMesaLibre(idMesa);
    });

    it("5 · el cobro expidió su factura, y su número ES el número del ticket", async () => {
        const entradas = await entradasDeCaja();
        expect(entradas.length).toBe(1);
        expect(entradas[0].metodo).toBe("Efectivo");
        expect(entradas[0].importe).toBeCloseTo(10, 2);

        const ticket = await leerDeLaApp<{ numero_ticket: string | null }>(
            "cuentas_ticket_para_reimprimir",
            { idPago: entradas[0].id },
        );
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

        // LA comprobación de este recorrido. `Pagos.Numero_Ticket` es lo que se imprime y lo que
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

    it("6 · el ticket lleva su QR, y una reimpresión saca exactamente el mismo", async () => {
        const numero = primero!.num_serie_factura;

        // Este es el camino literal de `PrintTicketModal`: busca por el número del ticket. Si
        // devolviera `null`, el papel saldría sin QR y la aplicación no diría nada.
        const bloque = await bloqueDelTicket(numero);
        if (!bloque) throw new Error(`El ticket ${numero} no tiene bloque fiscal: saldría sin QR.`);

        expect(bloque.num_serie_factura).toBe(numero);
        expect(bloque.huella).toBe(primero!.huella);
        expect(bloque.tipo_factura).toBe("F2");
        expect(bloque.entorno_pruebas).toBe(false);

        // La URL de cotejo lleva los cuatro parámetros del art. 20, y sólo esos. El número va
        // percent-encoded porque una barra sin escapar parte la URL y el cotejo devuelve un error
        // de campo.
        expect(bloque.qr_url.startsWith("https://www2.agenciatributaria.gob.es/wlpl/TIKE-CONT/ValidarQR?")).toBe(true);
        expect(bloque.qr_url).toContain(`nif=${NIF}`);
        expect(bloque.qr_url).toContain(`numserie=${encodeURIComponent(numero)}`);
        expect(bloque.qr_url).toContain(`fecha=${primero!.fecha_expedicion}`);
        expect(bloque.qr_url).toContain("importe=10.00");
        // El parámetro que la especificación prohíbe expresamente en el QR de una factura.
        expect(bloque.qr_url).not.toContain("formato=json");

        // Una copia con otra huella no es una copia: los tres datos se LEEN de la fila, no se
        // recalculan (recalcular daría otra hora de generación y por tanto otra huella).
        const otraVez = await bloqueDelTicket(numero);
        expect(otraVez).toEqual(bloque);
    });

    it("7 · la segunda venta avanza la cadena, y la cadena está sana", async () => {
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

    it("8 · las dos están en la cola, y el panel dice por qué no han salido", async () => {
        const estado = await verifactuEstado();

        expect(estado.total_registros).toBe(2);
        expect(estado.pendientes).toBe(2);
        expect(estado.aceptados).toBe(0);
        expect(estado.rechazados).toBe(0);

        // No hay certificado en la máquina del test, así que el job ni lo intenta. Lo que importa
        // es que la aplicación lo DIGA: una cola que crece sin explicación es el fallo que deja a
        // un bar sin remitir durante semanas.
        expect(estado.certificado_ok).toBe(false);
        expect(estado.motivo_no_remite).toBe("sin_certificado");

        // Y que no dé la lata todavía: por debajo de una hora, no remitir es funcionamiento normal
        // —la propia norma impone una espera entre envíos—, así que la escalera de avisos calla.
        expect(estado.escalon_aviso).toBe("ninguno");
    });
});
