// src/features/cuentas/cuentasApis.ts
//
// API de cuentas (caja): una función por comando Tauri, con los tipos que genera ts-rs desde Rust.
// Lo que vuelve se entrega tal cual —sin convertirlo a camelCase ni «normalizarlo»— y lo que se
// escribe es el `Input` generado, con el dinero como `Dinero` (RI-53). Aquí quedan además las
// denominaciones del cajón y el recuento, que son sólo de la pantalla.

import { invokeClient } from "@tpv/client";
import type {
    AnularPagoInput,
    CambioCajaInput,
    CobroDevolubleDto,
    DevolucionDto,
    DevolverLineasInput,
    CreateGastoInput,
    CuentasRangoArgs,
    CursorCuentas,
    Dinero,
    EntradaDto,
    ImpactoCajaDto,
    PaginaEntradas,
    PaginaSalidas,
    ProveedorMiniDto,
    ResumenCajaDto,
    SalidaDto,
    UpdateGastoInput,
    UpdatePagoInput,
} from "@tpv/contracts";

import { deCentimos } from "../../shared/lib/dinero";

export type { CursorCuentas, EntradaDto, PaginaEntradas, PaginaSalidas, SalidaDto };

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

export function cuentasListProveedoresMini(): Promise<ProveedorMiniDto[]> {
    return invokeClient<ProveedorMiniDto[]>("inventario_list_proveedores_mini");
}

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
    return invokeClient<PaginaEntradas>("cuentas_get_entradas", { args: rango(params) });
}

export function cuentasGetSalidas(params: CuentasRangoArgs): Promise<PaginaSalidas> {
    return invokeClient<PaginaSalidas>("cuentas_get_salidas", { args: rango(params) });
}

export function cuentasGetResumen(params: CuentasRangoArgs): Promise<ResumenCajaDto> {
    return invokeClient<ResumenCajaDto>("cuentas_get_resumen", { args: rango(params) });
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

async function escribir<T>(comando: string, { args, motivoRectificacion }: ConMotivo<T>) {
    const r = await invokeClient<boolean>(comando, {
        args,
        motivoRectificacion: motivoRectificacion?.trim() || null,
    });
    return r !== false;
}

export function cuentasCreateGasto(p: ConMotivo<CreateGastoInput>): Promise<boolean> {
    return escribir("cuentas_create_gasto", p);
}

export function cuentasUpdateGasto(p: ConMotivo<UpdateGastoInput>): Promise<boolean> {
    return escribir("cuentas_update_gasto", p);
}

export function cuentasDeleteGasto(p: ConMotivo<{ id_gasto: string }>): Promise<boolean> {
    return escribir("cuentas_delete_gasto", p);
}

/** El importe del cobro no se edita (CUENTA-02): el backend lo recalcula desde las líneas. */
export function cuentasUpdatePago(p: ConMotivo<UpdatePagoInput>): Promise<boolean> {
    return escribir("cuentas_update_pago", p);
}

/**
 * Anula un cobro (CUENTA-07). Antes lo borraba, y ése era el agujero: el arqueo bajaba el esperado
 * exactamente lo mismo que faltaba en el cajón y el descuadre salía cero.
 *
 * El motivo es obligatorio; quién anula NO se manda —lo pone la sesión del backend (SEC-01)—.
 * `clase` es una `ClaseBaja`; ausente = `"ERROR"`.
 */
export async function cuentasAnularPago(args: AnularPagoInput): Promise<boolean> {
    const r = await invokeClient<boolean>("cuentas_anular_pago", { args });
    return r !== false;
}

/** Las líneas de un cobro con lo que queda por devolver de cada una. */
export function cuentasLineasDevolubles(idPago: string): Promise<CobroDevolubleDto> {
    return invokeClient<CobroDevolubleDto>("cuentas_lineas_devolubles", { idPago });
}

/** Devuelve parte de un cobro: un pago negativo con su factura rectificativa. */
export function cuentasDevolverLineas(args: DevolverLineasInput): Promise<DevolucionDto> {
    return invokeClient<DevolucionDto>("cuentas_devolver_lineas", { args });
}

/** Una devolución de parte de otro cobro: un pago negativo. Se reimprime y nada más. */
export function esDevolucion(e: EntradaDto): boolean {
    return e.es_devolucion;
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
export function cuentasPrevisualizarCambio(cambio: CambioCajaInput): Promise<ImpactoCajaDto> {
    return invokeClient<ImpactoCajaDto>("cuentas_previsualizar_cambio", { args: cambio });
}

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
