// src/shared/ticket/PrintTicketModal.tsx
//
// Modal de impresión COMPARTIDO por mesas, venta rápida y la reimpresión de Cuentas. Saca dos
// papeles distintos, y la diferencia es la de RI-29:
//
//   - **El ticket de un cobro.** Lo compone Rust desde la base (`printer_ticket_de_pago`): las
//     líneas que cobró ese pago y su factura —número, fecha, QR, desglose y total—. Aquí no se elige
//     nada: un papel con número tiene que ser exactamente su factura.
//   - **La precuenta.** La compone la pantalla con las líneas de la comanda (todas, las pendientes o
//     las que se marquen) y sale sin número: no es un ticket de venta.
//
// Las dos se previsualizan con `TicketPaper`, que pinta el mismo payload que imprime Rust.

import React, { useEffect, useMemo, useState } from "react";

import type { FacturaDelCobro, PrintTicketPayload_Serialize as PrintTicketPayload } from "@tpv/contracts";
import { useToast } from "../toast";
import { useBusinessSettings } from "../stores/useBusinessSettings";
import { useTicketSettings } from "../stores/useTicketSettings";
import {
    payloadDePrecuenta,
    printerImprimirPago,
    printerImprimirPrecuenta,
    printerTicketDePago,
} from "../../features/configuracion/api/printerApis";
import TicketPaper from "./TicketPaper";
import { conAviso } from "../lib/conAviso";
import { toAppError } from "@tpv/client";
import type { Dinero } from "@tpv/contracts";
import { eur, por, sumar } from "../lib/dinero";

export type PrintableLine = {
    id: string;
    nombre: string;
    precio: Dinero;
    pagado: boolean;
    /**
     * Tipo de IVA con el que se vendió la línea. `null`/ausente = el general del negocio.
     * Viene congelado de la línea, no del producto.
     */
    iva_percent?: number | null;
    /** Unidades de la línea. Ausente = 1, que es como el POS manda la comanda. */
    cantidad?: number;
};

/** El cobro cuyo ticket se puede imprimir. */
export type CobroImprimible = {
    idPago: string;
    /** Reimpresión: sale marcado COPIA, con el mismo número. */
    esCopia?: boolean;
    /** Otra factura del mismo pago: la completa (`F3`) que canjeó su ticket. */
    numFactura?: string | null;
};

type Modo = "cobro" | "completo" | "pendiente" | "seleccion";

/** Cómo se llama cada factura de un cobro en el modal. */
function etiquetaFactura(f: FacturaDelCobro): string {
    switch (f.tipo_factura) {
        case "F2":
            return "Ticket";
        case "F1":
            return "Factura completa";
        case "F3":
            return f.importe < 0 ? "Factura de la devolución" : "Factura completa (canje)";
        default:
            return f.tipo_factura.startsWith("R") ? "Factura rectificativa" : f.tipo_factura;
    }
}

function cn(...classes: Array<string | false | undefined | null>) {
    return classes.filter(Boolean).join(" ");
}

