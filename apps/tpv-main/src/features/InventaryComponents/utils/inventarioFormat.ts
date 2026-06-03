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
