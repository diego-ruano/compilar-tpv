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
    /** Tipo de IVA de la línea; `null` = el general del negocio. */
    iva_percent: number | null;
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
    /** Ruta del logo en AppData (o data URL heredado). Lo lee Rust al imprimir. */
    logo_path: string | null;
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

    /** Número correlativo. Ausente/null = precuenta (se marca "no es un ticket de venta"). */
    numero_ticket?: string | null;
    /** Cómo se cobró. Ausente en una precuenta. */
    metodo_pago?: string | null;
    /** De dónde sale la venta: `Mesa 5`, `Barra`… */
    origen?: string | null;
    /** Reimpresión: mismo número, marcado como COPIA. */
    es_copia?: boolean;

    items: PrintTicketLine[];
};

/** Lo que distingue un ticket de venta de una precuenta o de una copia. */
export type DatosDelTicket = {
    numeroTicket?: string | null;
    metodoPago?: string | null;
    origen?: string | null;
    esCopia?: boolean;
};

/** Item simple (cada unidad por separado); `buildTicketPayload` los agrupa. */
export type SimpleTicketItem = {
    nombre: string;
    precio: number;
    /** Tipo de IVA de la línea; `null`/ausente = el general del negocio. */
    ivaPercent?: number | null;
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
 */
export async function printerOpenDrawer(idUsuario?: string | null): Promise<void> {
    await invokeClient<string>("printer_open_drawer", {
        args: { id_usuario: idUsuario ?? null },
    });
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
    datos?: DatosDelTicket,
): PrintTicketPayload {
    const biz = useBusinessSettings.getState();
    const t = useTicketSettings.getState().settings;

    // Se agrupa por nombre + precio + TIPO: dos unidades del mismo producto vendidas a tipos
    // distintos (porque alguien lo cambió entre medias) son dos líneas, no una.
    const map = new Map<string, PrintTicketLine>();
    for (const it of items) {
        const iva = it.ivaPercent ?? null;
        const key = `${it.nombre}__${it.precio}__${iva ?? "neg"}`;
        const cur = map.get(key);
        if (cur) {
            cur.cantidad += 1;
        } else {
            map.set(key, {
                nombre: it.nombre,
                precio_unitario: it.precio,
                cantidad: 1,
                iva_percent: iva,
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
        logo_path: biz.logoDataUrl ?? null,
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

        numero_ticket: datos?.numeroTicket ?? null,
        metodo_pago: datos?.metodoPago ?? null,
        origen: datos?.origen ?? null,
        es_copia: datos?.esCopia ?? false,

        items: Array.from(map.values()),
    };
}
