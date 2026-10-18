import type { MesaPlano, SalonPlano, Vista } from "./tipos";

type Caja = { minX: number; minY: number; maxX: number; maxY: number };

function cajaDelSalon(points: number[]): Caja {
    if (points.length < 2) return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
    let minX = Infinity,
        minY = Infinity,
        maxX = -Infinity,
        maxY = -Infinity;
    for (let i = 0; i + 1 < points.length; i += 2) {
        minX = Math.min(minX, points[i]);
        minY = Math.min(minY, points[i + 1]);
        maxX = Math.max(maxX, points[i]);
        maxY = Math.max(maxY, points[i + 1]);
    }
    return { minX, minY, maxX, maxY };
}

function cajaDeMesa(t: MesaPlano): Caja {
    if (t.shape === "circle") {
        const r = t.radius ?? 45;
        return { minX: t.x, minY: t.y, maxX: t.x + r * 2, maxY: t.y + r * 2 };
    }
    return { minX: t.x, minY: t.y, maxX: t.x + t.width, maxY: t.y + t.height };
}

function unir(a: Caja, b: Caja): Caja {
    return {
        minX: Math.min(a.minX, b.minX),
        minY: Math.min(a.minY, b.minY),
        maxX: Math.max(a.maxX, b.maxX),
        maxY: Math.max(a.maxY, b.maxY),
    };
}

/**
 * Encaja el salón entero en el hueco sin hacerlo enorme: escala para que se vea completo, un poco
 * menos, y con un tope (para no «reventar» un salón pequeño). Los E2E calculan con esta misma
 * función dónde pulsar una mesa.
 */
export function fitTransform(salon: SalonPlano, viewW: number, viewH: number, padding = 24): Vista {
    let box = cajaDelSalon(salon.room.points);
    for (const t of salon.tables ?? []) box = unir(box, cajaDeMesa(t));

    const contentW = Math.max(1, box.maxX - box.minX);
    const contentH = Math.max(1, box.maxY - box.minY);

    const usableW = Math.max(1, viewW - padding * 2);
    const usableH = Math.max(1, viewH - padding * 2);

    const rawScale = Math.min(usableW / contentW, usableH / contentH);
    const scale = Math.max(0.2, Math.min(rawScale * 0.9, 1.15));

    const offsetX = padding + (usableW - contentW * scale) / 2;
    const offsetY = padding + (usableH - contentH * scale) / 2;

    return { x: offsetX - box.minX * scale, y: offsetY - box.minY * scale, scale };
}
