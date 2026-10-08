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

    const PAGE_W = 595.28;
    const PAGE_H = 841.89;
    const M = 50;

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
        cols: Array<{
            text: string;
            x: number;
            w?: number;
            align?: "left" | "right";
        }>,
        opts?: { size?: number; bold?: boolean; color?: Color },
    ) => {
        const size = opts?.size ?? 10;
        const usedFont = opts?.bold ? fontBold : font;
        const color = opts?.color ?? black;

        if (ctx.y < M + 30) ctx = mkPage();

        for (const c of cols) {
            const t = safeText(c.text);
            let x = c.x;

            if (c.align === "right") {
                const w = usedFont.widthOfTextAtSize(t, size);
                x = c.x + (c.w ?? 0) - w;
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
            { text: "Fecha/Hora", x: M },
            { text: "Cliente", x: M + 140 },
            { text: "Método", x: M + 380 },
            {
                text: "Importe",
                x: M + 460,
                w: PAGE_W - M - (M + 460),
                align: "right",
            },
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
                { text: e.fecha_hora, x: M },
                { text: e.cliente, x: M + 140 },
                { text: esAnulado(e) ? `${e.metodo} · ANULADO` : e.metodo, x: M + 380 },
                {
                    text: eur(e.importe),
                    x: M + 460,
                    w: PAGE_W - M - (M + 460),
                    align: "right",
                },
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
            { text: "Fecha", x: M },
            { text: "Tipo", x: M + 110 },
            { text: "Concepto", x: M + 230 },
            {
                text: "Importe",
                x: M + 460,
                w: PAGE_W - M - (M + 460),
                align: "right",
            },
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
                { text: tipo === "dia" ? s.fecha_hora.slice(0, 10) : s.fecha_hora, x: M },
                { text: s.tipo_gasto, x: M + 110 },
                { text: conceptoPdf, x: M + 230 },
                {
                    text: eur(s.importe),
                    x: M + 460,
                    w: PAGE_W - M - (M + 460),
                    align: "right",
                },
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
