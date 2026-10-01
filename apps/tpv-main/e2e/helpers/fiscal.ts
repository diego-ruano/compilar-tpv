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
    /** MODO-PRUEBA (temporal). */
    modo_prueba: boolean;
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

/**
 * El aviso que sale al entrar cuando faltan el NIF y la razón social (FIS-01).
 *
 * Se ancla a su encabezado y no a un `data-testid` por lo mismo que el resto del recorrido: ese
 * texto es parte del producto, no del test.
 */
const BOTON_RELLENAR_AHORA =
    '//h3[contains(normalize-space(.), "Este TPV todavía no puede cobrar")]' +
    '/ancestor::div[1]//button[contains(normalize-space(.), "Rellenarlo ahora")]';

/** El otro botón del mismo aviso: seguir sin rellenarlo. */
const BOTON_AHORA_NO =
    '//h3[contains(normalize-space(.), "Este TPV todavía no puede cobrar")]' +
    '/ancestor::div[1]//button[normalize-space(.)="Ahora no"]';

/** El panel de Configuración → Fiscal donde se declaran los datos del obligado. */
const PANEL_OBLIGADO =
    '//section[.//h2[normalize-space(text())="Datos fiscales del negocio"]]';

/**
 * Abre Configuración y se planta en la sección Fiscal.
 *
 * ⚠️ **Primero mira si está el aviso de «este TPV todavía no puede cobrar»** (FIS-01), porque en un
 * equipo recién estrenado lo está: sale al entrar, es un `fixed inset-0` y tapa el menú entero. El
 * recorrido no lo esquiva — lo **usa**, que es lo que hace una persona y de paso comprueba que ese
 * botón lleva de verdad a donde dice. Descartarlo con «Ahora no» habría probado lo contrario: que
 * se puede seguir sin rellenar nada.
 *
 * Si el aviso no está (ya reconocido, o los datos ya puestos), se navega por el menú como siempre.
 */
export async function irASeccionFiscal(): Promise<void> {
    // Se espera al BOTÓN, con margen, y no se decide por lo que diga el backend.
    //
    // La versión anterior preguntaba `datos_fiscales_completos` y, si faltaban, daba por hecho que
    // el aviso estaría. Falla en el caso más normal de todos: llamar a este helper **dos veces**.
    // La primera pulsa «Rellenarlo ahora», que **cierra** el aviso (queda reconocido para la
    // sesión); la segunda seguía viendo que faltan los datos y se quedaba esperando un botón que
    // ya no va a volver.
    //
    // El margen es lo que cubre la carrera que motivó aquello: el aviso sale cuando el store recibe
    // su primera respuesta, y eso puede pasar después de entrar aquí. Ocho segundos son de sobra
    // para una llamada local; si en ese tiempo no ha salido, es que no va a salir.
    const hayAviso = await $(BOTON_RELLENAR_AHORA)
        .waitForClickable({ timeout: 8_000 })
        .then(
            () => true,
            () => false,
        );

    if (hayAviso) {
        await pulsarXPath(
            BOTON_RELLENAR_AHORA,
            'botón "Rellenarlo ahora" del aviso de datos fiscales',
        );
        await $(PANEL_OBLIGADO).waitForDisplayed({ timeout: 30_000 });
        return;
    }

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

/**
 * Cierra el aviso de «este TPV todavía no puede cobrar» con «Ahora no», si está.
 *
 * Sirve a un recorrido que **no** vaya de facturar: el aviso es un `fixed inset-0` y tapa el menú,
 * así que sin quitarlo no se llega a ninguna pantalla. Hoy no lo llama ninguno: todos comparten el
 * equipo que estrena la venta, que ya declara los datos.
 *
 * Es tolerante a que no esté: en un equipo restaurado los datos ya vienen puestos.
 */
export async function descartarAvisoDatosFiscales(): Promise<void> {
    const hay = await $(BOTON_AHORA_NO)
        .waitForClickable({ timeout: 8_000 })
        .then(
            () => true,
            () => false,
        );
    if (hay) {
        await pulsarXPath(BOTON_AHORA_NO, 'botón "Ahora no" del aviso de datos fiscales');
        await $(BOTON_AHORA_NO).waitForExist({ reverse: true, timeout: 10_000 });
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

