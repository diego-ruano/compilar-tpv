import { commands } from "@tpv/client";
// src/shared/ticket/TicketPaper.tsx
//
// "Papel" del ticket: el render visual del recibo, espejo de `build_ticket` en `printing.rs`.
//
// Pinta un `PrintTicketPayload`, el MISMO que recibe el generador ESC/POS (RI-29). El de un cobro
// lo compone Rust desde la base (`printer_ticket_de_pago`) y el de una precuenta lo compone la
// pantalla (`payloadDePrecuenta`); este componente no lee los stores ni decide nada: lo que se ve
// aquí es lo que va a salir.
//
// El ANCHO no es decorativo: se mide en columnas de caracteres reales, las mismas que va a tener
// el papel, y se las pregunta a Rust (`printer_ticket_cols`) en vez de recalcularlas aquí. Dos
// copias de esa cuenta acabarían discrepando, y una previsualización que no coincide con el papel
// no sirve para nada. Gracias a eso, elegir 58 mm se VE distinto de 80 y los nombres largos se
// cortan donde de verdad se van a cortar.

import React, { useEffect, useMemo, useState } from "react";


import type { PrintTicketPayload_Serialize as PrintTicketPayload } from "@tpv/contracts";
import { resolveImageUrl } from "../lib/imageUrl";
import {
    desgloseIva,
    eur,
    recortar as recortarA,
    totalDe,
    type LineaAgrupada,
} from "./ticketMath";
import { CERO, por } from "../lib/dinero";

/** Columnas mientras Rust contesta: el valor por defecto de un papel de 80 mm. */
const COLS_POR_DEFECTO = 42;

const Separador = ({ solido }: { solido?: boolean }) => (
    <div style={{ borderTop: `1px ${solido ? "solid" : "dashed"} #000`, margin: "10px 0" }} />
);

const Centrado = ({ children, negrita }: { children: React.ReactNode; negrita?: boolean }) => (
    <div style={{ textAlign: "center", fontWeight: negrita ? 700 : undefined }}>{children}</div>
);

