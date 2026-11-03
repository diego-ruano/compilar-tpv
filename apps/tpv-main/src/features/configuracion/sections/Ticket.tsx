// src/features/configuracion/sections/Ticket.tsx
import React, { useMemo, useState } from "react";
import { toAppError } from "@tpv/client";
import TicketPreviewModal from "../../../shared/ticket/PreviewModal";
import { useToast } from "../../../shared/toast";
import { Panel } from "../ui/Panel";
import { Field } from "../ui/Field";
import { TextInput } from "../ui/Inputs";
import { Checkbox } from "../ui/Toggles";
import { GhostButton, PrimaryButton } from "../ui/Buttons";
import { PrinterPanel } from "./PrinterPanel";
import { payloadDePrecuenta, printerImprimirPrecuenta } from "../api/printerApis";
import { conAviso } from "../../../shared/lib/conAviso";
import { deCentimos } from "../../../shared/lib/dinero";
import { MSG_IVA } from "../../../shared/lib/iva";

type TicketWidthOpt = {
    value: 58 | 80 | 112; // mm (lo que se guarda en Ticket_Settings)
    label: string;
};

// El ancho de la previsualización ya no se declara aquí: `TicketPaper` se mide en columnas reales
// (se las pregunta a Rust), así que 58 y 80 se ven distintos sin que nadie tenga que mapearlos a
// píxeles a mano — que es lo que hacía que ambos se vieran igual.
const TICKET_WIDTHS: TicketWidthOpt[] = [
    { value: 58, label: "58mm (térmica pequeña)" },
    { value: 80, label: "80mm (térmica estándar)" },
    { value: 112, label: "112mm (ancho)" },
];

function SelectInput({
    value,
    onChange,
    className,
    disabled,
    children,
}: React.SelectHTMLAttributes<HTMLSelectElement>) {
    return (
        <select
            value={value as any}
            onChange={onChange}
            disabled={disabled}
            className={[
                "w-full rounded-xl border border-border bg-surface px-3 py-2 text-sm text-fg outline-none",
                "placeholder:text-fg-subtle focus:border-border",
                disabled ? "opacity-60 cursor-not-allowed" : "",
                className ?? "",
            ].join(" ")}
        >
            {children}
        </select>
    );
}

function normalizeTicketWidthMm(v: any): 58 | 80 | 112 {
    const n = Number(v);
    if (n === 58) return 58;
    if (n === 112) return 112;
    return 80;
}

