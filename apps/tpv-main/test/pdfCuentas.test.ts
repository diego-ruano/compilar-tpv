import { describe, expect, it } from "vitest";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { textoPdf } from "../src/shared/lib/textoPdf";
import { generarPdfCuentas } from "../src/features/cuentas/generarPdfCuentas";
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