export default function PrintTicketModal({
    open,
    onClose,
    items,
    titulo = "Imprimir ticket",
    cobro,
}: {
    open: boolean;
    onClose: () => void;
    /** Las líneas de la comanda, para la precuenta. Vacío = sólo se puede imprimir el cobro. */
    items: PrintableLine[];
    titulo?: string;
    /** El último cobro de esta comanda (o el que se reimprime). Sin él sólo hay precuenta. */
    cobro?: CobroImprimible | null;
}) {
    const toast = useToast();
    // Los dos stores se leen para que la precuenta se repinte si cambia la personalización.
    useBusinessSettings();
    useTicketSettings();

    const [modo, setModo] = useState<Modo>("completo");
    const [seleccion, setSeleccion] = useState<Set<string>>(new Set());
    const [printing, setPrinting] = useState(false);

    // Al abrir: el ticket del cobro si lo hay; si no, la precuenta de todo.
    useEffect(() => {
        if (!open) return;
        setModo(cobro ? "cobro" : "completo");
        setSeleccion(new Set(items.map((it) => it.id)));
    }, [open, items, cobro]);

    // El ticket del cobro, tal como lo compone Rust.
    const [ticketCobro, setTicketCobro] = useState<PrintTicketPayload | null>(null);
    const [errorCobro, setErrorCobro] = useState<string | null>(null);
    const idPago = cobro?.idPago ?? null;
    const esCopia = cobro?.esCopia ?? false;
    // Qué factura del cobro se imprime: `null` = la de su número (el ticket o la F1). Un cobro puede
    // tener más: la F3 que canjeó el ticket y, si se devolvió, la rectificativa y su F3 negativa.
    const [numFactura, setNumFactura] = useState<string | null>(null);
    const [facturas, setFacturas] = useState<FacturaDelCobro[]>([]);
    useEffect(() => {
        if (!open) return;
        setNumFactura(cobro?.numFactura ?? null);
        setFacturas([]);
    }, [open, cobro]);
    useEffect(() => {
        if (!open || !idPago) return;
        let vivo = true;
        setTicketCobro(null);
        setErrorCobro(null);
        printerTicketDePago(idPago, esCopia, numFactura)
            .then((p) => {
                if (!vivo) return;
                setTicketCobro(p);
                setFacturas(p.facturas_del_cobro);
            })
            .catch((e) => vivo && setErrorCobro(toAppError(e).message));
        return () => {
            vivo = false;
        };
    }, [open, idPago, esCopia, numFactura]);
    // La factura «propia» del cobro: la que se imprime sin pedir otra.
    const facturaDelPago = facturas.find((f) => f.tipo_factura === "F1" || f.tipo_factura === "F2");
    const facturaActiva = numFactura ?? facturaDelPago?.num_serie ?? null;

    const hayPendientes = useMemo(() => items.some((it) => !it.pagado), [items]);

    const lineasPrecuenta = useMemo(() => {
        if (modo === "pendiente") return items.filter((it) => !it.pagado);
        if (modo === "seleccion") return items.filter((it) => seleccion.has(it.id));
        return items;
    }, [modo, items, seleccion]);

    const esCobro = modo === "cobro";
    const payload: PrintTicketPayload | null = esCobro
        ? ticketCobro
        : payloadDePrecuenta(lineasPrecuenta);

    const totalPapel: Dinero | null = payload
        ? (payload.total ??
          sumar(...payload.items.map((l) => por(l.precio_unitario, l.cantidad))))
        : null;
    const unidades = payload ? payload.items.reduce((acc, l) => acc + l.cantidad, 0) : 0;
    const puedeImprimir = !!payload && payload.items.length > 0 && !printing;

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
        if (!payload || !puedeImprimir) return;
        setPrinting(true);
        try {
            if (esCobro && idPago) await printerImprimirPago(idPago, esCopia, numFactura);
            else await printerImprimirPrecuenta(payload);
            toast.success("Ticket", "Enviado a la impresora.");
            onClose();
        } catch (e) {
            toast.error("No se pudo imprimir el ticket", toAppError(e).message);
        } finally {
            setPrinting(false);
        }
    };

    if (!open) return null;

    const pendientesCount = items.filter((it) => !it.pagado).length;

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
                    {/* Columna izquierda: qué papel + sus líneas */}
                    <div className="w-[420px] shrink-0 flex flex-col min-h-0 border-r border-border">
                        <div className="p-4 border-b border-border">
                            <p className="text-sm font-semibold text-fg-muted mb-2">
                                ¿Qué quieres imprimir?
                            </p>
                            <div className="grid grid-cols-1 gap-2">
                                {/* Un botón por cada factura del cobro. Un cobro anterior a la
                                    numeración no tiene ninguna: entonces sólo está su ticket. */}
                                {cobro && facturas.length === 0 ? (
                                    <ModoButton
                                        active={esCobro}
                                        onClick={() => setModo("cobro")}
                                        label={esCopia ? "Copia del ticket" : "Ticket del cobro"}
                                        hint={ticketCobro?.numero_ticket ?? "…"}
                                    />
                                ) : null}
                                {cobro
                                    ? facturas.map((f) => (
                                          <ModoButton
                                              key={f.num_serie}
                                              active={esCobro && facturaActiva === f.num_serie}
                                              onClick={() => {
                                                  setModo("cobro");
                                                  setNumFactura(
                                                      f.num_serie === facturaDelPago?.num_serie
                                                          ? null
                                                          : f.num_serie,
                                                  );
                                              }}
                                              label={`${esCopia ? "Copia: " : ""}${etiquetaFactura(f)}`}
                                              hint={f.num_serie}
                                          />
                                      ))
                                    : null}
                                {items.length > 0 ? (
                                    <>
                                        <ModoButton
                                            active={modo === "completo"}
                                            onClick={() => setModo("completo")}
                                            label="Precuenta de todo"
                                            hint={`${items.length} producto${items.length === 1 ? "" : "s"}`}
                                        />
                                        <ModoButton
                                            active={modo === "pendiente"}
                                            onClick={() => setModo("pendiente")}
                                            label="Precuenta de lo pendiente"
                                            hint={
                                                hayPendientes
                                                    ? `${pendientesCount} producto${pendientesCount === 1 ? "" : "s"}`
                                                    : "Nada pendiente"
                                            }
                                            disabled={!hayPendientes}
                                        />
                                        <ModoButton
                                            active={modo === "seleccion"}
                                            onClick={() => setModo("seleccion")}
                                            label="Precuenta de una selección"
                                            hint="Marca las líneas en la lista"
                                        />
                                    </>
                                ) : null}
                            </div>
                        </div>

                        <div className="flex-1 min-h-0 overflow-y-auto p-3">
                            {esCobro ? (
                                // Las líneas del cobro, tal como van al papel. No se eligen: son las
                                // de su factura.
                                <div className="flex flex-col gap-2">
                                    {(ticketCobro?.items ?? []).map((l, i) => (
                                        <div
                                            key={i}
                                            className="flex items-center justify-between gap-3 rounded-xl border border-border bg-surface px-3 py-2.5"
                                        >
                                            <span className="truncate font-medium text-fg">
                                                {l.cantidad} x {l.nombre}
                                            </span>
                                            <span className="shrink-0 text-sm font-bold text-fg">
                                                {eur(por(l.precio_unitario, l.cantidad))}
                                            </span>
                                        </div>
                                    ))}
                                </div>
                            ) : items.length === 0 ? (
                                <div className="text-sm text-fg-muted p-4 text-center">
                                    El ticket está vacío.
                                </div>
                            ) : (
                                <div className="flex flex-col gap-2">
                                    {items.map((it) => {
                                        const incluido =
                                            modo === "completo"
                                                ? true
                                                : modo === "pendiente"
                                                    ? !it.pagado
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
                            {payload ? (
                                <TicketPaper payload={payload} />
                            ) : (
                                <div className="text-sm text-fg-muted p-4 text-center">
                                    {errorCobro ?? "Preparando el ticket…"}
                                </div>
                            )}
                        </div>

                        <div className="border-t border-border p-4 flex items-center justify-between gap-3">
                            <div className="text-sm text-fg-muted">
                                {unidades} producto{unidades === 1 ? "" : "s"}
                                {totalPapel !== null ? (
                                    <>
                                        {" · "}
                                        <span className="font-bold text-fg">{eur(totalPapel)}</span>
                                    </>
                                ) : null}
                            </div>
                            <button
                                type="button"
                                onClick={conAviso(imprimir)}
                                disabled={!puedeImprimir}
                                className={cn(
                                    "h-11 px-5 rounded-xl border border-accent bg-accent text-sm font-bold text-white shadow-sm transition",
                                    "hover:bg-accent-hover active:scale-[0.98]",
                                    !puedeImprimir &&
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
