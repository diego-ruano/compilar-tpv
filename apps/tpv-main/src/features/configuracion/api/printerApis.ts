// src/features/configuracion/api/printerApis.ts
//
// API de impresión (host/Windows) — Local-First (invokeClient). Habla con los comandos
// `printer_*` del backend (ver `apps/tpv-main/src-tauri/src/printing.rs` + `main.rs`):
//   - listar impresoras del sistema (locales + red/WiFi)
//   - leer/guardar la impresora seleccionada (preferencia LOCAL del dispositivo)
//   - el ticket de un cobro (RI-29): lo compone Rust desde la base; aquí sólo se pide y se imprime
//   - la precuenta: la compone la pantalla y Rust le quita todo lo fiscal
//   - imprimir un ticket de prueba
//
// La impresora seleccionada NO va en la BD (no se sincroniza): está físicamente conectada a
// esta máquina, así que se persiste en `device_config.json` por el backend.

import { invokeClient } from "@tpv/client";
import type { PrinterInfo, PrintTicketPayload, TicketDePagoInput } from "@tpv/contracts";

import { useBusinessSettings } from "../../../shared/stores/useBusinessSettings";
import { useTicketSettings } from "../../../shared/stores/useTicketSettings";
import { agruparLineas, type LineaEntrada } from "../../../shared/ticket/ticketMath";

export type { PrinterInfo };

/* ── API ── */

export async function printerList(): Promise<PrinterInfo[]> {
    return await invokeClient<PrinterInfo[]>("printer_list");
}

/**
 * Destino de impresión. Hoy solo se usa `caja`; `cocina` está declarado para que añadir la comanda
 * de cocina no obligue a rehacer el modelo de selección de impresora ni a migrar la configuración
 * de nadie. Ausente = `caja`.
 */
export type DestinoImpresion = "caja" | "cocina";

export async function printerGetSelected(
    destino: DestinoImpresion = "caja",
): Promise<string | null> {
    return (
        (await invokeClient<string | null>("printer_get_selected", {
            args: { destino },
        })) ?? null
    );
}

export async function printerSetSelected(
    name: string,
    destino: DestinoImpresion = "caja",
): Promise<void> {
    await invokeClient<string>("printer_set_selected", { args: { name, destino } });
}

/**
 * Abre el cajón portamonedas sin imprimir nada (para dar cambio o cuadrar caja).
 *
 * Queda registrado con quién y cuándo: una apertura sin venta detrás es la única por la que
 * alguien pregunta cuando falta dinero. No pide permiso de administrador — el camarero lo
 * necesita, y poner fricción ahí acaba en que todos conocen el PIN del encargado.
 *
 * SEC-01: **quién abre no se manda**. Sí hace falta haber iniciado sesión, y el nombre que se
 * anota lo pone el backend: una fila de auditoría firmada con lo que diga la pantalla registra
 * quién dijo alguien que abrió el cajón, no quién lo abrió.
 */
export async function printerOpenDrawer(): Promise<void> {
    await invokeClient<string>("printer_open_drawer");
}

export async function printerPrintTest(name?: string): Promise<void> {
    await invokeClient<string>("printer_print_test", {
        args: name ? { name } : null,
    });
}

/**
 * El ticket de un cobro, tal como va a salir: lo compone Rust desde el pago y su factura (RI-29).
 * La pantalla lo pide para enseñarlo, nunca lo arma.
 */
export async function printerTicketDePago(
    idPago: string,
    esCopia = false,
): Promise<PrintTicketPayload> {
    const args: TicketDePagoInput = { id_pago: idPago, es_copia: esCopia };
    return await invokeClient<PrintTicketPayload>("printer_ticket_de_pago", { args });
}

/** Imprime el ticket de un cobro. Rust lo vuelve a componer: no viaja el papel, sólo el pago. */
export async function printerImprimirPago(idPago: string, esCopia = false): Promise<void> {
    const args: TicketDePagoInput = { id_pago: idPago, es_copia: esCopia };
    await invokeClient<string>("printer_imprimir_pago", { args });
}

/** Imprime una precuenta. Aunque el payload trajera un número o un QR, Rust se los quita. */
export async function printerImprimirPrecuenta(payload: PrintTicketPayload): Promise<void> {
    await invokeClient<string>("printer_imprimir_precuenta", { payload });
}

/* ── La precuenta: se compone con los ajustes de la pantalla ── */

/**
 * La precuenta de unas líneas (cada unidad por separado), con la personalización actual de los
 * stores. Es lo único que compone la pantalla: sin número, sin QR y sin copia, porque una
 * precuenta no es una factura. La vista previa de Configuración la usa también, para que lo que se
 * ve al tocar una casilla cambie al momento.
 *
 * Las líneas las agrupa `agruparLineas`, gemela de `agrupar_lineas` en Rust (RI-53).
 */
export function payloadDePrecuenta(items: LineaEntrada[], printerName?: string): PrintTicketPayload {
    const biz = useBusinessSettings.getState();
    const t = useTicketSettings.getState().settings;

    return {
        printer_name: printerName,

        business_name: biz.businessName,
        direccion: biz.direccion,
        telefono: biz.telefono,
        cif: biz.cif,
        razon_social: biz.razonSocial,
        mensaje_footer: biz.mensajeFooter,
        iva_percent: biz.ivaPercent,

        show_logo: t.showLogo,
        logo_path: biz.logoDataUrl ?? undefined,
        show_business_name: t.showBusinessName,
        show_address: t.showAddress,
        show_phone: t.showPhone,
        show_footer_message: t.showFooterMessage,

        paper_width_mm: t.paperWidthMm,

        paper_dpi: t.paperDpi,
        chars_per_line: t.charsPerLine,
        margin_top_mm: t.marginTopMm,
        margin_bottom_mm: t.marginBottomMm,
        margin_left_mm: t.marginLeftMm,
        margin_right_mm: t.marginRightMm,
        font_scale: t.fontScale,

        qr_pruebas: false,
        es_copia: false,
        es_anulado: false,

        items: agruparLineas(items).map((g) => ({
            nombre: g.nombre,
            cantidad: g.qty,
            precio_unitario: g.precio,
            iva_percent: g.ivaPercent ?? undefined,
        })),
    };
}
