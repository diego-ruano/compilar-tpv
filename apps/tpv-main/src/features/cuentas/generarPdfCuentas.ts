import { PDFDocument, StandardFonts, rgb, type PDFPage, type Color } from "pdf-lib";
import type { EntradaDto, SalidaDto } from "./cuentasApis";
import { esAnulado } from "./cuentasApis";
import { CERO, eur, restar, sumar } from "../../shared/lib/dinero";
import { textoPdf } from "../../shared/lib/textoPdf";

type ContextoPdf = { page: PDFPage; y: number };
type DatosPdfCuentas = {
    del: string; al: string;
    entradas: EntradaDto[]; salidas: SalidaDto[];
    proveedores: ReadonlyMap<string, string>;
    tipo?: "dia" | "rango";
    generadoEn?: Date;
};

const PAGE_W = 595.28;
const PAGE_H = 841.89;
const M = 50;
/** Lo mínimo que queda libre entre el texto de una columna y la siguiente. */
const SEPARACION = 6;

type Columna = { x: number; w: number; align?: "left" | "right" };
const IMPORTE: Columna = { x: M + 415, w: PAGE_W - M - (M + 415), align: "right" };

/**
 * INC-20261031-025: cada columna tiene su ancho, el mismo en la cabecera y en las filas, y su texto
 * se recorta a él. Antes el método empezaba en x 430 sin límite y el importe ocupaba 35 pt alineado a
 * la derecha: «Efectivo · ANULADO» pisaba el importe, y un cliente o un concepto largos podían pisar
 * la columna de al lado.
 */
export const COLUMNAS_ENTRADAS = {
    fecha: { x: M, w: 120 },
    cliente: { x: M + 120, w: 180 },
    metodo: { x: M + 300, w: 115 },
    importe: IMPORTE,
} satisfies Record<string, Columna>;
export const COLUMNAS_SALIDAS = {
    fecha: { x: M, w: 110 },
    tipo: { x: M + 110, w: 120 },
    concepto: { x: M + 230, w: 185 },
    importe: IMPORTE,
} satisfies Record<string, Columna>;
export const ANCHO_UTIL = PAGE_W - 2 * M;

/** Lo que cabe de `texto` en `ancho` puntos según `medir`; si hay que cortarlo, termina en «…». */
export function ajustarAlAncho(texto: string, ancho: number, medir: (t: string) => number): string {
    if (medir(texto) <= ancho) return texto;
    const caracteres = Array.from(texto);
    while (caracteres.length && medir(caracteres.join("") + "…") > ancho) caracteres.pop();
    return caracteres.length ? caracteres.join("") + "…" : "";
}

