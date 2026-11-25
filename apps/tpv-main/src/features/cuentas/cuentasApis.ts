import { commands } from "@tpv/client";
// src/features/cuentas/cuentasApis.ts
//
// API de cuentas (caja): una función por comando Tauri, con los tipos que genera Specta desde Rust.
// Lo que vuelve se entrega tal cual —sin convertirlo a camelCase ni «normalizarlo»— y lo que se
// escribe es el `Input` generado, con el dinero como `Dinero` (RI-53). Aquí quedan además las
// denominaciones del cajón y el recuento, que son sólo de la pantalla.


import type {
    AnulacionPagoDto,
    AnularPagoInput,
    CreateGastoInput,
    CuentasRangoArgs,
    CursorCuentas,
    Dinero,
    EntradaDto,
    PaginaEntradas,
    PaginaSalidas,
    ResumenCajaDto,
    SalidaDto,
    UpdateGastoInput,
    UpdatePagoInput,
} from "@tpv/contracts";

import { deCentimos } from "../../shared/lib/dinero";

export type { CursorCuentas, EntradaDto, SalidaDto };

/** Un cobro anulado NO se borra (CUENTA-07): sale en la lista, marcado. */
export function esAnulado(e: EntradaDto): boolean {
    return e.estado === "ANULADO";
}

/** Tamaño de página por defecto de los listados de caja (CUENTA-05). */
export const CUENTAS_PAGE_SIZE = 50;

export type Denom = {
    label: string;
    value: Dinero;
    kind: "moneda" | "billete";
};

export type CashCount = Record<string, number>;

/* =========================
   Constantes
========================= */

export const DEFAULT_DENOMS: Denom[] = [
    { label: "0.01€", value: deCentimos(1), kind: "moneda" },
    { label: "0.02€", value: deCentimos(2), kind: "moneda" },
    { label: "0.05€", value: deCentimos(5), kind: "moneda" },
    { label: "0.10€", value: deCentimos(10), kind: "moneda" },
    { label: "0.20€", value: deCentimos(20), kind: "moneda" },
    { label: "0.50€", value: deCentimos(50), kind: "moneda" },
    { label: "1€", value: deCentimos(100), kind: "moneda" },
    { label: "2€", value: deCentimos(200), kind: "moneda" },
    { label: "5€", value: deCentimos(500), kind: "billete" },
    { label: "10€", value: deCentimos(1_000), kind: "billete" },
    { label: "20€", value: deCentimos(2_000), kind: "billete" },
    { label: "50€", value: deCentimos(5_000), kind: "billete" },
    { label: "100€", value: deCentimos(10_000), kind: "billete" },
    { label: "200€", value: deCentimos(20_000), kind: "billete" },
];

/* =========================
   Proveedores mini
========================= */

/* =========================
   GET
========================= */

/** Filtros de listado. `page`/`page_size` omitidos ⇒ el backend devuelve TODAS las filas (PDF). */
export type CuentasListParams = CuentasRangoArgs;

function rango(params: CuentasRangoArgs): CuentasRangoArgs {
    return { ...params, q: params.q?.trim() || undefined };
}

/** Sin `page_size` vuelve todo el rango en una página (el PDF); con él, `siguiente` dice dónde
 *  empieza la próxima (RI-18). */
export function cuentasGetEntradas(params: CuentasRangoArgs): Promise<PaginaEntradas> {
    return commands.cuentasGetEntradas(rango(params));
}

export function cuentasGetSalidas(params: CuentasRangoArgs): Promise<PaginaSalidas> {
    return commands.cuentasGetSalidas(rango(params));
}

export function cuentasGetResumen(params: CuentasRangoArgs): Promise<ResumenCajaDto> {
    return commands.cuentasGetResumen(rango(params));
}

/* =========================
   ESCRITURAS
========================= */

/**
 * Una escritura de caja con su motivo de rectificación (CAJA-01). El motivo viaja fuera de `args`
 * porque no es un dato del apunte: es de la corrección, y sólo hace falta cuando el cambio mueve el
 * descuadre de un cierre ya hecho.
 */
export type ConMotivo<T> = { args: T; motivoRectificacion?: string | null };

export function cuentasCreateGasto(p: ConMotivo<CreateGastoInput>): Promise<boolean> {
    return commands.cuentasCreateGasto(p.args, p.motivoRectificacion?.trim() || null);
}

export function cuentasUpdateGasto(p: ConMotivo<UpdateGastoInput>): Promise<boolean> {
    return commands.cuentasUpdateGasto(p.args, p.motivoRectificacion?.trim() || null);
}

export function cuentasDeleteGasto(p: ConMotivo<{ id_gasto: string }>): Promise<boolean> {
    return commands.cuentasDeleteGasto(p.args, p.motivoRectificacion?.trim() || null);
}

/** El importe del cobro no se edita (CUENTA-02): el backend lo recalcula desde las líneas. */
export function cuentasUpdatePago(p: ConMotivo<UpdatePagoInput>): Promise<boolean> {
    return commands.cuentasUpdatePago(p.args, p.motivoRectificacion?.trim() || null);
}

