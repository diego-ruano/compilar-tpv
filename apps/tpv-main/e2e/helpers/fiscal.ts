// Los datos del obligado y lo que el registro de facturación deja ver desde fuera (FISCAL-01).
//
// Los tipos se declaran aquí en vez de importarse de `@tpv/contracts` a propósito, igual que hace
// `nube.ts` con `Salud`: al recorrido sólo le interesan cuatro campos, y atarlo al DTO completo
// haría que añadir un campo nuevo a `EstadoFiscal` rompiera el E2E sin que nada esté mal.

import { $, browser } from "@wdio/globals";

import { escribir, irA, leerDeLaApp, literalXPath, pulsarXPath } from "./ui.js";

/** Lo que el recorrido mira de `verifactu_estado`. */
export type EstadoFiscal = {
    datos_fiscales_completos: boolean;
    nif?: string;
    razon_social?: string;
    entorno_pruebas: boolean;
    total_registros: number;
    pendientes: number;
    aceptados: number;
    rechazados: number;
    escalon_aviso: string;
    certificado_ok: boolean;
    motivo_no_remite?: string;
    anomalias_sin_reconocer: number;
    formacion: boolean;
    /** Facturas de prueba emitidas y todavía sin anular. */
    formacion_sin_anular: number;
};

/** Una fila del libro de registros de facturación. */
export type RegistroFiscal = {
    id_registro: string;
    orden: number;
    /** `ALTA` | `ANULACION`. */
    tipo: string;
    num_serie_factura: string;
    fecha_expedicion: string;
    tipo_factura?: string;
    importe_total?: string;
    cuota_total?: string;
    huella: string;
    id_pago?: string;
    estado_envio?: string;
};

/** El bloque que se imprime en el papel: número, QR y huella. */
export type BloqueFiscal = {
    num_serie_factura: string;
    fecha_expedicion: string;
    qr_url: string;
    huella: string;
    tipo_factura: string;
    entorno_pruebas: boolean;
};

/** El panel de Configuración → Fiscal donde se declaran los datos del obligado. */
const PANEL_OBLIGADO =
    '//section[.//h2[normalize-space(text())="Datos fiscales del negocio"]]';

/** Abre Configuración y se planta en la sección Fiscal. */
export async function irASeccionFiscal(): Promise<void> {
    await irA("/Configuracion");

    // Anclado al `div` del título dentro del botón de la barra lateral: un `contains(., "Fiscal")`
    // a secas también engancharía cualquier panel que hable de lo fiscal.
    await pulsarXPath(
        '//nav//button[.//div[normalize-space(text())="Fiscal"]]',
        'sección "Fiscal" de Configuración',
    );

    await $(PANEL_OBLIGADO).waitForDisplayed({ timeout: 30_000 });
}

/**
 * Declara quién factura, por la pantalla, y espera a que la app lo dé por bueno.
 *
 * No es andamiaje: mientras falten el NIF y la razón social **no se puede cobrar** —cada cobro
 * emite una factura y una factura necesita saber quién la emite—, así que este paso forma parte de
 * estrenar un equipo tanto como elegir el PIN. Lo que aquí se comprueba es que la pantalla es
 * suficiente para salir de ese estado.
 */
export async function declararDatosFiscales(razonSocial: string, nif: string): Promise<void> {
    await irASeccionFiscal();

    await escribir(`${PANEL_OBLIGADO}//label[.//span[normalize-space(text())="Razón social"]]//input`, razonSocial);
    await escribir(`${PANEL_OBLIGADO}//label[.//span[normalize-space(text())="NIF / CIF"]]//input`, nif);

    await pulsarXPath(
        `${PANEL_OBLIGADO}//button[normalize-space(.)="Guardar"]`,
        'botón "Guardar" de los datos fiscales',
    );

    // La señal de que ha entrado no es el botón: es que la app deje de decir que faltan. Se
    // pregunta al backend porque es él quien decide (`nif_valido` se revalida en Rust), así que un
    // NIF con el dígito de control mal se vería aquí y no tres pantallas más allá.
    const estado = await browser.waitUntil(
        async () => {
            const e = await verifactuEstado();
            return e.datos_fiscales_completos ? e : false;
        },
        { timeout: 30_000, timeoutMsg: "La app siguió diciendo que faltan los datos fiscales" },
    );

    if ((estado.nif ?? "") !== nif.toUpperCase()) {
        throw new Error(`El NIF guardado es "${estado.nif}" y se declaró "${nif}".`);
    }
}