/** RI-82: un único documento para el día o el rango; independiente de React y del diálogo. */
export async function generarPdfCuentas({ del, al, entradas: entradasFull, salidas: salidasFull,
    proveedores: proveedoresMap, tipo = "rango", generadoEn = new Date(),
}: DatosPdfCuentas): Promise<Uint8Array> {
    const titulo = tipo === "dia" ? "Cuenta del día" : "Cuentas";
    const totalEntradasPdf = sumar(...entradasFull.map(e => esAnulado(e) ? CERO : e.importe));
    const totalSalidasPdf = sumar(...salidasFull.map(s => s.importe));
    const balancePdf = restar(totalEntradasPdf, totalSalidasPdf);
    const pdfDoc = await PDFDocument.create();
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const fontBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

    const mkPage = () => {
        const page = pdfDoc.addPage([PAGE_W, PAGE_H]);
        return { page, y: PAGE_H - M };
    };

    const gray = rgb(0.35, 0.35, 0.35);
    const black = rgb(0.1, 0.1, 0.1);


    const safeText = (t: unknown) =>
        textoPdf(
            String(t ?? "")
                .replace(/\s+/g, " ")
                .trim(),
                font,
        );

    const drawLine = (ctx: ContextoPdf) => {
        if (ctx.y < M + 20) ctx = mkPage();
        ctx.page.drawLine({
            start: { x: M, y: ctx.y },
            end: { x: PAGE_W - M, y: ctx.y },
            thickness: 1,
            color: rgb(0.9, 0.9, 0.9),
        });
        ctx.y -= 10;
        return ctx;
    };

    const write = (
        ctx: ContextoPdf,
        text: string,
        opts?: { size?: number; bold?: boolean; color?: Color },
    ) => {
        const size = opts?.size ?? 11;
        const usedFont = opts?.bold ? fontBold : font;
        const color = opts?.color ?? black;

        if (ctx.y < M + 40) ctx = mkPage();

        ctx.page.drawText(safeText(text), {
            x: M,
            y: ctx.y,
            size,
            font: usedFont,
            color,
        });
        ctx.y -= size + 6;
        return ctx;
    };

    const writeRow = (
        ctx: ContextoPdf,
        cols: Array<Columna & { text: string }>,
        opts?: { size?: number; bold?: boolean; color?: Color },
    ) => {
        const size = opts?.size ?? 10;
        const usedFont = opts?.bold ? fontBold : font;
        const color = opts?.color ?? black;
        const medir = (t: string) => usedFont.widthOfTextAtSize(t, size);

        if (ctx.y < M + 30) ctx = mkPage();

        for (const c of cols) {
            // La de la derecha llega al margen; las demás dejan sitio a la siguiente.
            const t = ajustarAlAncho(safeText(c.text), c.align === "right" ? c.w : c.w - SEPARACION, medir);
            let x = c.x;

            if (c.align === "right") {
                x = c.x + c.w - medir(t);
            }

            ctx.page.drawText(t, {
                x,
                y: ctx.y,
                size,
                font: usedFont,
                color,
            });
        }

        ctx.y -= size + 6;
        return ctx;
    };

    let ctx = mkPage();

    ctx = write(ctx, titulo, { size: 20, bold: true });
    ctx = write(ctx, tipo === "dia" ? `Fecha: ${del}` : `Rango: ${del || "-"}  a  ${al || "-"}`, {
        size: 11,
        color: gray,
    });
    ctx = write(
        ctx,
        `Entradas: ${eur(totalEntradasPdf)} | Salidas: ${eur(
            totalSalidasPdf,
        )} | Balance: ${eur(balancePdf)}`,
        { size: 12, bold: true },
    );
    ctx.y -= 6;
    ctx = drawLine(ctx);

    ctx.y -= 16;
    ctx = write(ctx, "Entradas", { size: 14, bold: true });
    ctx = writeRow(
        ctx,
        [
            { text: "Fecha/Hora", ...COLUMNAS_ENTRADAS.fecha },
            { text: "Cliente", ...COLUMNAS_ENTRADAS.cliente },
            { text: "Método", ...COLUMNAS_ENTRADAS.metodo },
            { text: "Importe", ...COLUMNAS_ENTRADAS.importe },
        ],
        { bold: true, color: gray },
    );
    ctx = drawLine(ctx);
    ctx.y -= 8;

    if (!entradasFull.length) {
        ctx = write(ctx, tipo === "dia" ? "Sin entradas hoy." : "Sin entradas para este rango/filtro.", { color: gray });
    } else {
        for (const e of entradasFull) {
            ctx = writeRow(ctx, [
                { text: e.fecha_hora, ...COLUMNAS_ENTRADAS.fecha },
                { text: e.cliente, ...COLUMNAS_ENTRADAS.cliente },
                { text: esAnulado(e) ? `${e.metodo} · ANULADO` : e.metodo, ...COLUMNAS_ENTRADAS.metodo },
                { text: eur(e.importe), ...COLUMNAS_ENTRADAS.importe },
            ]);
        }
    }

    ctx.y -= 8;
    ctx = drawLine(ctx);

    ctx.y -= 16;
    ctx = write(ctx, "Salidas", { size: 14, bold: true });
    ctx = writeRow(
        ctx,
        [
            { text: "Fecha", ...COLUMNAS_SALIDAS.fecha },
            { text: "Tipo", ...COLUMNAS_SALIDAS.tipo },
            { text: "Concepto", ...COLUMNAS_SALIDAS.concepto },
            { text: "Importe", ...COLUMNAS_SALIDAS.importe },
        ],
        { bold: true, color: gray },
    );
    ctx = drawLine(ctx);
    ctx.y -= 8;

    if (!salidasFull.length) {
        ctx = write(ctx, tipo === "dia" ? "Sin salidas hoy." : "Sin salidas para este rango/filtro.", { color: gray });
    } else {
        for (const s of salidasFull) {
            const provName = s.proveedor_id ? proveedoresMap.get(s.proveedor_id) : null;

            const conceptoPdf =
                s.tipo_gasto === "Proveedor" && (provName || s.proveedor_id)
                    ? `${s.concepto} (Prov: ${provName ?? s.proveedor_id})`
                    : s.concepto;

            ctx = writeRow(ctx, [
                { text: tipo === "dia" ? s.fecha_hora.slice(0, 10) : s.fecha_hora, ...COLUMNAS_SALIDAS.fecha },
                { text: s.tipo_gasto, ...COLUMNAS_SALIDAS.tipo },
                { text: conceptoPdf, ...COLUMNAS_SALIDAS.concepto },
                { text: eur(s.importe), ...COLUMNAS_SALIDAS.importe },
            ]);
        }
    }

    if (ctx.y < M + 60) ctx = mkPage();
    ctx.y = M;
    ctx.page.drawText(safeText(`Generado: ${generadoEn.toLocaleString("es-ES")}`), {
        x: M,
        y: ctx.y,
        size: 9,
        font,
        color: gray,
    });
    return pdfDoc.save();
}