export default function TicketPaper({ payload }: { payload: PrintTicketPayload }) {
    const p = payload;

    // Columnas reales del papel con la configuración del payload (ancho + márgenes). Se re-pregunta
    // cuando cambia algo de la geometría, no en cada repintado.
    const [cols, setCols] = useState<number>(COLS_POR_DEFECTO);
    useEffect(() => {
        let vivo = true;
        commands.printerTicketCols({
                paper_width_mm: p.paper_width_mm,
                chars_per_line: p.chars_per_line,
                margin_left_mm: p.margin_left_mm,
                margin_right_mm: p.margin_right_mm,
            })
            .then((n) => vivo && setCols(Number(n) || COLS_POR_DEFECTO))
            .catch(() => vivo && setCols(COLS_POR_DEFECTO));
        return () => {
            vivo = false;
        };
    }, [p.paper_width_mm, p.chars_per_line, p.margin_left_mm, p.margin_right_mm]);

    /** Recorta como el papel: el nombre cede el espacio que ocupa su importe. */
    const recortar = (texto: string, importe: string) => recortarA(texto, importe, cols);

    // Las líneas ya llegan agrupadas. El desglose y el total de una factura vienen declarados; los
    // de la precuenta se calculan con `ticketMath`, la misma cuenta que `tpv_domain::ticket`.
    const lineas: LineaAgrupada[] = useMemo(
        () =>
            p.items.map((l) => ({
                nombre: l.nombre,
                precio: l.precio_unitario,
                qty: l.cantidad,
                iva_percent: l.iva_percent ?? null,
            })),
        [p.items],
    );
    const total = p.total ?? totalDe(lineas);
    const tramos = useMemo(
        () =>
            p.desglose?.map((t) => ({ tipo: t.tipo, base: t.base, iva: t.cuota })) ??
            desgloseIva(lineas, p.iva_percent),
        [p.desglose, lineas, p.iva_percent],
    );

    const ahora = useMemo(() => new Date().toLocaleString("es-ES").slice(0, 17), []);
    const fecha = p.fecha?.trim() || ahora;

    const tipo = p.tipo_factura ?? "";
    const titulo = tipo.startsWith("R")
        ? "FACTURA RECTIFICATIVA"
        : tipo === "F1" || tipo === "F3"
          ? "FACTURA"
          : null;

    const numero = p.numero_ticket?.trim() ?? "";
    const origen = p.origen?.trim() ?? "";
    const metodo = p.metodo_pago?.trim() ?? "";
    const razon = p.razon_social.trim();
    const razonYaImpresa =
        p.show_business_name && razon.toLowerCase() === p.business_name.trim().toLowerCase();

    // El logo puede ser una ruta relativa (canal R2) o un data URL heredado; se resuelve a una URL
    // usable para el <img>. Ver `imageUrl.resolveImageUrl` (maneja ambos casos y el modo Handy).
    const [logoSrc, setLogoSrc] = useState<string>("");
    useEffect(() => {
        let alive = true;
        resolveImageUrl(p.logo_path)
            .then((u) => alive && setLogoSrc(u))
            .catch(() => alive && setLogoSrc(""));
        return () => {
            alive = false;
        };
    }, [p.logo_path]);

    const fila = (izq: React.ReactNode, der: React.ReactNode, estilo?: React.CSSProperties) => (
        <div style={{ display: "flex", justifyContent: "space-between", gap: 8, ...estilo }}>
            <span style={{ whiteSpace: "nowrap" }}>{izq}</span>
            <span>{der}</span>
        </div>
    );

    return (
        <div className="bg-white text-black rounded-xl border border-black/10 shadow-sm overflow-hidden inline-block">
            {/* `ch` = ancho de un carácter en esta fuente monoespaciada: el papel mide exactamente
                las columnas que tendrá el de verdad. */}
            <div style={{ fontFamily: "monospace", fontSize: 12, padding: 14, width: `${cols}ch` }}>
                {/* Cabecera: los datos del negocio, a la izquierda. El logo cierra el ticket. */}
                <div style={{ textAlign: "left" }}>
                    {p.show_business_name ? (
                        <div style={{ fontWeight: 800, fontSize: 16, letterSpacing: 0.2 }}>
                            {p.business_name.trim() || "TPV"}
                        </div>
                    ) : null}
                    {razon && !razonYaImpresa ? <div>{razon}</div> : null}
                    {p.show_address && p.direccion.trim() ? (
                        <div style={{ marginTop: 2 }}>{p.direccion}</div>
                    ) : null}
                    {p.show_phone && p.telefono.trim() ? <div>Tel: {p.telefono}</div> : null}
                    {p.cif.trim() ? <div>CIF: {p.cif}</div> : null}
                </div>

                <Separador />

                {fila(fecha, numero || "PRECUENTA")}
                {origen ? <div>{origen}</div> : null}
                {metodo ? fila("Pago", metodo) : null}

                {!numero ? (
                    <Centrado>NO ES UN TICKET DE VENTA</Centrado>
                ) : (
                    <>
                        {p.es_anulado ? <Centrado negrita>*** ANULADO ***</Centrado> : null}
                        {p.es_copia ? <Centrado negrita>COPIA</Centrado> : null}
                        {/* Lo que distingue el papel de una factura que no es un ticket: una
                            rectificativa dice qué rectifica, una completa (F1/F3) qué sustituye, y
                            las dos llevan al cliente. Espejo de `bloque_tipo_de_factura`. */}
                        {titulo ? (
                            <>
                                <Centrado negrita>{titulo}</Centrado>
                                {p.rectifica ? (
                                    <div>
                                        Rectifica a la factura {p.rectifica}
                                        {p.rectifica_fecha ? ` del ${p.rectifica_fecha}` : ""}
                                    </div>
                                ) : null}
                                {p.sustituye.length === 1 ? (
                                    <div>Sustituye a la factura {p.sustituye[0]}</div>
                                ) : p.sustituye.length > 1 ? (
                                    <div>Sustituye a las facturas {p.sustituye.join(", ")}</div>
                                ) : null}
                                {p.destinatario ? (
                                    <>
                                        <Separador />
                                        <div>Cliente: {p.destinatario.nombre_razon}</div>
                                        <div>NIF: {p.destinatario.nif}</div>
                                        {p.destinatario.domicilio ? (
                                            <div>{p.destinatario.domicilio}</div>
                                        ) : null}
                                    </>
                                ) : null}
                            </>
                        ) : null}
                    </>
                )}

                <Separador />

                {lineas.length === 0 ? (
                    <div style={{ textAlign: "center", opacity: 0.65, padding: "10px 0" }}>
                        No hay productos en el ticket.
                    </div>
                ) : (
                    <div>
                        {lineas.map((g, idx) => {
                            const lineTotal = por(g.precio, g.qty);
                            return (
                                <div key={idx} style={{ marginBottom: 8 }}>
                                    {fila(
                                        recortar(g.nombre, eur(lineTotal)),
                                        <strong>{eur(lineTotal)}</strong>,
                                    )}
                                    <div style={{ opacity: 0.8 }}>
                                        {g.qty} x {eur(g.precio)}
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                )}

                <Separador />

                {tramos.length <= 1 ? (
                    // Un solo tipo (el caso normal): como toda la vida, sin convertir el ticket en
                    // una tabla por algo que no aporta nada.
                    <>
                        {fila("BASE", eur(tramos[0]?.base ?? CERO))}
                        {fila(`IVA (${tramos[0]?.tipo ?? p.iva_percent}%)`, eur(tramos[0]?.iva ?? CERO))}
                    </>
                ) : (
                    // Varios tramos: cada uno con su base y su IVA.
                    tramos.map((t) => (
                        <React.Fragment key={t.tipo}>
                            {fila(`BASE (${t.tipo}%)`, eur(t.base))}
                            {fila(`IVA (${t.tipo}%)`, eur(t.iva))}
                        </React.Fragment>
                    ))
                )}

                <Separador solido />
                {fila("TOTAL", eur(total), { fontWeight: 900, fontSize: 14 })}

                {p.show_footer_message ? (
                    <>
                        <Separador />
                        <div style={{ textAlign: "center", fontSize: 11, opacity: 0.9 }}>
                            {p.mensaje_footer.trim() || "¡Gracias por su visita!"}
                        </div>
                    </>
                ) : null}

                {p.show_logo && logoSrc ? (
                    // El logo impreso ocupa el ancho del cabezal menos los márgenes (ver
                    // `ancho_logo_dots` en printing.rs), no una fracción del bloque de texto.
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
