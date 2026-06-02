export function parseMesaId(tableId: string): number | null {
  const m = String(tableId).match(/db-mesa-(\d+)/);
  return m ? Number(m[1]) : null;
}
