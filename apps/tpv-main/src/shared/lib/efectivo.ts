// src/shared/lib/efectivo.ts
//
// Las cuentas del efectivo, sin React: el cambio de un cobro y el arqueo del cierre de caja.
//
// Vivían copiadas dentro de tres componentes —`MesaComandaModal`, `VentaRapida` y
// `CierreCajaModal`—, cada una con su `Math.round(x * 100) / 100`, y eso tenía dos fallos que no se
// veían desde ningún test porque ninguno podía llegar hasta ahí sin montar React:
//
// - **«Cambio -0,00 €».** Dos líneas de 1,10 y 2,20 suman 3,3000000000000003 en coma flotante; al
//   pagar 3,30 justos la resta redondeada da `-0`, que pasa el `>= 0` y que `Intl` pinta con su
//   signo menos.
// - **La mitad no se redondeaba como en Rust.** `Math.round` lleva la mitad hacia +∞ (−12,5 → −12)
//   y `f64::round` la aleja del cero (−12,5 → −13). La pantalla del cierre podía enseñar un céntimo
//   distinto del arqueo que se guarda.
//
// ⚠️ El arqueo es un ESPEJO de `crates/tpv-domain/src/cierre_caja.rs`. Lo que se guarda lo calcula
// Rust; lo que la persona ve antes de confirmar —y con lo que decide si escribe un motivo o vuelve a
// contar— lo calcula esto. Las tablas de `test/efectivo.test.ts` repiten las de los tests de allí:
// si uno cambia de criterio, el otro falla.
//
// El cobro no tiene gemelo: el importe lo suma el backend a partir de las líneas y el recuento de
// monedas no sale del equipo. Pero es lo que el camarero lee para saber cuánto devolver.

import type { Dinero } from "@tpv/contracts";

import { CERO, abs as absDinero, deCentimos, esCero, redondear, restar, sumar } from "./dinero";

/** Una moneda o billete del contador: la etiqueta con la que se pinta y lo que vale. */
export type Denominacion = { label: string; value: Dinero };

/** Cuántas unidades se han contado de cada denominación, por etiqueta. */
export type Recuento = Record<string, number>;

/**
 * Monedas y billetes del contador de cobro, en el orden en que se pintan.
 *
 * Sin monedas de 1 y 2 céntimos, a propósito del cobro: nadie cuenta la calderilla que le dan, se
 * redondea hacia arriba y se devuelve el cambio. El cierre de caja sí las lleva (`DEFAULT_DENOMS`,
 * con otras etiquetas), porque ahí se cuenta TODO lo que hay en el cajón. Por eso un recuento de una
 * pantalla no se puede sumar con las denominaciones de la otra: las etiquetas no coinciden.
 */
export const DENOMS_COBRO: readonly Denominacion[] = [
    { label: "200€", value: deCentimos(20_000) },
    { label: "100€", value: deCentimos(10_000) },
    { label: "50€", value: deCentimos(5_000) },
    { label: "20€", value: deCentimos(2_000) },
    { label: "10€", value: deCentimos(1_000) },
    { label: "5€", value: deCentimos(500) },
    { label: "2€", value: deCentimos(200) },
    { label: "1€", value: deCentimos(100) },
    { label: "0,50€", value: deCentimos(50) },
    { label: "0,20€", value: deCentimos(20) },
    { label: "0,10€", value: deCentimos(10) },
    { label: "0,05€", value: deCentimos(5) },
];

/**
 * Suma de importes. Exacta: son enteros.
 *
 * El redondeo que esto hacía antes (`aCentimos`) se mudó a `shared/lib/dinero.ts`, que es donde
 * vive ahora la única regla de redondeo de la interfaz. Aquí ya no hay nada que redondear.
 */
export function sumaImportes(importes: Iterable<Dinero>): Dinero {
    let bruto = 0;
    for (const v of importes) {
        if (Number.isFinite(v)) bruto += v;
    }
    return deCentimos(bruto);
}

/**
 * Total de un recuento, igual que `total_recuento` de Rust.
 *
 * Las unidades que no son positivas no suman (no existe «menos tres billetes»), ni tampoco una
 * etiqueta que no esté en `denoms`.
 */
export function totalRecuento(denoms: readonly Denominacion[], recuento: Recuento): Dinero {
    let bruto = 0;
    for (const d of denoms) {
        const unidades = Number(recuento?.[d.label] ?? 0);
        if (Number.isFinite(unidades) && unidades > 0 && Number.isFinite(d.value) && d.value > 0) {
            bruto += d.value * unidades;
        }
    }
    return deCentimos(bruto);
}

/**
 * Lo que hay que devolver al cliente: positivo es cambio, negativo es lo que falta.
 *
 * Ya no hace falta redondear los dos lados antes de restar: el «cambio -0,00 €» que esto existía
 * para evitar venía de que el total a cobrar llegaba como suma de flotantes. Ahora llega entero.
 */
export function cambioDelCobro(entregado: Dinero, aCobrar: Dinero): Dinero {
    return restar(entregado, aCobrar);
}

/** El arqueo resuelto, con los mismos campos que `CierreCalculado` de Rust. */
export type Arqueo = {
    fondoInicial: Dinero;
    ventasEfectivo: Dinero;
    gastosCaja: Dinero;
    /** Fondo + ventas en efectivo − gastos pagados con caja. */
    esperado: Dinero;
    contado: Dinero;
    /** Contado − esperado. Negativo = falta dinero. */
    descuadre: Dinero;
    dejado: Dinero;
    /** Contado − dejado: lo que sale del cajón. */
    retirado: Dinero;
};

