// src/shared/ticket/DatosFiscalesModal.tsx
//
// Los datos del cliente para emitir una FACTURA COMPLETA (FISCAL-02).
//
// Se llega aquí por dos caminos y el texto de arriba lo dice, porque no son lo mismo:
//
//   · El cliente la pide («Factura con NIF»). Es voluntario y se puede cancelar.
//   · El importe pasa del límite de la factura simplificada —3.000 € con IVA en hostelería, art. 4.2
//     RD 1619/2012— y entonces **no hay alternativa**: por encima de esa cifra no cabe un ticket, así
//     que sin estos datos no se puede cobrar. Cancelar aquí vuelve al cobro sin hacer nada, que es
//     lo correcto: el cliente puede ir a buscar el NIF.
//
// El NIF se valida al escribir, con el dígito de control. No es un lujo: un NIF mal dictado **no**
// se rechaza al enviar — vuelve como «error admisible: NIF no censado» horas después, sin el cliente
// delante y con una subsanación que alguien tiene que disparar a mano.

import React, { useEffect, useMemo, useRef, useState } from "react";

import { ModalShell } from "../ui/ModalShell";
import { nifValido } from "./nif";

/** Lo que el formulario devuelve. Espejo de `DestinatarioInput` en Rust. */
export type DatosFiscales = {
    nombre_razon: string;
    nif: string;
    domicilio?: string | null;
};

