// src/features/configuracion/sections/Ticket.tsx
import React, { useMemo, useState } from "react";
import TicketPreviewModal from "../../../shared/ticket/PreviewModal";
import { Panel } from "../ui/Panel";
import { Field } from "../ui/Field";
import { TextArea, TextInput } from "../ui/Inputs";
import { Checkbox } from "../ui/Toggles";
import { GhostButton, PrimaryButton } from "../ui/Buttons";

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
                "w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 outline-none",
                "placeholder:text-slate-400 focus:border-slate-300",
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

                    <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3">
                        <div className="text-xs font-semibold text-slate-600">
                            Consejo
                        </div>
                        <div className="text-sm text-slate-700 mt-1">
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

                    <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3">
                        <div className="text-xs font-semibold text-slate-600">
                            Info
                        </div>
                        <div className="text-sm text-slate-700 mt-1">
                            Esto te sirve luego para decidir el layout/estilo de
                            impresión (58mm vs 80mm, etc.).
                        </div>
                    </div>
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
                        <div className="mt-2 text-xs text-slate-500">
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

            <TicketPreviewModal
                open={previewOpen}
                onClose={() => setPreviewOpen(false)}
                items={previewItems}
                width={widthOpt.previewWidthPx} // ✅ 384 | 576
            />
        </div>
    );
}
