// src/features/cuentas/cierreApis.ts
//
// Cierre de caja (arqueo). CUENTA-06.
//
// El recuento se maneja en la UI como `CashCount` (un mapa etiqueta → unidades, que es lo que el
// contador de monedas viene usando desde siempre) y se traduce a denominaciones al cruzar a Rust.
// La traducción vive aquí y no en el componente para que la pantalla no tenga que saber en qué
// forma se guarda un arqueo.

import { invokeClient } from "@tpv/client";
import { useBusinessSettings } from "../../shared/stores/useBusinessSettings";
import { useTicketSettings } from "../../shared/stores/useTicketSettings";
import type {
    CierreDto,
    CierreResumenDto,
    PreparacionCierreDto,
} from "@tpv/contracts";

import type { CashCount, Denom } from "./cuentasApis";

export type { CierreDto, CierreResumenDto, PreparacionCierreDto };

/** `CashCount` → lo que espera el comando. Las denominaciones sin unidades no se mandan. */
export function aDenominaciones(
    denoms: Denom[],
    count: CashCount,
): Array<{ valor: number; unidades: number }> {
    return denoms
        .map((d) => ({ valor: d.value, unidades: Number(count?.[d.label] ?? 0) }))
        .filter((d) => Number.isFinite(d.unidades) && d.unidades > 0);
}

/** Lo contrario: el desglose guardado vuelve a la forma que pinta el contador. */
export function aCashCount(
    denoms: Denom[],
    guardadas: Array<{ valor: number; unidades: number }>,
): CashCount {
    const out: CashCount = {};
    for (const g of guardadas ?? []) {
        const d = denoms.find((x) => Math.abs(x.value - g.valor) < 1e-9);
        if (d) out[d.label] = g.unidades;
    }
    return out;
}

/** Lo que hace falta saber antes de contar: desde cuándo, cuánto se espera y qué avisar. */
export function cierrePreparar(): Promise<PreparacionCierreDto> {
    return invokeClient<PreparacionCierreDto>("cierre_preparar");
}

export function cierreConfirmar(payload: {
    fondoInicial?: number | null;
    contado: Array<{ valor: number; unidades: number }>;
    dejado: Array<{ valor: number; unidades: number }>;
    motivo?: string | null;
    idUsuario?: string | null;
}): Promise<CierreDto> {
    return invokeClient<CierreDto>("cierre_confirmar", {
        args: {
            fondo_inicial: payload.fondoInicial ?? null,
            contado: payload.contado,
            dejado: payload.dejado,
            motivo: payload.motivo?.trim() ? payload.motivo.trim() : null,
            id_usuario: payload.idUsuario ?? null,
        },
    });
}

export function cierreListar(limite = 50): Promise<CierreResumenDto[]> {
    return invokeClient<CierreResumenDto[]>("cierre_listar", {
        args: { limite },
    });
}

export function cierreDetalle(idCierre: string): Promise<CierreDto> {
    return invokeClient<CierreDto>("cierre_detalle", { idCierre });
}

export function cierreReabrir(
    idCierre: string,
    idUsuario?: string | null,
): Promise<boolean> {
    return invokeClient<boolean>("cierre_reabrir", {
        args: { id_cierre: idCierre, id_usuario: idUsuario ?? null },
    });
}

/**
 * Imprime el papel de un arqueo.
 *
 * Es un documento INTERNO: no gasta numero de ticket ni abre el cajon. Reutiliza los ajustes de
 * papel del ticket (ancho, DPI, margenes) porque sale por la misma impresora; lo que no reutiliza
 * es nada de su contenido fiscal.
 */
export function cierreImprimir(c: CierreDto): Promise<string> {
    const t = useTicketSettings.getState().settings;
    const b = useBusinessSettings.getState();
    return invokeClient<string>("printer_print_arqueo", {
        payload: {
            business_name: b.businessName ?? "",
            fecha_hora: c.fecha_hora,
            desde: null,
            usuario: c.usuario_nombre ?? null,
            fondo_inicial: c.fondo_inicial,
            ventas_efectivo: c.ventas_efectivo,
            esperado: c.esperado,
            contado: c.contado,
            descuadre: c.descuadre,
            dejado: c.dejado,
            retirado: c.retirado,
            motivo: c.motivo ?? null,
            contado_denoms: (c.contado_denoms ?? []).map((d) => [d.valor, d.unidades]),
            paper_width_mm: t.paperWidthMm,
            paper_dpi: t.paperDpi,
            chars_per_line: t.charsPerLine,
            margin_top_mm: t.marginTopMm,
            margin_bottom_mm: t.marginBottomMm,
            margin_left_mm: t.marginLeftMm,
            margin_right_mm: t.marginRightMm,
        },
    });
}