/**
 * Anula un cobro (CUENTA-07). Antes lo borraba, y ése era el agujero: el arqueo bajaba el esperado
 * exactamente lo mismo que faltaba en el cajón y el descuadre salía cero.
 *
 * El motivo es obligatorio; quién anula NO se manda —lo pone la sesión del backend (SEC-01)—.
 * `clase` es una `ClaseBaja`; ausente = `"ERROR"`. Devuelve también adónde volvieron las líneas
 * (CAJ-INC-02), para decirlo.
 */
export function cuentasAnularPago(args: AnularPagoInput): Promise<AnulacionPagoDto> {
    return commands.cuentasAnularPago(args);
}

/**
 * CAJ-INC-02 · Lo que se le dice a quien da de baja un cobro sobre sus líneas, o `null` si no hay
 * nada que decir (una devolución, o no quedaba nada sin cobrar).
 */
export function avisoDeLineasDevueltas(h: AnulacionPagoDto): string | null {
    if (!h.anulado) return null;
    // Como en el ticket: a un número a secas se le antepone «Mesa».
    const donde = h.mesa ? (/^\d+$/.test(h.mesa) ? `la Mesa ${h.mesa}` : h.mesa) : "su ticket";
    switch (h.lineas) {
        case "su_comanda":
            return `Sus consumiciones vuelven a estar pendientes en ${donde}, que se ha reabierto.`;
        case "su_cuenta_abierta":
            // Un cobro de parte de una cuenta que sigue abierta: no se ha cerrado, no se reabre.
            return h.mesa
                ? `Sus consumiciones vuelven a estar pendientes en la cuenta de ${donde}.`
                : "Sus consumiciones vuelven a estar pendientes en su ticket.";
        case "la_abierta":
            return `La mesa se había vuelto a abrir: sus consumiciones se han añadido a la cuenta abierta de ${donde}.`;
        default:
            return null;
    }
}

/**
 * Lo que se puede hacer en Cuentas con estos permisos, en una frase para la cabecera. En la Handy
 * (`soloConsulta`) Cuentas es de consulta: cobrar, devolver, dar de baja, los gastos y los cierres
 * se hacen en el TPV principal; reimprimir un ticket, sí.
 */
export function subtituloCuentas(p: { cobros: boolean; gastos: boolean; soloConsulta: boolean }): string {
    if (p.cobros && p.gastos) return "Filtra ingresos y gastos por fecha o búsqueda.";
    if (p.soloConsulta) {
        if (p.cobros) return "Los cobros: consúltalos y reimprime un ticket.";
        if (p.gastos) return "Los gastos: consúltalos.";
        return "Repasa los cierres hechos.";
    }
    if (p.cobros) return "Los cobros: reimprime un ticket, devuélvelo o dalo de baja.";
    if (p.gastos) return "Los gastos: apúntalos y corrígelos.";
    return "Cierra la caja y repasa los cierres hechos.";
}

/** Las líneas de un cobro con lo que queda por devolver de cada una. */


/** Devuelve parte de un cobro: un pago negativo con su factura rectificativa. */


/** Una devolución de parte de otro cobro: un pago negativo. Se reimprime y nada más. */
export function esDevolucion(e: EntradaDto): boolean {
    return e.es_devolucion ?? false;
}

/**
 * Los dos instrumentos de FISCAL-01. La AEAT los separa sin matices:
 *
 * - `"ERROR"`: la venta **no existió** (ticket de prueba, mesa equivocada). Genera un registro
 *   de anulación, devuelve el stock y las líneas vuelven a la comanda.
 * - `"DEVOLUCION"`: la venta **sí existió** y se devuelve el dinero. Genera una factura
 *   rectificativa (`R5`). El stock no vuelve y las líneas tampoco.
 *
 *
 * - Anular es para una factura que *no responde a una operación real* (art. 11.1 RRSIF), y su FAQ
 *   dice que estos casos deben ser «MUY POCO FRECUENTES».
 * - Rectificar es para cuando la operación **sí existió**: *«todas las facturas emitidas, en la
 *   medida en que respondan a operaciones realmente efectuadas (como es el caso habitual) no pueden
 *   anularse»*.
 *
 * Y la que más se va a usar —la devolución— es justo la que no era una anulación.
 */
export type ClaseBaja = "ERROR" | "DEVOLUCION";

/**
 * A qué cierres de caja ya hechos afectaría un cambio, y cómo quedarían (CAJA-01). No toca nada:
 * la pantalla lo pide antes de guardar para avisar. Si `cierres` viene vacío, el apunte es del
 * periodo abierto y no hay nada que avisar.
 */


/* =========================================================
   Recuento de efectivo (lo usa el cierre de caja). El total no
   vive aquí: es `totalRecuento`, en `shared/lib/efectivo.ts`.
========================================================= */

export function incCash(count: CashCount, label: string, step = 1): CashCount {
    const next = { ...(count ?? {}) };
    const prev = Number(next[label] ?? 0);
    const value = Number.isFinite(prev) ? prev : 0;

    next[label] = value + step;

    return next;
}

export function decCash(count: CashCount, label: string, step = 1): CashCount {
    const next = { ...(count ?? {}) };
    const prev = Number(next[label] ?? 0);
    const value = Number.isFinite(prev) ? prev : 0;

    next[label] = Math.max(0, value - step);

    return next;
}

export function resetCash(): CashCount {
    return {};
}
