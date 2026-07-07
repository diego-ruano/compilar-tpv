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

import { useBusinessSettings } from "../../../shared/stores/useBusinessSettings";
import { useTicketSettings } from "../../../shared/stores/useTicketSettings";

/* ── Tipos ── */

export type PrinterInfo = {
    name: string;
    is_default: boolean;
};

/** Línea agrupada del ticket (snake_case = lo que espera el struct Rust). */
export type PrintTicketLine = {
    nombre: string;
    cantidad: number;
    precio_unitario: number;
};

/** Payload de impresión (snake_case para que serde lo deserialice directamente). */
export type PrintTicketPayload = {
    printer_name: string | null;

    business_name: string;
    direccion: string;
    telefono: string;
    cif: string;
    mensaje_footer: string;
    iva_percent: number;

    show_logo: boolean;
    show_business_name: boolean;
    show_address: boolean;
    show_phone: boolean;
    show_cif: boolean;
    show_date_time: boolean;
    show_line_items: boolean;
    show_base_and_iva: boolean;
    show_total: boolean;
    show_footer_message: boolean;

    paper_width_mm: number;

    paper_dpi: number;
    chars_per_line: number;
    margin_top_mm: number;
    margin_bottom_mm: number;
    margin_left_mm: number;
    margin_right_mm: number;
    font_scale: number;

    items: PrintTicketLine[];
};

/** Item simple (cada unidad por separado); `buildTicketPayload` los agrupa. */
export type SimpleTicketItem = {
    nombre: string;
    precio: number;
};

/* ── API ── */

export async function printerList(): Promise<PrinterInfo[]> {
    return await invokeClient<PrinterInfo[]>("printer_list");
}

export async function printerGetSelected(): Promise<string | null> {
    return (await invokeClient<string | null>("printer_get_selected")) ?? null;
}

export async function printerSetSelected(name: string): Promise<void> {
    await invokeClient<string>("printer_set_selected", { args: { name } });
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
 * personalización actual (business + ticket settings de los stores Zustand). Agrupa las unidades
 * idénticas (mismo nombre + precio) en líneas con su cantidad, igual que la previsualización.
 */
export function buildTicketPayload(
    items: SimpleTicketItem[],
    printerName?: string,
): PrintTicketPayload {
    const biz = useBusinessSettings.getState();
    const t = useTicketSettings.getState().settings;

    const map = new Map<string, PrintTicketLine>();
    for (const it of items) {
        const key = `${it.nombre}__${it.precio}`;
        const cur = map.get(key);
        if (cur) {
            cur.cantidad += 1;
        } else {
            map.set(key, {
                nombre: it.nombre,
                precio_unitario: it.precio,
                cantidad: 1,
            });
        }
    }

    return {
        printer_name: printerName ?? null,

        business_name: biz.businessName,
        direccion: biz.direccion,
        telefono: biz.telefono,
        cif: biz.cif,
        mensaje_footer: biz.mensajeFooter,
        iva_percent: biz.ivaPercent,

        show_logo: t.showLogo,
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

        items: Array.from(map.values()),
    };
}
