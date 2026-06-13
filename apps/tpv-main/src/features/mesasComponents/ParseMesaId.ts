export function parseMesaId(tableId: string): string | null {
  const m = String(tableId ?? "").trim().match(/^db-mesa-(.+)$/);
  return m ? m[1].trim() || null : null;
}