/** El arqueo, igual que `calcular` de Rust. */
export function calcularArqueo(entrada: {
    fondoInicial: Dinero;
    ventasEfectivo: Dinero;
    gastosCaja: Dinero;
    contado: Dinero;
    dejado: Dinero;
}): Arqueo {
    const { fondoInicial, ventasEfectivo, gastosCaja, contado, dejado } = entrada;
    const esperado = restar(sumar(fondoInicial, ventasEfectivo), gastosCaja);

    return {
        fondoInicial,
        ventasEfectivo,
        gastosCaja,
        esperado,
        contado,
        descuadre: restar(contado, esperado),
        dejado,
        retirado: restar(contado, dejado),
    };
}

/**
 * ¿Hace falta escribir un motivo? Igual que `exige_motivo` de Rust: se mira el valor absoluto, y un
 * umbral de cero o negativo pide motivo para cualquier descuadre.
 */
export function exigeMotivo(descuadre: Dinero, umbral: Dinero): boolean {
    if (umbral <= 0) return !esCero(descuadre);
    return absDinero(descuadre) > umbral;
}

/** Por qué no se puede guardar un cierre, o `null` si se puede. */
export type ProblemaDelCierre = "deja_mas_de_lo_contado" | "falta_motivo";

/**
 * Las reglas de `validar` de Rust, en el mismo orden.
 *
 * Faltan sus dos primeras —recuento o dejado negativos— porque aquí no pueden darse: los dos salen
 * de `totalRecuento`, que no suma unidades negativas.
 */
export function validarCierre(
    arqueo: Arqueo,
    motivo: string | null | undefined,
    umbral: Dinero,
): ProblemaDelCierre | null {
    if (arqueo.dejado > arqueo.contado) return "deja_mas_de_lo_contado";
    const hayMotivo = (motivo ?? "").trim().length > 0;
    if (exigeMotivo(arqueo.descuadre, umbral) && !hayMotivo) return "falta_motivo";
    return null;
}

/**
 * Lee un importe escrito a mano, como se escribe en España. `null` si no se entiende.
 *
 * Existe por el fondo del primer cierre, que se leía con `Number(texto.replace(",", "."))`, y lo que
 * no entendía valía **cero en silencio**: «1.234,56» o «150 €» se guardaban como un fondo de 0 €, y
 * «1.500» como 1,50 €. Ese fondo encabeza la cadena de cierres —cada uno arranca con lo que dejó el
 * anterior—, así que un número mal leído ahí no se arregla al día siguiente: se arrastra.
 *
 * Las reglas, y el porqué de las dudosas:
 * - La coma es decimal; el punto y el espacio agrupan miles. Si aparecen coma y punto, el último de
 *   los dos es el decimal («1,234.56» también vale): no admite otra lectura.
 * - Un punto seguido de 1 o 2 cifras es decimal («150.50»); seguido de 3, agrupa miles («1.500»).
 *   Un importe no tiene tres decimales, y en España «1.500» son mil quinientos.
 * - Lo que admite dos lecturas no se adivina: «1,500» (¿1,50 o 1.500?) o «0.500» dan `null`.
 * - Más de dos decimales, un signo o cualquier otro carácter dan `null`. Un fondo no es negativo.
 * - El símbolo € delante o detrás se ignora, y un texto vacío es cero: no escribir nada es no haber
 *   empezado con nada.
 */
export function leerImporte(texto: string): Dinero | null {
    const t = (texto ?? "")
        .replace(/[\s\u00a0\u202f]+/g, " ")
        .trim()
        .replace(/^€ ?/, "")
        .replace(/ ?€$/, "")
        .trim();
    if (t === "") return CERO;
    if (!/^[\d., ]+$/.test(t)) return null;

    const ultimoPunto = t.lastIndexOf(".");
    const ultimaComa = t.lastIndexOf(",");
    let decimal = -1;
    if (ultimoPunto >= 0 && ultimaComa >= 0) {
        decimal = Math.max(ultimoPunto, ultimaComa);
    } else if (ultimaComa >= 0) {
        decimal = ultimaComa;
    } else if (
        ultimoPunto >= 0 &&
        t.indexOf(".") === ultimoPunto &&
        /^\d{1,2}$/.test(t.slice(ultimoPunto + 1))
    ) {
        decimal = ultimoPunto;
    }

    const entera = decimal >= 0 ? t.slice(0, decimal) : t;
    const decimales = decimal >= 0 ? t.slice(decimal + 1) : "";
    if (decimal >= 0 && !/^\d{1,2}$/.test(decimales)) return null;

    let cifras: string;
    if (/^\d+$/.test(entera)) {
        cifras = entera;
    } else {
        // Agrupada de tres en tres con un solo separador, que no puede ser también el decimal.
        const miles = /^[1-9]\d{0,2}([., ])\d{3}(?:\1\d{3})*$/.exec(entera);
        if (!miles || (decimal >= 0 && miles[1] === t[decimal])) return null;
        cifras = entera.replace(/[., ]/g, "");
    }

    // Ya venía calculando céntimos por dentro: lo que cambia es que ya no se divide al salir.
    const centimos = Number(cifras) * 100 + Number(decimales.padEnd(2, "0"));
    return Number.isSafeInteger(centimos) ? deCentimos(centimos) : null;
}
