// src/features/cuentas/cierreApis.ts
//
// Cierre de caja (arqueo). CUENTA-06 · CAJA-01.
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
    ConfirmarCierreInput,
    DenominacionInput,
    Dinero,
    PreparacionCierreDto,
    PrintArqueoPayload,
} from "@tpv/contracts";

import type { CashCount, Denom } from "./cuentasApis";

export type { CierreDto, CierreResumenDto, PreparacionCierreDto };

/** `CashCount` → lo que espera el comando. Las denominaciones sin unidades no se mandan. */
export function aDenominaciones(
    denoms: Denom[],
    count: CashCount,
): DenominacionInput[] {
    return denoms
        .map((d) => ({ valor: d.value, unidades: Number(count?.[d.label] ?? 0) }))
        .filter((d) => Number.isFinite(d.unidades) && d.unidades > 0);
}

/** Lo que hace falta saber antes de contar: desde cuándo, cuánto se espera y qué avisar. */
export function cierrePreparar(): Promise<PreparacionCierreDto> {
    return invokeClient<PreparacionCierreDto>("cierre_preparar");
}

/**
 * Cierra el periodo de caja.
 *
 * SEC-01: **quién cierra no se manda**. Lo pone la sesión del backend, porque un arqueo firmado
 * con el nombre que le pase la pantalla es una auditoría que da confianza sin merecerla. Lo
 * mismo vale para `cierreReabrir`.
 */
export function cierreConfirmar(payload: {
    /** Clave de idempotencia del cierre (RI-58): la misma en cada intento de confirmar. */
    idCierre: string;
    fondoInicial?: Dinero | null;
    contado: DenominacionInput[];
    dejado: DenominacionInput[];
    motivo?: string | null;
}): Promise<CierreDto> {
    const args: ConfirmarCierreInput = {
        id_cierre: payload.idCierre,
        fondo_inicial: payload.fondoInicial ?? undefined,
        contado: payload.contado,
        dejado: payload.dejado,
        motivo: payload.motivo?.trim() || undefined,
    };
    return invokeClient<CierreDto>("cierre_confirmar", { args });
}

export function cierreListar(limite = 50): Promise<CierreResumenDto[]> {
    return invokeClient<CierreResumenDto[]>("cierre_listar", {
        args: { limite },
    });
}

export function cierreDetalle(idCierre: string): Promise<CierreDto> {
    return invokeClient<CierreDto>("cierre_detalle", { idCierre });
}

/**
 * Deshace el último cierre para volver a contar el cajón (CAJA-01). El comando conserva el nombre
 * de cuando esto se llamaba «reabrir»: renombrarlo rompería en tiempo de ejecución sin avisar.
 */
export function cierreReabrir(idCierre: string): Promise<boolean> {
    return invokeClient<boolean>("cierre_reabrir", {
        args: { id_cierre: idCierre },
    });
}

/**
 * Imprime el papel de un arqueo.
 *
 * Es un documento INTERNO: no gasta numero de ticket ni abre el cajon. Reutiliza los ajustes de
 * papel del ticket (ancho, DPI, margenes) porque sale por la misma impresora; lo que no reutiliza
 * es nada de su contenido fiscal.
 *
 * Si el cierre se rectificó después (CAJA-01), el papel lleva la foto de esa noche y, aparte, lo que
 * marca hoy con cada corrección y su motivo.
 */
export function cierreImprimir(c: CierreDto): Promise<string> {
    const t = useTicketSettings.getState().settings;
    const b = useBusinessSettings.getState();
    const payload: PrintArqueoPayload = {
        business_name: b.businessName ?? "",
        fecha_hora: c.fecha_hora,
        desde: c.periodo_desde,
        usuario: c.usuario_nombre,
        fondo_inicial: c.fondo_inicial,
        ventas_efectivo: c.ventas_efectivo,
        gastos_caja: c.gastos_caja,
        esperado: c.esperado,
        contado: c.contado,
        descuadre: c.descuadre,
        dejado: c.dejado,
        retirado: c.retirado,
        motivo: c.motivo,
        contado_denoms: c.contado_denoms.map((d) => [d.valor, d.unidades]),
        rect_esperado: c.rect_esperado,
        rect_descuadre: c.rect_descuadre,
        rectificaciones: (c.rectificaciones ?? []).map((r) => ({
            fecha_hora: r.fecha_hora,
            descripcion: r.descripcion,
            motivo: r.motivo,
        })),
        paper_width_mm: t.paperWidthMm,
        paper_dpi: t.paperDpi,
        chars_per_line: t.charsPerLine,
        margin_top_mm: t.marginTopMm,
        margin_bottom_mm: t.marginBottomMm,
        margin_left_mm: t.marginLeftMm,
        margin_right_mm: t.marginRightMm,
    };
    return invokeClient<string>("printer_print_arqueo", { payload });
}
