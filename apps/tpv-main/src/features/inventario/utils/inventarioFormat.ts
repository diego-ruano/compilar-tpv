// utils/inventarioFormat.ts
export function formatDateES(yyyyMmDd: string | null | undefined) {
  if (!yyyyMmDd) return "—";
  const [y, m, d] = yyyyMmDd.split("-");
  if (!y || !m || !d) return yyyyMmDd;
  return `${d}/${m}/${y}`;
}

export function formatCantidad(
  stock: number | null | undefined,
  unidad: string | null | undefined,
) {
  const n = stock ?? 0;
  const u = (unidad ?? "").trim();
  if (!u) return String(n);
  return `${n} ${u}`;
}

export const sqlEscape = (value: string) => value.replace(/'/g, "''");

export const convertirABase64 = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.readAsDataURL(file);
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = (error) => reject(error);
  });

/**
 * INC-20261030-001: las existencias de un producto son sus lotes **más** el stock suelto, como en el
 * resumen de Inventario, la ficha del proveedor y el aviso de stock bajo
 * (`lotes + COALESCE(Stock_Suelto, 0)`). La ficha sumaba sólo los lotes: un producto con 2 sueltos
 * y 1 en lote decía tener 1 y saltaba como «stock bajo». Sin suelto (`null`) no se controla y cuenta
 * 0; uno negativo (se vendió sin existencias) resta. Redondeado a milésimas, como se escribe una
 * cantidad de stock.
 */
export function stockTotal(
  lotes: ReadonlyArray<{ Stock_Disponible?: number | null }>,
  stockSuelto: number | null | undefined,
): number {
  const enLotes = lotes.reduce((acc, l) => acc + (Number(l.Stock_Disponible) || 0), 0);
  return Math.round((enLotes + (Number(stockSuelto) || 0)) * 1000) / 1000;
}
