// src/shared/ticket/TicketPaper.tsx
//
// "Papel" del ticket: el render visual del recibo (cabecera, líneas, base/IVA, total, footer)
// gobernado por la personalización (`useBusinessSettings` + `useTicketSettings`). Es la ÚNICA
// fuente de verdad del aspecto del ticket en el front: lo usan tanto la previsualización de
// Configuración (`PreviewModal`) como el modal de impresión (`PrintTicketModal`).
//
// Agrupa por `nombre + precio` (mismo criterio que `buildTicketPayload`), de modo que lo que se
// ve aquí coincide con lo que el backend imprime en ESC/POS.

import React, { useEffect, useMemo, useState } from "react";

import { useBusinessSettings } from "../stores/useBusinessSettings";
import { useTicketSettings } from "../stores/useTicketSettings";
import { resolveImageUrl } from "../lib/imageUrl";

export type TicketPaperItem = {
    nombre: string;
    precio: number;
};

function eur(n: number) {
    return new Intl.NumberFormat("es-ES", {
        style: "currency",
        currency: "EUR",
    }).format(n);
}

export default function TicketPaper({
    items,
    width = 384,
}: {
    items: TicketPaperItem[];
    width?: number;
}) {
    const {
        businessName,
        logoDataUrl,
        direccion,
        telefono,
        cif,
        mensajeFooter,
        ivaPercent,
    } = useBusinessSettings();

    const { settings } = useTicketSettings();

    const grouped = useMemo(() => {
        const map = new Map<string, { nombre: string; precio: number; qty: number }>();
        for (const it of items) {
            const key = `${it.nombre}__${it.precio}`;
            const cur = map.get(key);
            if (!cur) map.set(key, { nombre: it.nombre, precio: it.precio, qty: 1 });
            else cur.qty += 1;
        }
        return Array.from(map.values());
    }, [items]);

    const total = useMemo(
        () => grouped.reduce((acc, g) => acc + g.qty * g.precio, 0),
        [grouped],
    );

    const base = useMemo(() => {
        const divisor = 1 + (ivaPercent ?? 0) / 100;
        return divisor === 0 ? total : total / divisor;
    }, [total, ivaPercent]);

    const iva = useMemo(() => total - base, [total, base]);

    const fechaStr = useMemo(() => new Date().toLocaleString("es-ES"), []);

    const empty = grouped.length === 0;

    // El logo puede ser una ruta relativa (canal R2) o un data URL heredado; se resuelve a una URL
    // usable para el <img>. Ver `imageUrl.resolveImageUrl` (maneja ambos casos y el modo Handy).
    const [logoSrc, setLogoSrc] = useState<string>("");
    useEffect(() => {
        let alive = true;
        resolveImageUrl(logoDataUrl)
            .then((u) => alive && setLogoSrc(u))
            .catch(() => alive && setLogoSrc(""));
        return () => {
            alive = false;
        };
    }, [logoDataUrl]);

    const showHeaderLogo = settings.showLogo && !!logoDataUrl && !!logoSrc;
    const showHeaderName = settings.showBusinessName;
    const showAddress = settings.showAddress && !!direccion;
    const showPhone = settings.showPhone && !!telefono;
    const showCif = settings.showCif && !!cif;
    const showDateTime = settings.showDateTime;
    const showItems = settings.showLineItems;
    const showBaseIva = settings.showBaseAndIva;
    const showTotalLine = settings.showTotal;
    const showFooter = settings.showFooterMessage;

    return (
        <div
            className="bg-white text-black rounded-xl border border-black/10 shadow-sm overflow-hidden"
            style={{ width }}
        >
            <div style={{ fontFamily: "monospace", fontSize: 12, padding: 14 }}>
                <div style={{ textAlign: "center" }}>
                    {showHeaderLogo ? (
                        <div style={{ display: "flex", justifyContent: "center", marginBottom: 8 }}>
                            <img
                                src={logoSrc}
                                alt="logo"
                                style={{ maxHeight: 48, maxWidth: "70%", objectFit: "contain" }}
                            />
                        </div>
                    ) : null}

                    {showHeaderName ? (
                        <div style={{ fontWeight: 800, fontSize: 16, letterSpacing: 0.2 }}>
                            {businessName || "TPV"}
                        </div>
                    ) : null}

                    {showAddress ? <div style={{ marginTop: 2 }}>{direccion}</div> : null}
                    {showPhone ? <div>Tel: {telefono}</div> : null}
                    {showCif ? <div>CIF: {cif}</div> : null}
                </div>

                <div style={{ borderTop: "1px dashed #000", margin: "10px 0" }} />

                {showDateTime ? (
                    <>
                        <div style={{ display: "flex", justifyContent: "space-between" }}>
                            <span>{fechaStr}</span>
                            <span>VENTA</span>
                        </div>
                        <div style={{ borderTop: "1px dashed #000", margin: "10px 0" }} />
                    </>
                ) : (
                    <>
                        <div style={{ display: "flex", justifyContent: "flex-end" }}>
                            <span>VENTA</span>
                        </div>
                        <div style={{ borderTop: "1px dashed #000", margin: "10px 0" }} />
                    </>
                )}

                {!showItems ? (
                    <div style={{ textAlign: "center", opacity: 0.7, padding: "8px 0" }}>
                        (Líneas de productos ocultas)
                    </div>
                ) : empty ? (
                    <div style={{ textAlign: "center", opacity: 0.65, padding: "10px 0" }}>
                        No hay productos en el ticket.
                    </div>
                ) : (
                    <div>
                        {grouped.map((g, idx) => {
                            const lineTotal = g.qty * g.precio;
                            return (
                                <div key={idx} style={{ marginBottom: 8 }}>
                                    <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                                        <span style={{ maxWidth: "70%", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                            {g.nombre}
                                        </span>
                                        <span style={{ fontWeight: 700 }}>{eur(lineTotal)}</span>
                                    </div>
                                    <div style={{ display: "flex", justifyContent: "space-between", opacity: 0.8 }}>
                                        <span>
                                            {g.qty} x {eur(g.precio)}
                                        </span>
                                        <span />
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                )}

                <div style={{ borderTop: "1px dashed #000", margin: "10px 0" }} />

                {showBaseIva ? (
                    <>
                        <div style={{ display: "flex", justifyContent: "space-between" }}>
                            <span>BASE</span>
                            <span>{eur(base)}</span>
                        </div>
                        <div style={{ display: "flex", justifyContent: "space-between" }}>
                            <span>IVA ({ivaPercent}%)</span>
                            <span>{eur(iva)}</span>
                        </div>
                    </>
                ) : null}

                {showTotalLine ? (
                    <>
                        <div style={{ borderTop: "1px solid #000", margin: "10px 0" }} />
                        <div style={{ display: "flex", justifyContent: "space-between", fontWeight: 900, fontSize: 14 }}>
                            <span>TOTAL</span>
                            <span>{eur(total)}</span>
                        </div>
                    </>
                ) : null}

                {showFooter ? (
                    <>
                        <div style={{ borderTop: "1px dashed #000", margin: "12px 0" }} />
                        <div style={{ textAlign: "center", fontSize: 11, opacity: 0.9 }}>
                            {mensajeFooter || "¡Gracias por su visita!"}
                        </div>
                    </>
                ) : null}
            </div>
        </div>
    );
}
