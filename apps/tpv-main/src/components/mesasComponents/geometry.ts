import type { Salon, Table } from "./types";

function pointsToXY(points: number[]) {
  const out: Array<{ x: number; y: number }> = [];
  for (let i = 0; i < points.length; i += 2) out.push({ x: points[i], y: points[i + 1] });
  return out;
}

function bboxFromPoly(points: number[]) {
  const xy = pointsToXY(points);
  if (!xy.length) return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const p of xy) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  return { minX, minY, maxX, maxY };
}

function bboxFromTable(t: Table) {
  if (t.shape === "circle") {
    const r = t.radius ?? 45;
    return { minX: t.x, minY: t.y, maxX: t.x + r * 2, maxY: t.y + r * 2 };
  }
  return { minX: t.x, minY: t.y, maxX: t.x + t.width, maxY: t.y + t.height };
}

function mergeBBox(
  a: { minX: number; minY: number; maxX: number; maxY: number },
  b: { minX: number; minY: number; maxX: number; maxY: number }
) {
  return {
    minX: Math.min(a.minX, b.minX),
    minY: Math.min(a.minY, b.minY),
    maxX: Math.max(a.maxX, b.maxX),
    maxY: Math.max(a.maxY, b.maxY),
  };
}

/**
 * Encaja el contenido pero SIN hacerlo enorme:
 * - fit para que se vea completo
 * - cap a un máximo (para no “reventar” salones pequeños)
 */
export function fitTransform(salon: Salon, viewW: number, viewH: number, padding = 24) {
  let box = bboxFromPoly(salon.room.points);
  for (const t of salon.tables ?? []) box = mergeBBox(box, bboxFromTable(t));

  const contentW = Math.max(1, box.maxX - box.minX);
  const contentH = Math.max(1, box.maxY - box.minY);

  const usableW = Math.max(1, viewW - padding * 2);
  const usableH = Math.max(1, viewH - padding * 2);

  const rawScale = Math.min(usableW / contentW, usableH / contentH);

  // ✅ reducimos un poquito y capamos el máximo
  const scale = Math.max(0.2, Math.min(rawScale * 0.9, 1.15));

  const scaledW = contentW * scale;
  const scaledH = contentH * scale;

  const offsetX = padding + (usableW - scaledW) / 2;
  const offsetY = padding + (usableH - scaledH) / 2;

  const x = offsetX - box.minX * scale;
  const y = offsetY - box.minY * scale;

  return { x, y, scale };
}