export default function DatosFiscalesModal({
    open,
    onClose,
    onConfirmar,
    importe,
    limite,
    /** `true` cuando el importe OBLIGA a facturar (no es una elección del cliente). */
    obligatorio,
    guardando = false,
    error = null,
    /** Datos de partida, si el cobro es de un cliente con ficha. */
    inicial,
}: {
    open: boolean;
    onClose: () => void;
    onConfirmar: (d: DatosFiscales) => void | Promise<void>;
    importe: number;
    limite: number;
    obligatorio: boolean;
    guardando?: boolean;
    error?: string | null;
    inicial?: Partial<DatosFiscales> | null;
}) {
    const [nombre, setNombre] = useState("");
    const [nif, setNif] = useState("");
    const [domicilio, setDomicilio] = useState("");
    const [tocadoNif, setTocadoNif] = useState(false);
    const primerCampo = useRef<HTMLInputElement | null>(null);

    useEffect(() => {
        if (!open) return;
        setNombre(inicial?.nombre_razon ?? "");
        setNif(inicial?.nif ?? "");
        setDomicilio(inicial?.domicilio ?? "");
        setTocadoNif(false);
        // El foco al primer campo: esto se abre a mitad de un cobro y hay alguien esperando.
        const t = setTimeout(() => primerCampo.current?.focus(), 50);
        return () => clearTimeout(t);
    }, [open, inicial?.nombre_razon, inicial?.nif, inicial?.domicilio]);

    const nifOk = useMemo(() => nifValido(nif), [nif]);
    const puede = nombre.trim().length > 0 && nifOk && !guardando;

    const eur = (n: number) =>
        `${(Math.round(n * 100) / 100).toFixed(2).replace(".", ",")} €`;

    if (!open) return null;

    return (
        <ModalShell open={open} onClose={() => (guardando ? undefined : onClose())}>
            <div
                className="absolute inset-0 bg-black/40"
                onClick={() => (guardando ? null : onClose())}
            />
            <div className="relative w-[520px] max-w-[92vw] rounded-3xl border border-border bg-surface p-6 shadow-xl">
                <h3 className="text-lg font-semibold text-fg">
                    {obligatorio ? "Este cobro necesita factura" : "Factura con NIF"}
                </h3>
                <p className="mt-1 text-sm text-fg-muted">
                    {obligatorio ? (
                        <>
                            Son {eur(importe)}, y por encima de {eur(limite)} la ley no permite
                            entregar un ticket: hay que emitir una factura con los datos del cliente.{" "}
                            <strong>Sin ellos no se puede cobrar.</strong>
                        </>
                    ) : (
                        <>
                            Se emitirá una factura completa en lugar de un ticket. Pídele al cliente
                            el NIF y el nombre o la razón social.
                        </>
                    )}
                </p>

                <label className="mt-4 block">
                    <span className="text-sm font-semibold text-fg">Nombre o razón social</span>
                    <input
                        ref={primerCampo}
                        type="text"
                        value={nombre}
                        onChange={(e) => setNombre(e.target.value)}
                        placeholder="Empresa Cliente SL"
                        disabled={guardando}
                        className="mt-1 h-10 w-full rounded-xl border border-border bg-surface px-3 text-sm text-fg outline-none focus:border-primary"
                    />
                </label>

                <label className="mt-3 block">
                    <span className="text-sm font-semibold text-fg">NIF / CIF</span>
                    <input
                        type="text"
                        value={nif}
                        onChange={(e) => setNif(e.target.value.toUpperCase())}
                        onBlur={() => setTocadoNif(true)}
                        placeholder="B12345674"
                        disabled={guardando}
                        className={[
                            "mt-1 h-10 w-full rounded-xl border bg-surface px-3 text-sm text-fg outline-none",
                            tocadoNif && nif.trim() && !nifOk
                                ? "border-danger focus:border-danger"
                                : "border-border focus:border-primary",
                        ].join(" ")}
                    />
                    {tocadoNif && nif.trim() && !nifOk ? (
                        <span className="mt-1 block text-xs text-danger">
                            Ese NIF no es válido. Compruébalo con el cliente delante: si se manda
                            mal, la AEAT lo avisa horas después y ya no está para corregirlo.
                        </span>
                    ) : null}
                </label>

                <label className="mt-3 block">
                    <span className="text-sm font-semibold text-fg">
                        Domicilio <span className="font-normal text-fg-muted">(para el papel)</span>
                    </span>
                    <input
                        type="text"
                        value={domicilio}
                        onChange={(e) => setDomicilio(e.target.value)}
                        placeholder="Calle Mayor 1, 28013 Madrid"
                        disabled={guardando}
                        className="mt-1 h-10 w-full rounded-xl border border-border bg-surface px-3 text-sm text-fg outline-none focus:border-primary"
                    />
                    <span className="mt-1 block text-xs text-fg-muted">
                        Una factura lo lleva por ley. No se manda a Hacienda: sólo se imprime.
                    </span>
                </label>

                {error ? (
                    <div className="mt-3 rounded-2xl border border-danger/30 bg-danger-soft px-4 py-2 text-sm text-danger">
                        {error}
                    </div>
                ) : null}

                <div className="mt-6 flex items-center justify-end gap-2">
                    <button
                        type="button"
                        disabled={guardando}
                        onClick={onClose}
                        className={[
                            "h-10 rounded-xl border border-border bg-surface px-4 text-sm font-semibold text-fg shadow-sm",
                            "hover:bg-surface-2 active:scale-[0.97]",
                            guardando ? "cursor-not-allowed opacity-60" : "",
                        ].join(" ")}
                    >
                        {obligatorio ? "Volver al cobro" : "Cancelar"}
                    </button>
                    <button
                        type="button"
                        disabled={!puede}
                        onClick={() =>
                            void onConfirmar({
                                nombre_razon: nombre.trim(),
                                nif: nif.trim().toUpperCase(),
                                domicilio: domicilio.trim() || null,
                            })
                        }
                        className={[
                            "h-10 rounded-xl border border-primary bg-primary px-5 text-sm font-bold text-white shadow-sm",
                            "hover:opacity-90 active:scale-[0.97]",
                            !puede ? "cursor-not-allowed opacity-60" : "",
                        ].join(" ")}
                    >
                        {guardando ? "Cobrando…" : "Cobrar y facturar"}
                    </button>
                </div>
            </div>
        </ModalShell>
    );
}
