// src/shared/ticket/PrintTicketModal.tsx
//
// Modal de impresión de tickets COMPARTIDO por mesas y venta rápida. Permite:
//   - Elegir QUÉ se imprime: todo el ticket, sólo lo ya cobrado, o una selección manual.
//   - Previsualizar el ticket (mismo render que la config, `TicketPaper`) y verlo cambiar
//     dinámicamente según lo seleccionado.
//   - Imprimir respetando la personalización (vía `buildTicketPayload` + `printerPrintTicket`).
//
// Recibe las líneas del ticket (una por unidad) con la forma mínima `PrintableLine`; ambos
// dominios (mesas / venta rápida) cumplen esa forma, por eso el componente es reutilizable.

import React, { useEffect, useMemo, useState } from "react";

import { useToast } from "../toast";
import { useTicketSettings } from "../stores/useTicketSettings";
import {
    buildTicketPayload,
    printerPrintTicket,
    type DatosDelTicket,
} from "../../features/configuracion/api/printerApis";
import TicketPaper from "./TicketPaper";

export type PrintableLine = {
    id: string;
    nombre: string;
    precio: number;
    pagado: boolean;
    /**
     * Tipo de IVA con el que se vendió la línea. `null`/ausente = el general del negocio.
     * Viene congelado de la línea, no del producto: si el tipo cambia, un ticket reimpreso tiene
     * que seguir enseñando el del día de la venta.
     */
    ivaPercent?: number | null;
};

type Modo = "completo" | "cobrado" | "seleccion";

function cn(...classes: Array<string | false | undefined | null>) {
    return classes.filter(Boolean).join(" ");
}

function eur(n: number) {
    return new Intl.NumberFormat("es-ES", {
        style: "currency",
        currency: "EUR",
    }).format(n);
}

