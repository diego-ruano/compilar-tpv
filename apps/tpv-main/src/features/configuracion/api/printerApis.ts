import { commands } from "@tpv/client";
// src/features/configuracion/api/printerApis.ts
//
// API de impresión (host/Windows) — Local-First (commands). Habla con los comandos
// `printer_*` del backend (ver `apps/tpv-main/src-tauri/src/printing.rs` + `main.rs`):
//   - listar impresoras del sistema (locales + red/WiFi)
//   - leer/guardar la impresora seleccionada (preferencia LOCAL del dispositivo)
//   - el ticket de un cobro (RI-29): lo compone Rust desde la base; aquí sólo se pide y se imprime
//   - la precuenta: la compone la pantalla y Rust le quita todo lo fiscal
//   - imprimir un ticket de prueba
//
// La impresora seleccionada NO va en la BD (no se sincroniza): está físicamente conectada a
// esta máquina, así que se persiste en `device_config.json` por el backend.


import type { PrinterInfo, PrintTicketPayload_Serialize as PrintTicketPayload, TicketDePagoInput } from "@tpv/contracts";

import { useBusinessSettings } from "../../../shared/stores/useBusinessSettings";
import { useTicketSettings } from "../../../shared/stores/useTicketSettings";
import { agruparLineas, type LineaEntrada } from "../../../shared/ticket/ticketMath";

export type { PrinterInfo };

/* ── API ── */

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
        (await commands.printerGetSelected({ destino })) ?? null
    );
}

export async function printerSetSelected(
    name: string,
    destino: DestinoImpresion = "caja",
): Promise<void> {
    await commands.printerSetSelected({ name, destino });
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
    await commands.printerOpenDrawer();
}

export async function printerPrintTest(name?: string): Promise<void> {
    await commands.printerPrintTest(name ? { name } : null);
}

/**
 * El ticket de un cobro, tal como va a salir: lo compone Rust desde el pago y su factura (RI-29).
 * La pantalla lo pide para enseñarlo, nunca lo arma.
 */
export async function printerTicketDePago(
    idPago: string,
    esCopia = false,
    numFactura?: string | null,
): Promise<PrintTicketPayload> {
    const args: TicketDePagoInput = {
        id_pago: idPago,
        es_copia: esCopia,
        num_factura: numFactura ?? undefined,
    };
    return await commands.printerTicketDePago(args);
}

/**
 * Imprime el ticket de un cobro. Rust lo vuelve a componer: no viaja el papel, sólo el pago.
 * `numFactura` pide otra factura del mismo pago: la completa (`F3`) que canjeó su ticket.
 */
export async function printerImprimirPago(
    idPago: string,
    esCopia = false,
    numFactura?: string | null,
): Promise<void> {
    const args: TicketDePagoInput = {
        id_pago: idPago,
        es_copia: esCopia,
        num_factura: numFactura ?? undefined,
    };
    await commands.printerImprimirPago(args);
}

/** Imprime una precuenta. Aunque el payload trajera un número o un QR, Rust se los quita. */
export async function printerImprimirPrecuenta(payload: PrintTicketPayload): Promise<void> {
    await commands.printerImprimirPrecuenta(payload);
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

        business_name: biz.business_name,
        direccion: biz.direccion,
        telefono: biz.telefono,
        cif: biz.cif,
        razon_social: biz.razon_social,
        mensaje_footer: biz.mensaje_footer,
        iva_percent: biz.iva_percent,

        show_logo: t.show_logo,
        logo_path: biz.logo_data_url ?? undefined,
        show_business_name: t.show_business_name,
        show_address: t.show_address,
        show_phone: t.show_phone,
        show_footer_message: t.show_footer_message,

        paper_width_mm: t.paper_width_mm,

        paper_dpi: t.paper_dpi,
        chars_per_line: t.chars_per_line,
        margin_top_mm: t.margin_top_mm,
        margin_bottom_mm: t.margin_bottom_mm,
        margin_left_mm: t.margin_left_mm,
        margin_right_mm: t.margin_right_mm,
        font_scale: t.font_scale,

        qr_pruebas: false,
        es_copia: false,
        es_anulado: false,
        abre_cajon: false,
        sustituye: [],
        facturas_del_cobro: [],

        items: agruparLineas(items).map((g) => ({
            nombre: g.nombre,
            cantidad: g.qty,
            precio_unitario: g.precio,
            iva_percent: g.iva_percent ?? undefined,
        })),
    };
}
