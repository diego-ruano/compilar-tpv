// src/shared/ticket/TicketPaper.tsx
//
// "Papel" del ticket: el render visual del recibo (cabecera, líneas, base/IVA, total, footer)
// gobernado por la personalización (`useBusinessSettings` + `useTicketSettings`). Es la ÚNICA
// fuente de verdad del aspecto del ticket en el front: lo usan tanto la previsualización de
// Configuración (`PreviewModal`) como el modal de impresión (`PrintTicketModal`).
//
// Agrupa por `nombre + precio` (mismo criterio que `buildTicketPayload`), de modo que lo que se
// ve aquí coincide con lo que el backend imprime en ESC/POS.
//
// El ANCHO no es decorativo: se mide en columnas de caracteres reales, las mismas que va a tener
// el papel, y se las pregunta a Rust (`printer_ticket_cols`) en vez de recalcularlas aquí. Dos
// copias de esa cuenta acabarían discrepando, y una previsualización que no coincide con el papel
// no sirve para nada. Gracias a eso, elegir 58 mm se VE distinto de 80 y los nombres largos se
// cortan donde de verdad se van a cortar.

import React, { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

import { useBusinessSettings } from "../stores/useBusinessSettings";
import { useTicketSettings } from "../stores/useTicketSettings";
import { resolveImageUrl } from "../lib/imageUrl";
import { agruparLineas, desgloseIva, eur, recortar as recortarA, totalDe } from "./ticketMath";
import { CERO, por } from "../lib/dinero";
import type { Dinero } from "@tpv/contracts";

export type TicketPaperItem = {
    nombre: string;
    precio: Dinero;
    /** Tipo de IVA de la línea; `null`/ausente = el general del negocio. */
    ivaPercent?: number | null;
    /** Unidades de la línea. Ausente = 1. */
    cantidad?: number;
};

/**
 * El bloque fiscal del ticket (FISCAL-01). `null` = este papel no lleva QR.
 *
 * La previa lo pinta como un **recuadro con la leyenda**, no como un código real: dibujar aquí un
 * QR de verdad obligaría a meter una librería de QR en el bundle para enseñar algo que el usuario
 * no va a escanear desde la pantalla — y el que importa, el del papel, lo genera Rust desde la URL
 * guardada. Lo que la previa tiene que reflejar fielmente es **dónde va y con qué textos**.
 */
export type TicketPaperFiscal = {
    qrUrl?: string | null;
    entornoPruebas?: boolean;
};

/** Columnas mientras Rust contesta: el valor por defecto de un papel de 80 mm. */
const COLS_POR_DEFECTO = 42;

export default function TicketPaper({
    items,
    fiscal,
}: {
    items: TicketPaperItem[];
    fiscal?: TicketPaperFiscal | null;
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

    // Columnas reales del papel con la configuración actual (ancho + márgenes). Se re-pregunta
    // cuando cambia algo de la geometría, no en cada repintado.
    const [cols, setCols] = useState<number>(COLS_POR_DEFECTO);
    useEffect(() => {
        let vivo = true;
        invoke<number>("printer_ticket_cols", {
            args: {
                paper_width_mm: settings.paperWidthMm,
                chars_per_line: settings.charsPerLine,
                margin_left_mm: settings.marginLeftMm,
                margin_right_mm: settings.marginRightMm,
            },
        })
            .then((n) => vivo && setCols(Number(n) || COLS_POR_DEFECTO))
            .catch(() => vivo && setCols(COLS_POR_DEFECTO));
        return () => {
            vivo = false;
        };
    }, [
        settings.paperWidthMm,
        settings.charsPerLine,
        settings.marginLeftMm,
        settings.marginRightMm,
    ]);

    /** Recorta como el papel: el nombre cede el espacio que ocupa su importe. */
    const recortar = (texto: string, importe: string) => recortarA(texto, importe, cols);

    // Las cuentas viven en `ticketMath` (sin React) para poder probarlas contra los mismos
    // números que saca Rust: la vista previa no vale de nada si no coincide con el papel.
    const grouped = useMemo(() => agruparLineas(items), [items]);
    const total = useMemo(() => totalDe(grouped), [grouped]);
    const tramosIva = useMemo(() => desgloseIva(grouped, ivaPercent), [grouped, ivaPercent]);

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

    const showFooterLogo = settings.showLogo && !!logoDataUrl && !!logoSrc;
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
        <div className="bg-white text-black rounded-xl border border-black/10 shadow-sm overflow-hidden inline-block">
            {/* `ch` = ancho de un carácter en esta fuente monoespaciada: el papel mide exactamente
                las columnas que tendrá el de verdad. */}
            <div style={{ fontFamily: "monospace", fontSize: 12, padding: 14, width: `${cols}ch` }}>
                {/* El QR tributario abre la factura (FISCAL-01, art. 21 de la Orden): «se situará
                    al principio de la factura, antes de que empiece el contenido de ésta generado
                    por el sistema informático de facturación», precedido siempre por «QR
                    tributario:» y seguido de la leyenda «VERI*FACTU».

                    Esto DEROGA la regla que ponía los datos del negocio los primeros. Sigue
                    cumpliéndose la razón que la motivaba —que lo primero que se lea sea de quién es
                    el ticket y cuánto se ha pagado—: el QR no compite por la atención, es una
                    etiqueta.

                    Espejo de `build_ticket` en `printing.rs`. Sin URL no se pinta nada: ni el hueco
                    ni la leyenda. Es el caso de la precuenta, que no es una factura. */}
                {fiscal?.qrUrl ? (
                    <>
                        <div style={{ textAlign: "center" }}>
                            <div>QR tributario:</div>
                            <div
                                aria-label="Código QR tributario"
                                title={fiscal.qrUrl}
                                style={{
                                    // 30-40 mm en el papel; aquí un cuadrado equivalente en la
                                    // previa. Se dibuja como marco y no como código real: lo que
                                    // hay que reflejar es la colocación, no el patrón de módulos.
                                    width: "16ch",
                                    height: "16ch",
                                    margin: "6px auto",
                                    border: "2px solid #000",
                                    display: "flex",
                                    alignItems: "center",
                                    justifyContent: "center",
                                    fontSize: 10,
                                    opacity: 0.75,
                                    padding: 4,
                                    textAlign: "center",
                                    overflow: "hidden",
                                }}
                            >
                                QR
                            </div>
                            <div style={{ fontWeight: 700 }}>VERI*FACTU</div>
                            {fiscal.entornoPruebas ? (
                                <div style={{ fontWeight: 700 }}>-- ENTORNO DE PRUEBAS --</div>
                            ) : null}
                        </div>
                        <div style={{ borderTop: "1px dashed #000", margin: "10px 0" }} />
                    </>
                ) : null}

                {/* Cabecera: sólo los datos del negocio, a la izquierda. El logo cierra el
                    ticket, abajo del todo (ver el final de este componente y de `build_ticket`). */}
                <div style={{ textAlign: "left" }}>
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
                            const lineTotal = por(g.precio, g.qty);
                            return (
                                <div key={idx} style={{ marginBottom: 8 }}>
                                    <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                                        <span style={{ whiteSpace: "nowrap" }}>
                                            {recortar(g.nombre, eur(lineTotal))}
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
                        {tramosIva.length <= 1 ? (
                            // Un solo tipo (el caso normal): como toda la vida, sin convertir el
                            // ticket en una tabla por algo que no aporta nada.
                            <>
                                <div style={{ display: "flex", justifyContent: "space-between" }}>
                                    <span>BASE</span>
                                    <span>{eur(tramosIva[0]?.base ?? 0)}</span>
                                </div>
                                <div style={{ display: "flex", justifyContent: "space-between" }}>
                                    <span>
                                        IVA ({tramosIva[0]?.tipo ?? ivaPercent}%)
                                    </span>
                                    <span>{eur(tramosIva[0]?.iva ?? CERO)}</span>
                                </div>
                            </>
                        ) : (
                            // Varios tramos: cada uno con su base y su IVA.
                            tramosIva.map((t) => (
                                <React.Fragment key={t.tipo}>
                                    <div style={{ display: "flex", justifyContent: "space-between" }}>
                                        <span>BASE ({t.tipo}%)</span>
                                        <span>{eur(t.base)}</span>
                                    </div>
                                    <div style={{ display: "flex", justifyContent: "space-between" }}>
                                        <span>IVA ({t.tipo}%)</span>
                                        <span>{eur(t.iva)}</span>
                                    </div>
                                </React.Fragment>
                            ))
                        )}
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

                {showFooterLogo ? (
                    // El logo impreso ocupa el ancho del cabezal menos los márgenes (ver
                    // `ancho_logo_dots` en printing.rs), no una fracción del bloque de texto:
                    // enseñarlo al 70 % hacía creer que sale más pequeño de lo que sale.
                    <div style={{ display: "flex", justifyContent: "center", marginTop: 12 }}>
                        <img
                            src={logoSrc}
                            alt="logo"
                            style={{ maxHeight: 48, maxWidth: "100%", objectFit: "contain" }}
                        />
                    </div>
                ) : null}
            </div>
        </div>
    );
}