export default function PrintTicketModal({
    open,
    onClose,
    items,
    titulo = "Imprimir ticket",
    datos,
}: {
    open: boolean;
    onClose: () => void;
    items: PrintableLine[];
    titulo?: string;
    /**
     * Qué papel es este. Sin `numeroTicket` sale como PRECUENTA: lo que se le enseña al cliente
     * antes de cobrar, que no es un ticket de venta y no puede parecerlo.
     */
    datos?: DatosDelTicket;
}) {
    const toast = useToast();
    const { settings } = useTicketSettings();

    const [modo, setModo] = useState<Modo>("completo");
    const [seleccion, setSeleccion] = useState<Set<string>>(new Set());
    const [printing, setPrinting] = useState(false);

    const hayCobrados = useMemo(() => items.some((it) => it.pagado), [items]);

    // Al abrir, resetea: modo "completo" y la selección manual parte de todo el ticket.
    useEffect(() => {
        if (!open) return;
        setModo("completo");
        setSeleccion(new Set(items.map((it) => it.id)));
    }, [open, items]);

    const effectiveItems = useMemo(() => {
        if (modo === "completo") return items;
        if (modo === "cobrado") return items.filter((it) => it.pagado);
        return items.filter((it) => seleccion.has(it.id));
    }, [modo, items, seleccion]);

    const totalEfectivo = useMemo(
        () => effectiveItems.reduce((acc, it) => acc + it.precio, 0),
        [effectiveItems],
    );

    const toggleLinea = (id: string) => {
        setModo("seleccion");
        setSeleccion((prev) => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    };

    const imprimir = async () => {
        if (effectiveItems.length === 0) return;
        setPrinting(true);
        try {
            await printerPrintTicket(buildTicketPayload(effectiveItems, undefined, datos));
            toast.success("Ticket", "Enviado a la impresora.");
            onClose();
        } catch (e) {
            console.error("printerPrintTicket error:", e);
            toast.error(
                "Ticket",
                typeof e === "string" ? e : "No se pudo imprimir el ticket.",
            );
        } finally {
            setPrinting(false);
        }
    };

    if (!open) return null;

    const cobradosCount = items.filter((it) => it.pagado).length;

    return (
        <div className="fixed inset-0 z-[10000] bg-black/50 p-3 grid place-items-center">
            <div className="w-full max-w-[1000px] h-[88vh] rounded-2xl border border-border bg-surface shadow-xl overflow-hidden flex flex-col">
                {/* Cabecera */}
                <div className="flex items-center justify-between gap-3 p-4 border-b border-border">
                    <div className="text-lg font-extrabold text-fg">{titulo}</div>
                    <button
                        type="button"
                        onClick={onClose}
                        className="px-3 py-2 rounded-xl border border-border bg-surface hover:bg-surface-2 text-sm font-semibold text-fg"
                    >
                        Cerrar
                    </button>
                </div>

                <div className="flex flex-1 min-h-0">
                    {/* Columna izquierda: controles + lista */}
                    <div className="w-[420px] shrink-0 flex flex-col min-h-0 border-r border-border">
                        <div className="p-4 border-b border-border">
                            <p className="text-sm font-semibold text-fg-muted mb-2">
                                ¿Qué quieres imprimir?
                            </p>
                            <div className="grid grid-cols-1 gap-2">
                                <ModoButton
                                    active={modo === "completo"}
                                    onClick={() => setModo("completo")}
                                    label="Todo el ticket"
                                    hint={`${items.length} producto${items.length === 1 ? "" : "s"}`}
                                />
                                <ModoButton
                                    active={modo === "cobrado"}
                                    onClick={() => setModo("cobrado")}
                                    label="Solo lo cobrado"
                                    hint={
                                        hayCobrados
                                            ? `${cobradosCount} producto${cobradosCount === 1 ? "" : "s"}`
                                            : "Nada cobrado aún"
                                    }
                                    disabled={!hayCobrados}
                                />
                                <ModoButton
                                    active={modo === "seleccion"}
                                    onClick={() => setModo("seleccion")}
                                    label="Elegir productos"
                                    hint="Marca las líneas en la lista"
                                />
                            </div>
                        </div>

                        <div className="flex-1 min-h-0 overflow-y-auto p-3">
                            {items.length === 0 ? (
                                <div className="text-sm text-fg-muted p-4 text-center">
                                    El ticket está vacío.
                                </div>
                            ) : (
                                <div className="flex flex-col gap-2">
                                    {items.map((it) => {
                                        const incluido =
                                            modo === "completo"
                                                ? true
                                                : modo === "cobrado"
                                                    ? it.pagado
                                                    : seleccion.has(it.id);
                                        return (
                                            <button
                                                key={it.id}
                                                type="button"
                                                onClick={() => toggleLinea(it.id)}
                                                className={cn(
                                                    "flex items-center justify-between gap-3 rounded-xl border px-3 py-2.5 text-left transition",
                                                    incluido
                                                        ? "border-accent bg-accent/10"
                                                        : "border-border bg-surface hover:bg-surface-2 opacity-60",
                                                )}
                                            >
                                                <div className="flex items-center gap-3 min-w-0">
                                                    <span
                                                        className={cn(
                                                            "grid h-5 w-5 shrink-0 place-items-center rounded-md border text-xs font-bold",
                                                            incluido
                                                                ? "border-accent bg-accent text-white"
                                                                : "border-border",
                                                        )}
                                                        aria-hidden
                                                    >
                                                        {incluido ? "✓" : ""}
                                                    </span>
                                                    <span className="truncate font-medium text-fg">
                                                        {it.nombre}
                                                    </span>
                                                    {it.pagado ? (
                                                        <span className="shrink-0 rounded-full border border-border bg-surface-2 px-2 py-0.5 text-[11px] font-semibold text-fg-muted">
                                                            Cobrado
                                                        </span>
                                                    ) : null}
                                                </div>
                                                <span className="shrink-0 text-sm font-bold text-fg">
                                                    {eur(it.precio)}
                                                </span>
                                            </button>
                                        );
                                    })}
                                </div>
                            )}
                        </div>
                    </div>

                    {/* Columna derecha: previsualización + acción */}
                    <div className="flex-1 min-h-0 flex flex-col">
                        <div className="flex-1 min-h-0 overflow-y-auto bg-surface-2 p-5 flex justify-center">
                            <TicketPaper items={effectiveItems} />
                        </div>

                        <div className="border-t border-border p-4 flex items-center justify-between gap-3">
                            <div className="text-sm text-fg-muted">
                                {effectiveItems.length} producto
                                {effectiveItems.length === 1 ? "" : "s"} ·{" "}
                                <span className="font-bold text-fg">
                                    {eur(totalEfectivo)}
                                </span>
                            </div>
                            <button
                                type="button"
                                onClick={imprimir}
                                disabled={effectiveItems.length === 0 || printing}
                                className={cn(
                                    "h-11 px-5 rounded-xl border border-accent bg-accent text-sm font-bold text-white shadow-sm transition",
                                    "hover:bg-accent-hover active:scale-[0.98]",
                                    (effectiveItems.length === 0 || printing) &&
                                        "opacity-50 cursor-not-allowed hover:bg-accent active:scale-100",
                                )}
                            >
                                {printing ? "Imprimiendo…" : "Imprimir"}
                            </button>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}

function ModoButton({
    active,
    onClick,
    label,
    hint,
    disabled,
}: {
    active: boolean;
    onClick: () => void;
    label: string;
    hint: string;
    disabled?: boolean;
}) {
    return (
        <button
            type="button"
            onClick={onClick}
            disabled={disabled}
            className={cn(
                "flex items-center justify-between gap-3 rounded-xl border px-4 py-3 text-left transition",
                active
                    ? "border-accent bg-accent/10"
                    : "border-border bg-surface hover:bg-surface-2",
                disabled && "opacity-50 cursor-not-allowed hover:bg-surface",
            )}
        >
            <span className="font-semibold text-fg">{label}</span>
            <span className="text-xs text-fg-muted">{hint}</span>
        </button>
    );
}
