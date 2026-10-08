/**
 * Tipos
 */
export type RoomPoly = { type: "poly"; points: number[] };

export type TableShape = "rect" | "rounded" | "circle";
export type TableSize = "S" | "M" | "L";

export type Table = {
    id: string;
    name: string;
    x: number;
    y: number;
    width: number;
    height: number;
    radius?: number;
    seats: number;
    shape: TableShape;
};

export type Salon = {
    id: string;
    name: string;
    room: RoomPoly;
    tables: Table[];
};

/**
 * Utils geom
 */
const COLLISION_SKIN = 0.6;

export function pointsToXY(points: number[]) {
    const out: Array<{ x: number; y: number }> = [];
    for (let i = 0; i < points.length; i += 2) {
        out.push({ x: points[i], y: points[i + 1] });
    }
    return out;
}

export function clamp(n: number, min: number, max: number) {
    return Math.max(min, Math.min(n, max));
}

export function polygonBBox(points: number[]) {
    const xy = pointsToXY(points);
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    for (const p of xy) {
        minX = Math.min(minX, p.x);
        minY = Math.min(minY, p.y);
        maxX = Math.max(maxX, p.x);
        maxY = Math.max(maxY, p.y);
    }

    return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

export function isPointInPolygon(
    point: { x: number; y: number },
    polygon: Array<{ x: number; y: number }>,
) {
    let inside = false;

    for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
        const xi = polygon[i].x;
        const yi = polygon[i].y;
        const xj = polygon[j].x;
        const yj = polygon[j].y;

        const intersect =
            yi > point.y !== yj > point.y &&
            point.x < ((xj - xi) * (point.y - yi)) / (yj - yi + 1e-12) + xi;

        if (intersect) inside = !inside;
    }

    return inside;
}

export function getTableBBox(table: Table) {
    const rawW =
        table.shape === "circle" ? (table.radius ?? 40) * 2 : table.width;
    const rawH =
        table.shape === "circle" ? (table.radius ?? 40) * 2 : table.height;
    return { rawW, rawH };
}

export function tableProbePointsAt(pos: { x: number; y: number }, table: Table) {
    if (table.shape === "circle") {
        const r0 = table.radius ?? 40;
        const r = Math.max(4, r0 - COLLISION_SKIN);
        const cx = pos.x + r0;
        const cy = pos.y + r0;
        const d = r / Math.SQRT2;

        return [
            { x: cx + r, y: cy },
            { x: cx - r, y: cy },
            { x: cx, y: cy + r },
            { x: cx, y: cy - r },
            { x: cx + d, y: cy + d },
            { x: cx + d, y: cy - d },
            { x: cx - d, y: cy + d },
            { x: cx - d, y: cy - d },
        ];
    }

    const { rawW, rawH } = getTableBBox(table);
    const inset = COLLISION_SKIN;
    const x = pos.x + inset;
    const y = pos.y + inset;
    const w = Math.max(8, rawW - inset * 2);
    const h = Math.max(8, rawH - inset * 2);

    const cx = x + w / 2;
    const cy = y + h / 2;

    return [
        { x, y },
        { x: x + w, y },
        { x, y: y + h },
        { x: x + w, y: y + h },
        { x: cx, y },
        { x: cx, y: y + h },
        { x, y: cy },
        { x: x + w, y: cy },
    ];
}

export function isTableInsidePolygon(
    pos: { x: number; y: number },
    table: Table,
    polyPoints: number[],
) {
    const poly = pointsToXY(polyPoints);
    const probes = tableProbePointsAt(pos, table);
    return probes.every((p) => isPointInPolygon(p, poly));
}

export function clampToRect(
    pos: { x: number; y: number },
    rect: { x: number; y: number; width: number; height: number },
    table: Table,
) {
    const { rawW: w, rawH: h } = getTableBBox(table);
    return {
        x: clamp(pos.x, rect.x, rect.x + rect.width - w),
        y: clamp(pos.y, rect.y, rect.y + rect.height - h),
    };
}

