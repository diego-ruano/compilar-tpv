export function cn(...classes: Array<string | false | undefined | null>) {
  return classes.filter(Boolean).join(" ");
}
/** RI-71: los detalles persistidos llevan un UUID; las líneas en inserción llevan "". */
export function lineaGuardada(linea: { detalleId: string }): boolean {
    return Boolean(linea.detalleId);
}
