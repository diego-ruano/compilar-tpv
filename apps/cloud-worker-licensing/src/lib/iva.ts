// src/lib/iva.ts
//
// Un tipo de IVA es un porcentaje entre 0 y 100 (RI-78): el del negocio y el propio de un producto.
// Espejo de `validate_iva_percent` en la Main (`tpv-domain/src/configuracion.rs`) y de
// `shared/lib/iva.ts` en la webview; los tres leen sus casos de `validacion_casos.json`.
//
// Fuera de rango se RECHAZA: ni se recorta ni se sustituye por otro valor. Un tipo impositivo es un
// dato fiscal, y uno distinto del que se tecleó acaba en un ticket sin que nadie lo haya decidido.

import * as z from "zod";

export const MSG_IVA = "El IVA tiene que ser un número entre 0 y 100";

export const zIva = z.number({ message: MSG_IVA }).min(0, MSG_IVA).max(100, MSG_IVA);
