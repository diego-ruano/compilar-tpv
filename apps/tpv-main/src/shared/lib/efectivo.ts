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

/** Una moneda o billete del contador: la etiqueta con la que se pinta y lo que vale en euros. */
export type Denominacion = { label: string; value: number };

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
    { label: "200€", value: 200 },
    { label: "100€", value: 100 },
    { label: "50€", value: 50 },
    { label: "20€", value: 20 },
    { label: "10€", value: 10 },
    { label: "5€", value: 5 },
    { label: "2€", value: 2 },
    { label: "1€", value: 1 },
    { label: "0,50€", value: 0.5 },
    { label: "0,20€", value: 0.2 },
    { label: "0,10€", value: 0.1 },
    { label: "0,05€", value: 0.05 },
];

/**
 * Redondeo a céntimos, igual que `a_centimos` de Rust: la mitad se aleja del cero.
 *
 * Nunca devuelve `-0`: `Intl.NumberFormat` lo pinta «-0,00 €». Y lo que no es un número finito
 * cuenta como cero: Rust no puede recibir un `NaN` (serde lo rechaza), pero en pantalla se pintaría
 * «NaN €» en mitad de un cobro.
 */
export function aCentimos(v: number): number {
    if (!Number.isFinite(v)) return 0;
    const centimos = Math.round(Math.abs(v) * 100);
    if (centimos === 0) return 0;
    return (v < 0 ? -centimos : centimos) / 100;
}

/** Suma de importes redondeada a céntimos. Lo que no es un número no suma. */
export function sumaImportes(importes: Iterable<number>): number {
    let bruto = 0;
    for (const v of importes) {
        if (Number.isFinite(v)) bruto += v;
    }
    return aCentimos(bruto);
}

/**
 * Total de un recuento, igual que `total_recuento` de Rust.
 *
 * Las unidades que no son positivas no suman (no existe «menos tres billetes»), ni tampoco una
 * etiqueta que no esté en `denoms`.
 */
export function totalRecuento(denoms: readonly Denominacion[], recuento: Recuento): number {
    let bruto = 0;
    for (const d of denoms) {
        const unidades = Number(recuento?.[d.label] ?? 0);
        if (Number.isFinite(unidades) && unidades > 0 && Number.isFinite(d.value) && d.value > 0) {
            bruto += d.value * unidades;
        }
    }
    return aCentimos(bruto);
}

/**
 * Lo que hay que devolver al cliente: positivo es cambio, negativo es lo que falta.
 *
 * Los dos lados se redondean antes de restar, como hace `calcular` en Rust con cada entrada: el
 * total a cobrar llega como suma de líneas y puede traer ruido de coma flotante.
 */
export function cambioDelCobro(entregado: number, aCobrar: number): number {
    return aCentimos(aCentimos(entregado) - aCentimos(aCobrar));
}

/** El arqueo resuelto, con los mismos campos que `CierreCalculado` de Rust. */
export type Arqueo = {
    fondoInicial: number;
    ventasEfectivo: number;
    gastosCaja: number;
    /** Fondo + ventas en efectivo − gastos pagados con caja. */
    esperado: number;
    contado: number;
    /** Contado − esperado. Negativo = falta dinero. */
    descuadre: number;
    dejado: number;
    /** Contado − dejado: lo que sale del cajón. */
    retirado: number;
};

/** El arqueo, igual que `calcular` de Rust. */
export function calcularArqueo(entrada: {
    fondoInicial: number;
    ventasEfectivo: number;
    gastosCaja: number;
    contado: number;
    dejado: number;
}): Arqueo {
    const fondoInicial = aCentimos(entrada.fondoInicial);
    const ventasEfectivo = aCentimos(entrada.ventasEfectivo);
    const gastosCaja = aCentimos(entrada.gastosCaja);
    const contado = aCentimos(entrada.contado);
    const dejado = aCentimos(entrada.dejado);
    const esperado = aCentimos(fondoInicial + ventasEfectivo - gastosCaja);

    return {
        fondoInicial,
        ventasEfectivo,
        gastosCaja,
        esperado,
        contado,
        descuadre: aCentimos(contado - esperado),
        dejado,
        retirado: aCentimos(contado - dejado),
    };
}

/**
 * ¿Hace falta escribir un motivo? Igual que `exige_motivo` de Rust: se mira el valor absoluto, y un
 * umbral de cero o negativo pide motivo para cualquier descuadre.
 */
export function exigeMotivo(descuadre: number, umbral: number): boolean {
    if (umbral <= 0) return Math.abs(descuadre) > 0;
    return Math.abs(descuadre) > umbral;
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
    umbral: number,
): ProblemaDelCierre | null {
    if (arqueo.dejado > arqueo.contado) return "deja_mas_de_lo_contado";
    const hayMotivo = (motivo ?? "").trim().length > 0;
    if (exigeMotivo(arqueo.descuadre, umbral) && !hayMotivo) return "falta_motivo";
    return null;
}
