// RI-48: mismo conjunto cerrado que tpv_domain::pago; desconocido es error de entrada.
import { z } from "zod";
export const zMetodoPago = z.string().trim().toLowerCase()
    .pipe(z.enum(["efectivo", "tarjeta"]))
    .transform((v) => v === "tarjeta" ? "Tarjeta" as const : "Efectivo" as const);
export const zEstadoCocina = z.string().trim().toUpperCase()
    .pipe(z.enum(["PENDIENTE", "PREPARADO"]));
