// RI-48: mismo conjunto cerrado que tpv_domain::pago; desconocido es error de entrada.
import * as z from "zod";
import { recortar } from "./texto";
export const zMetodoPago = z.string().overwrite(recortar).toLowerCase()
    .pipe(z.enum(["efectivo", "tarjeta"]))
    .transform((v) => v === "tarjeta" ? "Tarjeta" as const : "Efectivo" as const);
export const zEstadoCocina = z.string().overwrite(recortar).min(1, "Falta el estado de la línea.").toUpperCase()
    .pipe(z.enum(["PENDIENTE", "PREPARADO"]));
