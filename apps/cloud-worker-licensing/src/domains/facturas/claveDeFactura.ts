// src/domains/facturas/claveDeFactura.ts
//
// Dónde guarda el bucket `IMAGES` el PDF de una factura completa: `{tenant}/facturas/{ID_Registro}.pdf`.
//
// Es el mismo bucket que las imágenes, por decisión del responsable (un solo bucket para lo de los
// TPV), y lo que separa una cosa de otra es la carpeta: las imágenes cuelgan de `{tenant}/images/…`
// y nada de `/v1/images` admite otra (`RUTA_DE_IMAGEN` exige `images/` delante y una extensión de
// imagen al final). Las facturas sólo entran y salen por `/v1/facturas`, firmado y sólo para la Main
// vigente (`facturas.routes.ts`); el GET público de las imágenes no las da nunca
// (`test/facturasEnElBucket.test.ts`).
//
// Va aparte del router para que se pueda leer sin Hono.

import { recortar } from "../../lib/texto";

/** La carpeta de las facturas dentro de la de cada negocio. */
const CARPETA_DE_FACTURAS = "facturas/";

/**
 * El `ID_Registro` de un registro de facturación: el UUID que le pone la Main antes del `INSERT`
 * (`new_id()`). Es lo único que viaja en el camino o en el cuerpo para nombrar una factura: ni su
 * número ni el NIF del destinatario, que son de una persona (AUD-27).
 */
export const ID_DE_FACTURA = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * El `ID_Registro` tal como se usa en la clave, o `null` si no lo es. Un UUID se escribe en minúsculas
 * en la clave: el mismo registro da siempre el mismo objeto, lo escriba como lo escriba quien llama.
 */
export function idDeFactura(valor: string | undefined): string | null {
	const id = recortar(valor ?? "");
	return ID_DE_FACTURA.test(id) ? id.toLowerCase() : null;
}

/**
 * La clave del PDF de una factura en el bucket. El negocio sale siempre del token, nunca de lo que
 * manda quien llama, y el id tiene que haber pasado por `idDeFactura`.
 */
export function claveDeFactura(tenantId: string, id: string): string {
	return `${tenantId}/${CARPETA_DE_FACTURAS}${id}.pdf`;
}

/** Cómo empieza todo PDF: `%PDF-` (ISO 32000-1, 7.5.2). */
const CABECERA_PDF = [0x25, 0x50, 0x44, 0x46, 0x2d];

/** ¿Empiezan estos bytes como un PDF? No se mira más: el PDF lo compone la Main. */
export function pareceUnPdf(bytes: Uint8Array): boolean {
	return bytes.length > CABECERA_PDF.length && CABECERA_PDF.every((b, i) => bytes[i] === b);
}
