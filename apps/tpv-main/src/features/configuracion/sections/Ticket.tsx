// src/features/configuracion/sections/Ticket.tsx
import React, { useMemo, useState } from "react";
import TicketPreviewModal from "../../../shared/ticket/PreviewModal";
import { useToast } from "../../../shared/toast";
import { Panel } from "../ui/Panel";
import { Field } from "../ui/Field";
import { TextArea, TextInput } from "../ui/Inputs";
import { Checkbox } from "../ui/Toggles";
import { GhostButton, PrimaryButton } from "../ui/Buttons";
import { PrinterPanel } from "./PrinterPanel";
import { buildTicketPayload, printerPrintTicket } from "../api/printerApis";

// ✅ PreviewModal solo acepta 384 | 576
type PreviewWidth = 384 | 576;

type TicketWidthOpt = {
    value: 58 | 80 | 112; // mm (lo que guardas en DB)
    label: string;
    previewWidthPx: PreviewWidth; // ✅ tipado correcto para PreviewModal
};

// ⚠️ Puedes cambiar el mapeo si quieres, pero que previewWidthPx sea 384 o 576
const TICKET_WIDTHS: TicketWidthOpt[] = [
    { value: 58, label: "58mm (térmica pequeña)", previewWidthPx: 384 },
    { value: 80, label: "80mm (térmica estándar)", previewWidthPx: 384 },
    { value: 112, label: "112mm (ancho)", previewWidthPx: 576 },
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
    draftIvaPercent,
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
    draftIvaPercent: number;
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
    // personalización actual (los mismos flags/ancho que usa la previsualización).
    const imprimirPreview = async () => {
        try {
            await printerPrintTicket(buildTicketPayload(previewItems));
            toast.success("Ticket", "Enviado a la impresora.");
        } catch (e) {
            console.error("printerPrintTicket error:", e);
            toast.error(
                "Ticket",
                typeof e === "string" ? e : "No se pudo imprimir el ticket.",
            );
        }
    };

    // ✅ ancho guardado en Ticket_Settings (si aún no existe, cae a 80)
    const ticketWidthMm: 58 | 80 | 112 = normalizeTicketWidthMm(
        ticket?.paperWidthMm ?? ticket?.paper_width_mm ?? 80,
    );

    const widthOpt =
        TICKET_WIDTHS.find((x) => x.value === ticketWidthMm) ??
        TICKET_WIDTHS.find((x) => x.value === 80)!;

    const previewItems = useMemo(
        () => [
            { id: "1", productoId: 101, nombre: "Café con leche", precio: 1.7 },
            { id: "2", productoId: 101, nombre: "Café con leche", precio: 1.7 },
            {
                id: "3",
                productoId: 205,
                nombre: "Tostada aceite y tomate",
                precio: 2.4,
            },
            { id: "4", productoId: 330, nombre: "Agua 0,5L", precio: 1.2 },
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
                            value={String(draftIvaPercent)}
                            onChange={(e) => onIvaChange(e.target.value)}
                            placeholder="10"
                            className={inputTone}
                        />
                    </Field>

                    <div className="rounded-xl border border-border bg-surface-2 px-4 py-3">
                        <div className="text-xs font-semibold text-fg-muted">
                            Consejo
                        </div>
                        <div className="text-sm text-fg-muted mt-1">
                            Si desactivas “Mostrar base e IVA”, el IVA no se
                            imprime pero sigue siendo el configurado.
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
                                setSetting("paperWidthMm", mm);
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
                            value={String(ticket?.paperDpi ?? 203)}
                            className={inputTone}
                            onChange={(e) =>
                                setSetting("paperDpi", Number(e.target.value))
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
                            value={String(ticket?.charsPerLine ?? 42)}
                            onChange={(e) =>
                                setSetting("charsPerLine", Number(e.target.value))
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
                            value={String(ticket?.fontScale ?? 1)}
                            onChange={(e) =>
                                setSetting("fontScale", Number(e.target.value))
                            }
                            placeholder="1.0"
                            className={inputTone}
                        />
                    </Field>
                </div>

                <div className="mt-4 grid grid-cols-2 md:grid-cols-4 gap-4">
                    {(
                        [
                            ["marginTopMm", "Margen superior (mm)"],
                            ["marginBottomMm", "Margen inferior (mm)"],
                            ["marginLeftMm", "Margen izquierdo (mm)"],
                            ["marginRightMm", "Margen derecho (mm)"],
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
                        checked={ticket.showLogo}
                        onChange={(v) => setSetting("showLogo", v)}
                        label="Mostrar logo"
                    />
                    <Checkbox
                        checked={ticket.showBusinessName}
                        onChange={(v) => setSetting("showBusinessName", v)}
                        label="Mostrar nombre del negocio"
                    />
                    <Checkbox
                        checked={ticket.showAddress}
                        onChange={(v) => setSetting("showAddress", v)}
                        label="Mostrar dirección"
                    />
                    <Checkbox
                        checked={ticket.showPhone}
                        onChange={(v) => setSetting("showPhone", v)}
                        label="Mostrar teléfono"
                    />
                    <Checkbox
                        checked={ticket.showCif}
                        onChange={(v) => setSetting("showCif", v)}
                        label="Mostrar CIF"
                    />
                    <Checkbox
                        checked={ticket.showDateTime}
                        onChange={(v) => setSetting("showDateTime", v)}
                        label="Mostrar fecha/hora"
                    />
                    <Checkbox
                        checked={ticket.showLineItems}
                        onChange={(v) => setSetting("showLineItems", v)}
                        label="Mostrar líneas de productos"
                    />
                    <Checkbox
                        checked={ticket.showBaseAndIva}
                        onChange={(v) => setSetting("showBaseAndIva", v)}
                        label="Mostrar base e IVA"
                    />
                    <Checkbox
                        checked={ticket.showTotal}
                        onChange={(v) => setSetting("showTotal", v)}
                        label="Mostrar total"
                    />
                    <Checkbox
                        checked={ticket.showFooterMessage}
                        onChange={(v) => setSetting("showFooterMessage", v)}
                        label="Mostrar mensaje final"
                    />
                </div>

                {/* ✅ NUEVO: el mensaje final se edita aquí */}
                <div className="mt-4">
                    <Field
                        label="Mensaje final del ticket"
                        hint="Se guarda en Business Settings"
                    >
                        <TextArea
                            value={footerMessage}
                            onChange={(e) =>
                                onFooterMessageChange(e.target.value)
                            }
                            placeholder="Ej: Gracias por su visita"
                            className={inputTone}
                            disabled={!ticket.showFooterMessage}
                        />
                    </Field>
                    {!ticket.showFooterMessage ? (
                        <div className="mt-2 text-xs text-fg-muted">
                            Activa “Mostrar mensaje final” para editarlo.
                        </div>
                    ) : null}
                </div>

                <div className="mt-4 flex items-center justify-end gap-2">
                    <GhostButton
                        onClick={onSaveBusiness}
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
                width={widthOpt.previewWidthPx} // ✅ 384 | 576
                onPrint={imprimirPreview}
            />
        </div>
    );
}