export function constrainToPolygonSmooth(
    desired: { x: number; y: number },
    lastValid: { x: number; y: number },
    polyPoints: number[],
    table: Table,
) {
    const bbox = polygonBBox(polyPoints);
    const approx = clampToRect(desired, bbox, table);

    if (isTableInsidePolygon(approx, table, polyPoints)) return approx;

    const candX = { x: approx.x, y: lastValid.y };
    if (isTableInsidePolygon(candX, table, polyPoints)) return candX;

    const candY = { x: lastValid.x, y: approx.y };
    if (isTableInsidePolygon(candY, table, polyPoints)) return candY;

    let lo = 0;
    let hi = 1;
    let best = lastValid;

    for (let iter = 0; iter < 34; iter++) {
        const mid = (lo + hi) / 2;
        const cand = {
            x: lastValid.x + (approx.x - lastValid.x) * mid,
            y: lastValid.y + (approx.y - lastValid.y) * mid,
        };
        if (isTableInsidePolygon(cand, table, polyPoints)) {
            best = cand;
            lo = mid;
        } else {
            hi = mid;
        }
    }

    return best;
}

export function findInsidePosition(
    polyPoints: number[],
    table: Table,
    worldW: number,
    worldH: number,
) {
    const bbox = polygonBBox(polyPoints);
    const { rawW: w, rawH: h } = getTableBBox(table);

    const start = {
        x: clamp(bbox.x + bbox.width / 2 - w / 2, 20, worldW - w - 20),
        y: clamp(bbox.y + bbox.height / 2 - h / 2, 20, worldH - h - 20),
    };

    if (isTableInsidePolygon(start, table, polyPoints)) return start;

    const step = 20;
    for (let r = 1; r <= 40; r++) {
        const d = r * step;
        const candidates = [
            { x: start.x + d, y: start.y },
            { x: start.x - d, y: start.y },
            { x: start.x, y: start.y + d },
            { x: start.x, y: start.y - d },
            { x: start.x + d, y: start.y + d },
            { x: start.x + d, y: start.y - d },
            { x: start.x - d, y: start.y + d },
            { x: start.x - d, y: start.y - d },
        ].map((p) => ({
            x: clamp(p.x, 20, worldW - w - 20),
            y: clamp(p.y, 20, worldH - h - 20),
        }));

        for (const c of candidates) {
            if (isTableInsidePolygon(c, table, polyPoints)) return c;
        }
    }

    return start;
}

export function distPointToSegmentSquared(
    p: { x: number; y: number },
    a: { x: number; y: number },
    b: { x: number; y: number },
) {
    const abx = b.x - a.x;
    const aby = b.y - a.y;
    const apx = p.x - a.x;
    const apy = p.y - a.y;

    const abLen2 = abx * abx + aby * aby + 1e-9;
    let t = (apx * abx + apy * aby) / abLen2;
    t = clamp(t, 0, 1);

    const cx = a.x + t * abx;
    const cy = a.y + t * aby;

    const dx = p.x - cx;
    const dy = p.y - cy;
    return dx * dx + dy * dy;
}

export function insertPointAtNearestEdge(points: number[], p: { x: number; y: number }) {
    const verts = pointsToXY(points);
    if (verts.length < 3) return { next: points, insertedVertexIndex: -1 };

    let bestIdx = 0;
    let bestD = Infinity;

    for (let i = 0; i < verts.length; i++) {
        const a = verts[i];
        const b = verts[(i + 1) % verts.length];
        const d = distPointToSegmentSquared(p, a, b);
        if (d < bestD) {
            bestD = d;
            bestIdx = i;
        }
    }

    const insertedVertexIndex = bestIdx + 1;
    const insertPos = insertedVertexIndex * 2;
    const next = points
        .slice(0, insertPos)
        .concat([p.x, p.y], points.slice(insertPos));

    return { next, insertedVertexIndex };
}
