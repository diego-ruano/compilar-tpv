import { commands, toAppError } from "@tpv/client";
// src/features/configuracion/sections/PrinterPanel.tsx
//
// Panel de selección de impresora de tickets. Lista las impresoras del sistema (locales y de
// red/WiFi), permite elegir una (se persiste en el dispositivo) y lanzar una impresión de prueba.

import { useCallback, useEffect, useState } from "react";

import { useToast } from "../../../shared/toast";
import { cn } from "../utils";
import { Panel } from "../ui/Panel";
import { GhostButton, PrimaryButton } from "../ui/Buttons";
import { printerGetSelected, printerOpenDrawer, printerPrintTest, printerSetSelected, type PrinterInfo } from "../api/printerApis";
import { conAviso } from "../../../shared/lib/conAviso";

export function PrinterPanel() {
    const toast = useToast();

    const [printers, setPrinters] = useState<PrinterInfo[]>([]);
    const [selected, setSelected] = useState<string | null>(null);
    const [loading, setLoading] = useState(false);
    const [testing, setTesting] = useState(false);

    const cargar = useCallback(async () => {
        setLoading(true);
        try {
            const [list, sel] = await Promise.all([
                commands.printerList(),
                printerGetSelected(),
            ]);
            setPrinters(list);
            setSelected(sel);
        } catch (e) {
            toast.error("No se pudieron listar las impresoras", toAppError(e).message);
        } finally {
            setLoading(false);
        }
    }, [toast]);

    useEffect(() => {
        void cargar();
    }, [cargar]);

    const elegir = useCallback(
        async (name: string) => {
            const next = selected === name ? "" : name; // re-pulsar deselecciona
            setSelected(next || null);
            try {
                await printerSetSelected(next);
            } catch (e) {
                toast.error("No se pudo guardar la impresora", toAppError(e).message);
                void cargar();
            }
        },
        [selected, toast, cargar],
    );

    // Quién lo abre: la apertura manual se anota a su nombre.

    /**
     * Abre el cajón sin imprimir. Sirve para comprobar que el cable RJ11 está bien puesto — que es
     * el fallo típico al montarlo — y en el día a día para dar cambio.
     */
    const abrirCajon = useCallback(async () => {
        try {
            await printerOpenDrawer();
            toast.success("Cajón", "Orden de apertura enviada.");
        } catch (e) {
            toast.error("No se pudo abrir el cajón", toAppError(e).message);
        }
    }, [toast]);

    const imprimirPrueba = useCallback(async () => {
        if (!selected) return;
        setTesting(true);
        try {
            await printerPrintTest(selected);
            toast.success("Impresora", "Ticket de prueba enviado.");
        } catch (e) {
            toast.error("No se pudo imprimir la prueba", toAppError(e).message);
        } finally {
            setTesting(false);
        }
    }, [selected, toast]);

    return (
        <Panel
            id="ticket-impresora"
            title="Impresora de tickets"
            subtitle="Elige con qué impresora se imprimirán los tickets en este dispositivo."
            right={
                <GhostButton onClick={conAviso(cargar)} disabled={loading}>
                    {loading ? "Buscando…" : "Refrescar"}
                </GhostButton>
            }
        >
            {loading && printers.length === 0 ? (
                <div className="text-sm text-fg-muted">
                    Buscando impresoras…
                </div>
            ) : printers.length === 0 ? (
                <div className="rounded-xl border border-border bg-surface-2 px-4 py-3 text-sm text-fg-muted">
                    No se han encontrado impresoras. Conecta una (USB o red/WiFi)
                    y pulsa <span className="font-semibold">Refrescar</span>.
                </div>
            ) : (
                <div className="grid grid-cols-1 gap-2">
                    {printers.map((p) => {
                        const isSelected = selected === p.name;
                        return (
                            <button
                                key={p.name}
                                type="button"
                                onClick={conAviso(() => elegir(p.name))}
                                className={cn(
                                    "flex items-center justify-between gap-3 rounded-xl border px-4 py-3 text-left transition",
                                    isSelected
                                        ? "border-accent bg-accent/10"
                                        : "border-border bg-surface hover:bg-surface-2",
                                )}
                            >
                                <div className="flex items-center gap-3 min-w-0">
                                    <span
                                        className={cn(
                                            "grid h-5 w-5 shrink-0 place-items-center rounded-full border",
                                            isSelected
                                                ? "border-accent"
                                                : "border-border",
                                        )}
                                        aria-hidden
                                    >
                                        {isSelected ? (
                                            <span className="h-2.5 w-2.5 rounded-full bg-accent" />
                                        ) : null}
                                    </span>
                                    <span className="truncate font-medium text-fg">
                                        {p.name}
                                    </span>
                                    {p.is_default ? (
                                        <span className="shrink-0 rounded-full border border-border bg-surface-2 px-2 py-0.5 text-xs font-semibold text-fg-muted">
                                            Predeterminada
                                        </span>
                                    ) : null}
                                </div>
                                {isSelected ? (
                                    <span className="shrink-0 text-xs font-bold text-accent">
                                        Seleccionada
                                    </span>
                                ) : null}
                            </button>
                        );
                    })}
                </div>
            )}

            <div className="mt-4 flex items-center justify-between gap-2">
                <div className="text-xs text-fg-muted">
                    {selected
                        ? `Imprimirá en: ${selected}`
                        : "Sin impresora seleccionada."}
                </div>
                <div className="flex gap-2">
                    <GhostButton onClick={conAviso(abrirCajon)} disabled={!selected}>
                        Abrir cajón
                    </GhostButton>
                    <PrimaryButton
                        onClick={conAviso(imprimirPrueba)}
                        disabled={!selected || testing}
                    >
                        {testing ? "Imprimiendo…" : "Imprimir prueba"}
                    </PrimaryButton>
                </div>
            </div>
        </Panel>
    );
}