export function Ticket({
    inputTone,
    ivaTexto,
    ivaValido,
    onIvaChange,

    // ✅ NUEVO: mensaje final (sale del draft del negocio)
    footerMessage,
    onFooterMessageChange,

    ticket,
    setSetting,
    onSaveBusiness,
    savingBiz,
    canSaveBusiness,
}: {
    inputTone: string;
    /** Lo tecleado en el campo del IVA, tal cual, y si es un tipo válido (RI-78). */
    ivaTexto: string;
    ivaValido: boolean;
    onIvaChange: (raw: string) => void;

    footerMessage: string;
    onFooterMessageChange: (v: string) => void;

    ticket: any;
    setSetting: (k: any, v: any) => void;
    onSaveBusiness: () => Promise<void>;
    savingBiz: boolean;
    canSaveBusiness: boolean;
}) {
    const [previewOpen, setPreviewOpen] = useState(false);
    const toast = useToast();

    // Imprime el ticket previsualizado en la impresora seleccionada, respetando la
    // personalización actual (los mismos flags/ancho que usa la previsualización). Sale como
    // precuenta: un ticket de prueba no es una venta.
    const imprimirPreview = async () => {
        try {
            await printerImprimirPrecuenta(payloadDePrecuenta(previewItems));
            toast.success("Ticket", "Enviado a la impresora.");
        } catch (e) {
            toast.error("No se pudo imprimir el ticket", toAppError(e).message);
        }
    };

    // ✅ ancho guardado en Ticket_Settings (si aún no existe, cae a 80)
    const ticketWidthMm: 58 | 80 | 112 = normalizeTicketWidthMm(
        ticket?.paper_width_mm ?? ticket?.paper_width_mm ?? 80,
    );

    const previewItems = useMemo(
        () => [
            { id: "1", productoId: 101, nombre: "Café con leche", precio: deCentimos(170) },
            { id: "2", productoId: 101, nombre: "Café con leche", precio: deCentimos(170) },
            {
                id: "3",
                productoId: 205,
                nombre: "Tostada aceite y tomate",
                precio: deCentimos(240),
            },
            { id: "4", productoId: 330, nombre: "Agua 0,5L", precio: deCentimos(120) },
        ],
        [],
    );

    return (
        <div className="flex flex-col gap-4">
            <Panel id="ticket-fiscal" title="IVA">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <Field
                        label="IVA (%)"
                        hint="Se usa para calcular base e IVA del total"
                    >
                        <TextInput
                            inputMode="decimal"
                            value={ivaTexto}
                            onChange={(e) => onIvaChange(e.target.value)}
                            placeholder="10"
                            className={inputTone}
                            aria-invalid={!ivaValido}
                        />
                        {!ivaValido && (
                            <p role="alert" className="mt-1 text-xs text-danger">
                                {MSG_IVA}.
                            </p>
                        )}
                    </Field>

                    <div className="rounded-xl border border-border bg-surface-2 px-4 py-3">
                        <div className="text-xs font-semibold text-fg-muted">
                            Consejo
                        </div>
                        <div className="text-sm text-fg-muted mt-1">
                            Es el tipo de los productos que no tienen uno
                            propio. La base y el IVA de cada tipo salen
                            siempre en el ticket.
                        </div>
                    </div>
                </div>
            </Panel>

            {/* ✅ NUEVO: Formato */}
            <Panel title="Formato de impresión">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <Field
                        label="Ancho del ticket"
                        hint="Se guarda en Ticket Settings"
                    >
                        <SelectInput
                            value={String(ticketWidthMm)}
                            className={inputTone}
                            onChange={(e) => {
                                const mm = normalizeTicketWidthMm(
                                    e.target.value,
                                );
                                setSetting("paper_width_mm", mm);
                            }}
                        >
                            {TICKET_WIDTHS.map((o) => (
                                <option key={o.value} value={o.value}>
                                    {o.label}
                                </option>
                            ))}
                        </SelectInput>
                    </Field>

                    <Field
                        label="Resolución (DPI)"
                        hint="Según el modelo de impresora térmica"
                    >
                        <SelectInput
                            value={String(ticket?.paper_dpi ?? 203)}
                            className={inputTone}
                            onChange={(e) =>
                                setSetting("paper_dpi", Number(e.target.value))
                            }
                        >
                            <option value="203">203 dpi (estándar)</option>
                            <option value="300">300 dpi (alta)</option>
                        </SelectInput>
                    </Field>

                    <Field
                        label="Caracteres por línea"
                        hint="20–80 (se acota al ancho físico del papel)"
                    >
                        <TextInput
                            inputMode="numeric"
                            value={String(ticket?.chars_per_line ?? 42)}
                            onChange={(e) =>
                                setSetting("chars_per_line", Number(e.target.value))
                            }
                            placeholder="42"
                            className={inputTone}
                        />
                    </Field>

                    <Field
                        label="Escala de fuente"
                        hint="0.5–2.0 · ≥1.5 imprime el cuerpo a doble alto"
                    >
                        <TextInput
                            inputMode="decimal"
                            value={String(ticket?.font_scale ?? 1)}
                            onChange={(e) =>
                                setSetting("font_scale", Number(e.target.value))
                            }
                            placeholder="1.0"
                            className={inputTone}
                        />
                    </Field>
                </div>

                <div className="mt-4 grid grid-cols-2 md:grid-cols-4 gap-4">
                    {(
                        [
                            ["margin_top_mm", "Margen superior (mm)"],
                            ["margin_bottom_mm", "Margen inferior (mm)"],
                            ["margin_left_mm", "Margen izquierdo (mm)"],
                            ["margin_right_mm", "Margen derecho (mm)"],
                        ] as const
                    ).map(([key, label]) => (
                        <Field key={key} label={label}>
                            <TextInput
                                inputMode="decimal"
                                value={String(ticket?.[key] ?? 0)}
                                onChange={(e) =>
                                    setSetting(key, Number(e.target.value))
                                }
                                placeholder="0"
                                className={inputTone}
                            />
                        </Field>
                    ))}
                </div>
            </Panel>

            <Panel id="ticket-elementos" title="Elementos del ticket">
                <div className="grid grid-cols-1 gap-2">
                    <Checkbox
                        checked={ticket.show_logo}
                        onChange={(v) => setSetting("show_logo", v)}
                        label="Mostrar logo"
                    />
                    <Checkbox
                        checked={ticket.show_business_name}
                        onChange={(v) => setSetting("show_business_name", v)}
                        label="Mostrar nombre del negocio"
                    />
                    <Checkbox
                        checked={ticket.show_address}
                        onChange={(v) => setSetting("show_address", v)}
                        label="Mostrar dirección"
                    />
                    <Checkbox
                        checked={ticket.show_phone}
                        onChange={(v) => setSetting("show_phone", v)}
                        label="Mostrar teléfono"
                    />
                    <Checkbox
                        checked={ticket.show_footer_message}
                        onChange={(v) => setSetting("show_footer_message", v)}
                        label="Mostrar mensaje final"
                    />
                </div>
                <div className="mt-2 text-xs text-fg-muted">
                    El CIF, la razón social, la fecha, las líneas, la base y el IVA
                    y el total salen siempre: los exige la factura.
                </div>

                {/* El mensaje final sólo se edita si sale en el ticket. */}
                {ticket.show_footer_message ? (
                    <div className="mt-4 grid grid-cols-1 md:grid-cols-2 gap-4">
                        <Field
                            label="Mensaje final del ticket"
                            hint="Se guarda en Business Settings"
                        >
                            <TextInput
                                value={footerMessage}
                                onChange={(e) =>
                                    onFooterMessageChange(e.target.value)
                                }
                                placeholder="Ej: Gracias por su visita"
                                className={inputTone}
                            />
                        </Field>
                    </div>
                ) : null}

                <div className="mt-4 flex items-center justify-end gap-2">
                    <GhostButton
                        onClick={conAviso(onSaveBusiness)}
                        disabled={!canSaveBusiness}
                    >
                        {savingBiz ? "Guardando…" : "Guardar"}
                    </GhostButton>

                    <PrimaryButton onClick={() => setPreviewOpen(true)}>
                        Visualizar
                    </PrimaryButton>
                </div>
            </Panel>

            {/* ✅ NUEVO: selección de impresora de tickets */}
            <PrinterPanel />

            <TicketPreviewModal
                open={previewOpen}
                onClose={() => setPreviewOpen(false)}
                items={previewItems}
                onPrint={conAviso(imprimirPreview)}
            />
        </div>
    );
}
