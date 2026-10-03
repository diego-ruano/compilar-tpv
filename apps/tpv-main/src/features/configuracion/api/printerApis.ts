// src/features/configuracion/api/printerApis.ts
//
// API de impresión (host/Windows) — Local-First (invokeClient). Habla con los comandos
// `printer_*` del backend (ver `apps/tpv-main/src-tauri/src/printing.rs` + `main.rs`):
//   - listar impresoras del sistema (locales + red/WiFi)
//   - leer/guardar la impresora seleccionada (preferencia LOCAL del dispositivo)
//   - imprimir un ticket real (ESC/POS) respetando la personalización del front
//   - imprimir un ticket de prueba
//
// La impresora seleccionada NO va en la BD (no se sincroniza): está físicamente conectada a
// esta máquina, así que se persiste en `device_config.json` por el backend.

import { invokeClient } from "@tpv/client";
import type { PrinterInfo, PrintTicketPayload } from "@tpv/contracts";

import { useBusinessSettings } from "../../../shared/stores/useBusinessSettings";
import { useTicketSettings } from "../../../shared/stores/useTicketSettings";
import { agruparLineas, type LineaEntrada } from "../../../shared/ticket/ticketMath";

export type { PrinterInfo };

/** Lo que distingue un ticket de venta de una precuenta, de una copia o de un cobro anulado. */
export type DatosDelTicket = {
    numeroTicket?: string | null;
    metodoPago?: string | null;
    origen?: string | null;
    esCopia?: boolean;
    esAnulado?: boolean;
    /** FISCAL-01: la URL del QR tributario, leída del registro (ver `PrintTicketPayload.qr_url`). */
    qrUrl?: string | null;
    /** El registro se emitió en el entorno de pruebas. */
    qrPruebas?: boolean;
};

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

export async function printerPrintTicket(payload: PrintTicketPayload): Promise<void> {
    await invokeClient<string>("printer_print_ticket", { payload });
}

/* ── Helper: construir el payload desde los stores de configuración ── */

/**
 * Construye el `PrintTicketPayload` a partir de los items (cada unidad por separado) y de la
 * personalización actual (business + ticket settings de los stores Zustand).
 *
 * Las líneas las agrupa `agruparLineas`, **la misma función que pinta la vista previa**. Había aquí
 * una segunda copia y se habían separado: la previa redondeaba al céntimo el importe de un producto
 * al peso y ésta no, así que 12,34 € × 0,333 viajaba como 410,92 céntimos, Rust no podía leerlo
 * como `Dinero` y el ticket no salía (RI-53).
 */
export function buildTicketPayload(
    items: LineaEntrada[],
    printerName?: string,
    datos?: DatosDelTicket,
): PrintTicketPayload {
    const biz = useBusinessSettings.getState();
    const t = useTicketSettings.getState().settings;

    return {
        printer_name: printerName,

        business_name: biz.businessName,
        direccion: biz.direccion,
        telefono: biz.telefono,
        cif: biz.cif,
        mensaje_footer: biz.mensajeFooter,
        iva_percent: biz.ivaPercent,

        show_logo: t.showLogo,
        logo_path: biz.logoDataUrl ?? undefined,
        show_business_name: t.showBusinessName,
        show_address: t.showAddress,
        show_phone: t.showPhone,
        show_cif: t.showCif,
        show_date_time: t.showDateTime,
        show_line_items: t.showLineItems,
        show_base_and_iva: t.showBaseAndIva,
        show_total: t.showTotal,
        show_footer_message: t.showFooterMessage,

        paper_width_mm: t.paperWidthMm,

        paper_dpi: t.paperDpi,
        chars_per_line: t.charsPerLine,
        margin_top_mm: t.marginTopMm,
        margin_bottom_mm: t.marginBottomMm,
        margin_left_mm: t.marginLeftMm,
        margin_right_mm: t.marginRightMm,
        font_scale: t.fontScale,

        numero_ticket: datos?.numeroTicket ?? undefined,
        metodo_pago: datos?.metodoPago ?? undefined,
        origen: datos?.origen ?? undefined,
        es_copia: datos?.esCopia ?? false,
        es_anulado: datos?.esAnulado ?? false,

        qr_url: datos?.qrUrl ?? undefined,
        qr_pruebas: datos?.qrPruebas ?? false,

        items: agruparLineas(items).map((g) => ({
            nombre: g.nombre,
            cantidad: g.qty,
            precio_unitario: g.precio,
            iva_percent: g.ivaPercent ?? undefined,
        })),
    };
}