/** Comprueba que el aviso rojo de «faltan los datos fiscales» está o no está en pantalla. */
export async function avisoDeDatosFiscalesVisible(): Promise<boolean> {
    const aviso = $(
        `${PANEL_OBLIGADO}//*[contains(normalize-space(.), ${literalXPath("Faltan los datos fiscales")})]`,
    );
    return await aviso.isExisting();
}

/** Resumen fiscal: datos del obligado, cola de envío y escalón de aviso. */
export async function verifactuEstado(): Promise<EstadoFiscal> {
    return await leerDeLaApp<EstadoFiscal>("verifactu_estado");
}

/** El libro de registros, del más reciente al más antiguo (es como lo pinta el panel). */
export async function verifactuListar(limite = 50): Promise<RegistroFiscal[]> {
    // ⚠️ Los argumentos van PLANOS (`{ limite }`), no envueltos en `{ args: {…} }`: el comando
    // declara parámetros sueltos. Equivocarse no da un error legible — un `Option<…>` llega como
    // `None` y el comando se queda con su valor por defecto.
    return await leerDeLaApp<RegistroFiscal[]>("verifactu_listar", {
        limite,
        desplazamiento: 0,
    });
}

/**
 * El bloque fiscal de un ticket por su número de factura.
 *
 * Es EL MISMO camino que usa `PrintTicketModal` para poner el QR en el papel, y por eso el
 * recorrido lo prueba por aquí: si esto devuelve `null`, el ticket sale sin QR y la aplicación no
 * dice nada.
 */
export async function bloqueDelTicket(numeroTicket: string): Promise<BloqueFiscal | null> {
    return await leerDeLaApp<BloqueFiscal | null>("verifactu_bloque_ticket", { numeroTicket });
}

/** El panel de Configuración → Fiscal desde el que se abren y se cierran las pruebas. */
const PANEL_FORMACION = '//section[.//h2[normalize-space(text())="Probar o enseñar el TPV"]]';

/**
 * Enciende el **modo formación** desde la pantalla.
 *
 * No es una simulación y la pantalla lo dice: lo que se cobre a partir de aquí son facturas reales
 * de la serie `PRU<año>`, con su QR y su registro. Lo que el modo garantiza es el final que la
 * norma exige — que se anulen todas —, no que no existan.
 */
export async function empezarPruebas(): Promise<void> {
    await irASeccionFiscal();
    await pulsarXPath(
        `${PANEL_FORMACION}//button[contains(normalize-space(.), "Empezar pruebas")]`,
        'botón "Empezar pruebas"',
    );
    await browser.waitUntil(async () => (await verifactuEstado()).formacion, {
        timeout: 30_000,
        timeoutMsg: "El modo formación no llegó a encenderse",
    });
}

/**
 * Termina las pruebas, que **es** la anulación: apagar el interruptor y anular las facturas de
 * prueba son la misma operación y no dos, para que no se pueda dejar a medias.
 *
 * Espera a que no quede ninguna viva, que es lo único que prueba que el barrido corrió.
 */
export async function terminarPruebas(): Promise<void> {
    await irASeccionFiscal();
    await pulsarXPath(
        `${PANEL_FORMACION}//button[contains(normalize-space(.), "Terminar y anular")]`,
        'botón "Terminar y anular las facturas de prueba"',
    );
    await browser.waitUntil(
        async () => {
            const e = await verifactuEstado();
            return !e.formacion && e.formacion_sin_anular === 0;
        },
        { timeout: 60_000, timeoutMsg: "Al terminar quedaron facturas de prueba sin anular" },
    );
}
