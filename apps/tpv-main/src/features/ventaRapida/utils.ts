export function cn(...classes: Array<string | false | undefined | null>) {
  return classes.filter(Boolean).join(" ");
}

// El formateador del dinero vive en un solo sitio (ARQ-01). Se re-exporta
// desde aqui porque media venta rapida lo importa por este nombre.
export { eur } from "../../shared/lib/dinero";

export const sqlEscape = (value: string) => value.replace(/'/g, "''");
