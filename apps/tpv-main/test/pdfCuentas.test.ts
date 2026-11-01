import { describe, expect, it } from "vitest";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { textoPdf } from "../src/shared/lib/textoPdf";
import { ANCHO_UTIL, COLUMNAS_ENTRADAS, COLUMNAS_SALIDAS, ajustarAlAncho, generarPdfCuentas } from "../src/features/cuentas/generarPdfCuentas";
import { deCentimos } from "../src/shared/lib/dinero";

describe("PDF de cuentas (RI-82)", () => {
    it("conserva los caracteres españoles y reemplaza sólo los que Helvetica no admite", async () => {
        const pdf = await PDFDocument.create();
        const fuente = await pdf.embedFont(StandardFonts.Helvetica);
        const castellano = "Año · Señor · á é í ó ú ü · € ¿ ¡ º ª";
        expect(textoPdf(castellano, fuente)).toBe(castellano);
        expect(textoPdf("An\u0303o → 😀", fuente)).toBe("Año ? ?");
        expect(() => fuente.encodeText(textoPdf(castellano + " → 😀", fuente))).not.toThrow();
    });
    it.each(["dia", "rango"] as const)("genera un documento válido para %s", async (tipo) => {
        const bytes = await generarPdfCuentas({ tipo, del: "2026-10-08", al: "2026-10-08",
            entradas: [], salidas: [], proveedores: new Map(), generadoEn: new Date("2026-10-08T12:00:00Z") });
        const pdf = await PDFDocument.load(bytes);
        expect(pdf.getPageCount()).toBe(1);
        expect(pdf.getPage(0).getWidth()).toBeCloseTo(595.28);
    });
    it("pagina un rango con cobros, anulaciones y nombres no codificables", async () => {
        const entradas = Array.from({ length: 180 }, (_, i) => ({ id: `pago-${i}`, fecha_hora: "2026-10-08 12:00",
            cliente: "Señor Muñoz 😀", metodo: "Tarjeta", importe: deCentimos(300), estado: i % 2 ? "ACTIVO" : "ANULADO",
            es_devolucion: false,
            devuelto: deCentimos(0), anulado_en: null, anulado_por: null, motivo_anulacion: null }));
        const bytes = await generarPdfCuentas({ del: "2026-10-08", al: "2026-10-08", entradas,
            salidas: [{ id: "gasto", fecha_hora: "2026-10-08", tipo_gasto: "Proveedor", concepto: "Piñones", importe: deCentimos(700), proveedor_id: "p", pagado_con_caja: false }],
            proveedores: new Map([["p", "Almacén Peña"]]) });
        expect((await PDFDocument.load(bytes)).getPageCount()).toBeGreaterThan(1);
    });
});

// INC-20261031-025: el método empezaba en x 430 sin límite y el importe ocupaba 35 pt a la derecha:
// «Efectivo · ANULADO» pisaba el importe. Ahora cada columna tiene su ancho y su texto se recorta a él.
describe("columnas del PDF de cuentas (INC-20261031-025)", () => {
    const medidor = async () => {
        const fuente = await (await PDFDocument.create()).embedFont(StandardFonts.Helvetica);
        return { fuente, medir: (t: string) => fuente.widthOfTextAtSize(t, 10) };
    };

    it("ninguna columna invade la siguiente y la última acaba en el margen", () => {
        for (const columnas of [COLUMNAS_ENTRADAS, COLUMNAS_SALIDAS]) {
            const lista = Object.values(columnas);
            for (let i = 0; i + 1 < lista.length; i++) expect(lista[i].x + lista[i].w).toBeLessThanOrEqual(lista[i + 1].x);
            const ultima = lista[lista.length - 1];
            expect(ultima.x + ultima.w).toBeCloseTo(50 + ANCHO_UTIL);
        }
    });

    it("un cobro anulado cabe entero en la columna del método", async () => {
        const { medir } = await medidor();
        for (const metodo of ["Efectivo · ANULADO", "Tarjeta · ANULADO"]) {
            expect(medir(metodo)).toBeLessThanOrEqual(COLUMNAS_ENTRADAS.metodo.w - 6);
        }
    });

    it("un texto que no cabe se corta con «…» sin pasarse del ancho", async () => {
        const { fuente, medir } = await medidor();
        const recortado = ajustarAlAncho("Restaurante Los Arcos de la Plaza Mayor, S.L.", 100, medir);
        expect(recortado.endsWith("…")).toBe(true);
        expect(medir(recortado)).toBeLessThanOrEqual(100);
        expect(() => fuente.encodeText(recortado)).not.toThrow();
        expect(ajustarAlAncho("Ana", 100, medir)).toBe("Ana");
        expect(ajustarAlAncho("Ana", 1, medir)).toBe("");
    });
});
