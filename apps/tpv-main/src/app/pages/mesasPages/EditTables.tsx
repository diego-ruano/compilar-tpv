import React, { useEffect, useMemo, useRef, useState } from "react";
import { Stage, Layer, Rect, Line, Group, Text, Circle } from "react-konva";
import {
    mesasLoadLayout,
    mesasSaveLayout,
} from "../../../features/mesasComponents/mesasApi";
import { mesasKeys } from "../../../features/mesasComponents/mesasQueries";
import { queryClient } from "../../../shared/lib/queryClient";
import { useLocation, useNavigate } from "react-router-dom";
import { useTheme } from "../../../shared/stores/useTheme";

/**
 * Tipos
 */
type RoomPoly = { type: "poly"; points: number[] };

type TableShape = "rect" | "rounded" | "circle";
type TableSize = "S" | "M" | "L";

type Table = {
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

type Salon = {
    id: string;
    name: string;
    room: RoomPoly;
    tables: Table[];
};

/**
 * Utils geom
 */
const COLLISION_SKIN = 0.6;

function pointsToXY(points: number[]) {
    const out: Array<{ x: number; y: number }> = [];
    for (let i = 0; i < points.length; i += 2) {
        out.push({ x: points[i], y: points[i + 1] });
    }
    return out;
}

function clamp(n: number, min: number, max: number) {
    return Math.max(min, Math.min(n, max));
}

function polygonBBox(points: number[]) {
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

function isPointInPolygon(
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

function getTableBBox(table: Table) {
    const rawW =
        table.shape === "circle" ? (table.radius ?? 40) * 2 : table.width;
    const rawH =
        table.shape === "circle" ? (table.radius ?? 40) * 2 : table.height;
    return { rawW, rawH };
}

function tableProbePointsAt(pos: { x: number; y: number }, table: Table) {
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

function isTableInsidePolygon(
    pos: { x: number; y: number },
    table: Table,
    polyPoints: number[],
) {
    const poly = pointsToXY(polyPoints);
    const probes = tableProbePointsAt(pos, table);
    return probes.every((p) => isPointInPolygon(p, poly));
}

function clampToRect(
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

function constrainToPolygonSmooth(
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

function findInsidePosition(
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

function distPointToSegmentSquared(
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

function insertPointAtNearestEdge(points: number[], p: { x: number; y: number }) {
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

/**
 * UI helpers
 */
function cn(...classes: Array<string | false | null | undefined>) {
    return classes.filter(Boolean).join(" ");
}

type BtnVariant = "primary" | "danger" | "neutral" | "accent";

function IconButton({
    icon,
    children,
    onClick,
    disabled,
    variant = "neutral",
}: {
    icon?: React.ReactNode;
    children: React.ReactNode;
    onClick: () => void;
    disabled?: boolean;
    variant?: BtnVariant;
}) {
    const base =
        "h-10 px-4 rounded-xl border text-sm font-semibold shadow-sm transition inline-flex items-center gap-2 select-none";
    const variants: Record<BtnVariant, string> = {
        neutral: disabled
            ? "border-border bg-surface-2 text-fg-subtle cursor-not-allowed"
            : "border-border bg-surface text-fg hover:bg-surface-2 active:scale-[0.98]",
        primary: disabled
            ? "border-border bg-surface-2 text-fg-subtle cursor-not-allowed"
            : "border-accent bg-accent text-white hover:bg-accent-hover active:scale-[0.98]",
        danger: disabled
            ? "border-border bg-surface-2 text-fg-subtle cursor-not-allowed"
            : "border-danger/30 bg-danger-soft text-danger hover:bg-danger-soft active:scale-[0.98]",
        accent: disabled
            ? "border-border bg-surface-2 text-fg-subtle cursor-not-allowed"
            : "border-accent/30 bg-accent-soft text-accent hover:bg-accent-soft active:scale-[0.98]",
    };

    return (
        <button
            disabled={disabled}
            onClick={onClick}
            className={cn(base, variants[variant])}
        >
            {icon ? <span className="text-base leading-none">{icon}</span> : null}
            <span>{children}</span>
        </button>
    );
}

function Chip({
    active,
    children,
    onClick,
}: {
    active?: boolean;
    children: React.ReactNode;
    onClick: () => void;
}) {
    return (
        <button
            onClick={onClick}
            className={cn(
                "h-9 px-3 rounded-xl border text-sm font-semibold shadow-sm transition inline-flex items-center gap-2",
                active
                    ? "border-accent bg-accent text-white"
                    : "border-border bg-surface text-fg-muted hover:bg-surface-2",
            )}
        >
            {children}
        </button>
    );
}

function Modal({
    open,
    title,
    children,
    onClose,
}: {
    open: boolean;
    title: string;
    children: React.ReactNode;
    onClose: () => void;
}) {
    if (!open) return null;

    return (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/30 p-4">
            <div className="w-full max-w-[520px] rounded-2xl border border-border bg-surface shadow-xl overflow-hidden">
                <div className="flex items-center justify-between gap-3 p-4 border-b border-border">
                    <div className="text-base font-bold text-fg">
                        {title}
                    </div>
                    <button
                        onClick={onClose}
                        className="h-9 w-9 rounded-xl border border-border bg-surface text-fg-muted hover:bg-surface-2"
                    >
                        ✕
                    </button>
                </div>
                <div className="p-4">{children}</div>
            </div>
        </div>
    );
}

function useElementSize<T extends HTMLElement>() {
    const ref = useRef<T | null>(null);
    const [size, setSize] = useState({ width: 600, height: 400 });

    useEffect(() => {
        const el = ref.current;
        if (!el) return;

        const update = () => {
            const r = el.getBoundingClientRect();
            setSize({
                width: Math.max(1, Math.floor(r.width)),
                height: Math.max(1, Math.floor(r.height)),
            });
        };

        update();
        const ro = new ResizeObserver(update);
        ro.observe(el);
        return () => ro.disconnect();
    }, []);

    return { ref, size };
}

function sizeToDims(shape: TableShape, size: TableSize) {
    const rect = {
        S: { w: 90, h: 60 },
        M: { w: 120, h: 70 },
        L: { w: 160, h: 90 },
    }[size];

    if (shape === "circle") {
        const radius = { S: 38, M: 45, L: 58 }[size];
        return { width: radius * 2, height: radius * 2, radius };
    }

    return {
        width: rect.w,
        height: rect.h,
        radius: undefined as number | undefined,
    };
}

/**
 * Guard cambios sin guardar (sin useBlocker)
 */
function useUnsavedGuard(enabled: boolean) {
    const navigate = useNavigate();
    const location = useLocation();

    const [open, setOpen] = useState(false);
    const pendingActionRef = useRef<null | (() => void)>(null);
    const allowOnceRef = useRef(false);

    useEffect(() => {
        if (!enabled) return;

        const handler = (e: BeforeUnloadEvent) => {
            e.preventDefault();
            e.returnValue = "";
            return "";
        };

        window.addEventListener("beforeunload", handler);
        return () => window.removeEventListener("beforeunload", handler);
    }, [enabled]);

    useEffect(() => {
        if (!enabled) return;

        const handler = () => {
            if (allowOnceRef.current) {
                allowOnceRef.current = false;
                return;
            }

            navigate(location.pathname, { replace: true });
            setOpen(true);
            pendingActionRef.current = () => {
                allowOnceRef.current = true;
                window.history.back();
            };
        };

        window.addEventListener("popstate", handler);
        return () => window.removeEventListener("popstate", handler);
    }, [enabled, navigate, location.pathname]);

    const guardedNavigate = (to: any, opts?: any) => {
        if (!enabled) return navigate(to, opts);
        setOpen(true);
        pendingActionRef.current = () => navigate(to, opts);
    };

    const confirmLeave = () => {
        setOpen(false);
        const act = pendingActionRef.current;
        pendingActionRef.current = null;
        act?.();
    };

    const cancelLeave = () => {
        setOpen(false);
        pendingActionRef.current = null;
    };

    return { open, confirmLeave, cancelLeave, guardedNavigate };
}

/**
 * Componente principal
 */
export default function EditTables() {
    const dark = useTheme((s) => s.theme === "dark");
    const PADDING = 12;
    const WORLD_W = 4000;
    const WORLD_H = 4000;

    const [salons, setSalons] = useState<Salon[]>([]);
    const salonsRef = useRef<Salon[]>([]);
    useEffect(() => {
        salonsRef.current = salons;
    }, [salons]);

    const [activeSalonId, setActiveSalonId] = useState<string>("");

    const [dirty, setDirty] = useState(false);
    const guard = useUnsavedGuard(dirty);

    const [viewScale, setViewScale] = useState(1);
    const [viewPos, setViewPos] = useState({ x: 0, y: 0 });

    const isPanningRef = useRef(false);
    const panStartRef = useRef<{ x: number; y: number } | null>(null);
    const viewStartPosRef = useRef<{ x: number; y: number } | null>(null);
    const isDraggingSomethingRef = useRef(false);

    const [addPointArmed, setAddPointArmed] = useState(false);
    const [addTableOpen, setAddTableOpen] = useState(false);
    const [placeTableByClick, setPlaceTableByClick] = useState(false);
    const [pendingTableDraft, setPendingTableDraft] = useState<Table | null>(null);

    const [deleteTableArmed, setDeleteTableArmed] = useState(false);

    const historyRef = useRef<Salon[][]>([]);

    const stageRef = useRef<any>(null);
    const layerRef = useRef<any>(null);
    const roomStrokeLineRef = useRef<any>(null);

    const roomPointsDraftRef = useRef<Record<string, number[]>>({});
    const insertedVertexStackRef = useRef<Record<string, number[]>>({});
    const lastValidTableWorldRef = useRef<Record<string, { x: number; y: number }>>({});
    const lastValidVertexWorldRef = useRef<Record<string, { x: number; y: number }>>({});

    const { ref: canvasBoxRef, size: canvasSize } =
        useElementSize<HTMLDivElement>();

    function syncRoomLines(points: number[]) {
        if (roomStrokeLineRef.current) roomStrokeLineRef.current.points(points);
        if (layerRef.current) layerRef.current.batchDraw();
    }

    const [loadingDb, setLoadingDb] = useState(true);

    useEffect(() => {
        (async () => {
            try {
                const data = await mesasLoadLayout();

                if (data.length > 0) {
                    const cast = data as Salon[];
                    setSalons(cast);
                    setActiveSalonId(cast[0].id);

                    for (const s of cast) {
                        roomPointsDraftRef.current[s.id] = s.room.points.slice();
                        insertedVertexStackRef.current[s.id] = [];
                    }

                    requestAnimationFrame(() => syncRoomLines(cast[0].room.points));
                } else {
                    setSalons([]);
                    setActiveSalonId("");
                }
            } catch (e) {
                console.error("No se pudo cargar layout desde API/local fallback:", e);
                setSalons([]);
                setActiveSalonId("");
            } finally {
                setLoadingDb(false);
                setDirty(false);
            }
        })();
    }, []);

    const activeSalon = salons.find((s) => s.id === activeSalonId) ?? salons[0];
    const emptyState = !loadingDb && salons.length === 0;

    const activeRoom = activeSalon?.room;
    const activeTables = activeSalon?.tables ?? [];

    function pushHistory(snapshot: Salon[]) {
        historyRef.current.push(JSON.parse(JSON.stringify(snapshot)) as Salon[]);
        if (historyRef.current.length > 120) historyRef.current.shift();
        setDirty(true);
    }

    function screenToWorld(p: { x: number; y: number }) {
        return {
            x: (p.x - viewPos.x) / viewScale,
            y: (p.y - viewPos.y) / viewScale,
        };
    }

    function worldToScreen(p: { x: number; y: number }) {
        return {
            x: p.x * viewScale + viewPos.x,
            y: p.y * viewScale + viewPos.y,
        };
    }

    function commitRoomPoints(points: number[]) {
        if (!activeSalon) return;

        roomPointsDraftRef.current[activeSalonId] = points.slice();
        setSalons((prev) =>
            prev.map((s) =>
                s.id === activeSalonId
                    ? { ...s, room: { type: "poly", points: points.slice() } }
                    : s,
            ),
        );
        syncRoomLines(points);
        setDirty(true);
    }

    function updateTablePos(tableId: string, next: { x: number; y: number }) {
        if (!activeSalon) return;

        setSalons((prev) =>
            prev.map((s) =>
                s.id === activeSalonId
                    ? {
                        ...s,
                        tables: s.tables.map((t) =>
                            t.id === tableId ? { ...t, ...next } : t,
                        ),
                    }
                    : s,
            ),
        );
        setDirty(true);
    }

    function deleteTableById(tableId: string) {
        if (!activeSalon) return;

        pushHistory(salonsRef.current);

        setSalons((prev) =>
            prev.map((s) =>
                s.id === activeSalonId
                    ? { ...s, tables: s.tables.filter((t) => t.id !== tableId) }
                    : s,
            ),
        );

        try {
            const prefix = `${activeSalonId}:table:${tableId}`;
            delete lastValidTableWorldRef.current[prefix];
        } catch { }

        setDirty(true);
    }

    function undo() {
        const last = historyRef.current.pop();
        if (!last) return;

        setSalons(last);

        const nextDrafts: Record<string, number[]> = {};
        const nextStacks: Record<string, number[]> = {};
        for (const s of last) {
            nextDrafts[s.id] = s.room.points.slice();
            nextStacks[s.id] = [];
        }

        roomPointsDraftRef.current = nextDrafts;
        insertedVertexStackRef.current = nextStacks;

        lastValidTableWorldRef.current = {};
        lastValidVertexWorldRef.current = {};

        setDirty(true);

        requestAnimationFrame(() => {
            const keep = last.some((s) => s.id === activeSalonId)
                ? activeSalonId
                : (last[0]?.id ?? "");

            if (keep) {
                setActiveSalonId(keep);
                const pts =
                    nextDrafts[keep] ??
                    last.find((s) => s.id === keep)?.room.points ??
                    [];
                if (pts.length) syncRoomLines(pts);
            }
        });
    }

    const defaultRoomPoints = useMemo(
        () => [200, 160, 900, 160, 900, 540, 200, 540],
        [],
    );

    function createNewSalon() {
        const prev = salonsRef.current;
        if (prev.length > 0) pushHistory(prev);

        const id = `zona-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
        const name = `Zona ${prev.length + 1}`;
        const defaultRoom: RoomPoly = {
            type: "poly",
            points: [...defaultRoomPoints],
        };

        setSalons((p) => [...p, { id, name, room: defaultRoom, tables: [] }]);
        roomPointsDraftRef.current[id] = defaultRoom.points.slice();
        insertedVertexStackRef.current[id] = [];
        setActiveSalonId(id);

        requestAnimationFrame(() => syncRoomLines(defaultRoom.points));
        setDirty(true);
    }

    function deleteSalonById(id: string) {
        if (salonsRef.current.length <= 1) return;

        pushHistory(salonsRef.current);

        const next = salonsRef.current.filter((s) => s.id !== id);
        setSalons(next);

        const fallback = next[0]?.id ?? "";
        setActiveSalonId((prev) => (prev === id ? fallback : prev));

        requestAnimationFrame(() => {
            const pts =
                roomPointsDraftRef.current[fallback] ??
                next[0]?.room.points ??
                [];
            if (pts.length) syncRoomLines(pts);
        });

        setDirty(true);
    }

    function renameSalon(id: string, name: string) {
        pushHistory(salonsRef.current);
        setSalons((prev) => prev.map((s) => (s.id === id ? { ...s, name } : s)));
        setDirty(true);
    }

    function beginAddPoint() {
        setDeleteTableArmed(false);
        setAddPointArmed(true);
    }

    function removeLastVertex() {
        if (!activeRoom) return;

        const current =
            roomPointsDraftRef.current[activeSalonId]?.slice() ??
            activeRoom.points.slice();
        const vertsCount = current.length / 2;
        if (vertsCount <= 3) return;

        pushHistory(salonsRef.current);

        const stack = insertedVertexStackRef.current[activeSalonId] ?? [];
        const idxToRemove = stack.length ? stack.pop()! : vertsCount - 1;

        const removeAt = idxToRemove * 2;
        const next = current
            .slice(0, removeAt)
            .concat(current.slice(removeAt + 2));

        insertedVertexStackRef.current[activeSalonId] = stack.map((vIdx) =>
            vIdx > idxToRemove ? vIdx - 1 : vIdx,
        );

        roomPointsDraftRef.current[activeSalonId] = next;
        commitRoomPoints(next);
        setDirty(true);
    }

    function defaultTableDraft(): Table {
        return {
            id: `table-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
            name: `Mesa ${activeTables.length + 1}`,
            x: 0,
            y: 0,
            width: 120,
            height: 70,
            seats: 4,
            shape: "rounded",
            radius: 45,
        };
    }

    const [tableForm, setTableForm] = useState(() => ({
        name: "Mesa 1",
        seats: 4,
        shape: "rounded" as TableShape,
        size: "M" as TableSize,
        placement: "auto" as "auto" | "click",
    }));

    function openAddTableModal() {
        setDeleteTableArmed(false);

        const t = defaultTableDraft();
        setTableForm({
            name: t.name,
            seats: t.seats,
            shape: t.shape,
            size: "M",
            placement: "auto",
        });
        setAddTableOpen(true);
    }

    function finalizeAddTableAuto(t: Table) {
        if (!activeRoom) return;

        pushHistory(salonsRef.current);
        const polyPoints =
            roomPointsDraftRef.current[activeSalonId] ?? activeRoom.points;
        const pos = findInsidePosition(polyPoints, t, WORLD_W, WORLD_H);
        t.x = pos.x;
        t.y = pos.y;

        setSalons((prev) =>
            prev.map((s) =>
                s.id === activeSalonId ? { ...s, tables: [...s.tables, t] } : s,
            ),
        );
        setDirty(true);
    }

    function finalizeAddTableByClick(t: Table) {
        setPendingTableDraft(t);
        setPlaceTableByClick(true);
    }

    function resetZoom() {
        setViewScale(1);
        setViewPos({ x: 0, y: 0 });
    }

    function getStagePointerScreen() {
        const stage = stageRef.current;
        const p = stage?.getPointerPosition?.();
        return p ? { x: p.x, y: p.y } : null;
    }

    function onBgMouseDown(e: any) {
        if (isDraggingSomethingRef.current) return;
        if (addPointArmed || placeTableByClick || deleteTableArmed) return;

        e.cancelBubble = true;

        isPanningRef.current = true;
        const p = getStagePointerScreen();
        if (!p) return;

        panStartRef.current = p;
        viewStartPosRef.current = { ...viewPos };
    }

    function onStageMouseMove() {
        if (!isPanningRef.current) return;
        if (isDraggingSomethingRef.current) return;

        const p = getStagePointerScreen();
        if (!p || !panStartRef.current || !viewStartPosRef.current) return;

        const dx = p.x - panStartRef.current.x;
        const dy = p.y - panStartRef.current.y;

        setViewPos({
            x: viewStartPosRef.current.x + dx,
            y: viewStartPosRef.current.y + dy,
        });
    }

    function onStageMouseUp() {
        isPanningRef.current = false;
        panStartRef.current = null;
        viewStartPosRef.current = null;
    }

    function handleWheel(e: any) {
        e.evt.preventDefault();
        const pointer = getStagePointerScreen();
        if (!pointer) return;

        const oldScale = viewScale;
        const scaleBy = 1.08;
        const direction = e.evt.deltaY > 0 ? -1 : 1;
        const newScale = clamp(
            oldScale * (direction > 0 ? scaleBy : 1 / scaleBy),
            0.55,
            2.5,
        );

        const worldPoint = screenToWorld(pointer);
        const newPos = {
            x: pointer.x - worldPoint.x * newScale,
            y: pointer.y - worldPoint.y * newScale,
        };

        setViewScale(newScale);
        setViewPos(newPos);
    }

    function handleStageMouseDown() {
        if (!activeRoom) return;
        const pointer = getStagePointerScreen();
        if (!pointer) return;

        const world = screenToWorld(pointer);

        if (placeTableByClick && pendingTableDraft) {
            const polyPoints =
                roomPointsDraftRef.current[activeSalonId] ?? activeRoom.points;

            const clamped = {
                x: clamp(world.x, PADDING, WORLD_W - PADDING),
                y: clamp(world.y, PADDING, WORLD_H - PADDING),
            };

            const t = { ...pendingTableDraft };
            const { rawW: w, rawH: h } = getTableBBox(t);
            const candidate = { x: clamped.x - w / 2, y: clamped.y - h / 2 };

            pushHistory(salonsRef.current);

            const finalPos = isTableInsidePolygon(candidate, t, polyPoints)
                ? candidate
                : findInsidePosition(polyPoints, t, WORLD_W, WORLD_H);

            t.x = finalPos.x;
            t.y = finalPos.y;

            setSalons((prev) =>
                prev.map((s) =>
                    s.id === activeSalonId
                        ? { ...s, tables: [...s.tables, t] }
                        : s,
                ),
            );

            setPlaceTableByClick(false);
            setPendingTableDraft(null);
            setDirty(true);
            return;
        }

        if (addPointArmed) {
            pushHistory(salonsRef.current);

            const current =
                roomPointsDraftRef.current[activeSalonId]?.slice() ??
                activeRoom.points.slice();

            const clamped = {
                x: clamp(world.x, PADDING, WORLD_W - PADDING),
                y: clamp(world.y, PADDING, WORLD_H - PADDING),
            };

            const { next } = insertPointAtNearestEdge(current, clamped);
            roomPointsDraftRef.current[activeSalonId] = next;
            commitRoomPoints(next);
            setAddPointArmed(false);
            setDirty(true);
        }
    }

    function wouldKeepAllTablesInside(nextPolyPoints: number[]) {
        if (!activeRoom) return true;
        return activeTables.every((t) =>
            isTableInsidePolygon({ x: t.x, y: t.y }, t, nextPolyPoints),
        );
    }

    function TableNode({ table }: { table: Table }) {
        if (!activeRoom) return null;
        const roomPts =
            roomPointsDraftRef.current[activeSalonId] ?? activeRoom.points;

        return (
            <Group
                x={table.x}
                y={table.y}
                draggable={!deleteTableArmed}
                onMouseDown={(e) => {
                    if (deleteTableArmed) {
                        e.cancelBubble = true;
                        deleteTableById(table.id);
                    }
                }}
                onDragStart={(e) => {
                    if (deleteTableArmed) return;
                    e.cancelBubble = true;
                    isDraggingSomethingRef.current = true;
                    isPanningRef.current = false;
                    pushHistory(salonsRef.current);
                }}
                dragBoundFunc={(posScreen: { x: number; y: number }) => {
                    if (deleteTableArmed) return posScreen as any;

                    const key = `${activeSalonId}:table:${table.id}`;
                    const lastValidWorld =
                        lastValidTableWorldRef.current[key] ?? {
                            x: table.x,
                            y: table.y,
                        };

                    const desiredWorld = screenToWorld(posScreen);
                    const nextWorld = constrainToPolygonSmooth(
                        desiredWorld,
                        lastValidWorld,
                        roomPts,
                        table,
                    );

                    lastValidTableWorldRef.current[key] = nextWorld;
                    return worldToScreen(nextWorld);
                }}
                onDragEnd={(e) => {
                    if (deleteTableArmed) return;

                    const abs = e.target.getAbsolutePosition();
                    const world = screenToWorld({ x: abs.x, y: abs.y });
                    updateTablePos(table.id, { x: world.x, y: world.y });
                    isDraggingSomethingRef.current = false;
                    setDirty(true);
                }}
            >
                {table.shape === "circle" ? (
                    <>
                        <Circle
                            x={table.radius ?? 45}
                            y={table.radius ?? 45}
                            radius={table.radius ?? 45}
                            fill={dark ? "rgba(71,85,105,0.95)" : "rgba(15,23,42,0.92)"}
                            stroke="rgba(148,163,184,0.95)"
                            strokeWidth={1}
                            shadowBlur={10}
                            shadowOpacity={0.12}
                        />
                        <Text
                            text={table.name}
                            x={0}
                            y={(table.radius ?? 45) - 18}
                            width={(table.radius ?? 45) * 2}
                            align="center"
                            fontSize={14}
                            fill="#e5e7eb"
                        />
                        <Text
                            text={`${table.seats} pax`}
                            x={0}
                            y={table.radius ?? 45}
                            width={(table.radius ?? 45) * 2}
                            align="center"
                            fontSize={12}
                            fill="#cbd5e1"
                        />
                    </>
                ) : (
                    <>
                        <Rect
                            width={table.width}
                            height={table.height}
                            cornerRadius={table.shape === "rounded" ? 14 : 2}
                            fill={dark ? "rgba(71,85,105,0.95)" : "rgba(15,23,42,0.92)"}
                            stroke="rgba(148,163,184,0.95)"
                            strokeWidth={1}
                            shadowBlur={10}
                            shadowOpacity={0.12}
                        />
                        <Text
                            text={table.name}
                            x={10}
                            y={10}
                            fontSize={14}
                            fill="#e5e7eb"
                        />
                        <Text
                            text={`${table.seats} pax`}
                            x={10}
                            y={30}
                            fontSize={12}
                            fill="#cbd5e1"
                        />
                    </>
                )}
            </Group>
        );
    }

    function RoomEditor() {
        if (!activeRoom) return null;
        const draftPoints =
            roomPointsDraftRef.current[activeSalonId] ?? activeRoom.points;
        const verts = pointsToXY(draftPoints);

        return (
            <Group>
                <Line
                    ref={roomStrokeLineRef}
                    points={draftPoints}
                    closed
                    stroke={dark ? "rgba(148,163,184,0.5)" : "rgba(15,23,42,0.55)"}
                    strokeWidth={2}
                    lineJoin="round"
                />

                {verts.map((v, idx) => (
                    <Circle
                        key={idx}
                        x={v.x}
                        y={v.y}
                        radius={7}
                        fill={dark ? "rgba(148,163,184,0.95)" : "rgba(15,23,42,0.9)"}
                        stroke="rgba(148,163,184,0.95)"
                        strokeWidth={2}
                        draggable={!deleteTableArmed}
                        hitStrokeWidth={18}
                        onDragStart={(e) => {
                            if (deleteTableArmed) return;
                            e.cancelBubble = true;
                            isDraggingSomethingRef.current = true;
                            isPanningRef.current = false;
                            pushHistory(salonsRef.current);
                        }}
                        dragBoundFunc={(posScreen: { x: number; y: number }) => {
                            if (deleteTableArmed) return posScreen as any;

                            const key = `${activeSalonId}:v:${idx}`;
                            const lastValidWorld =
                                lastValidVertexWorldRef.current[key] ?? {
                                    x: v.x,
                                    y: v.y,
                                };

                            const desiredWorld = screenToWorld(posScreen);
                            const clampedWorld = {
                                x: clamp(desiredWorld.x, PADDING, WORLD_W - PADDING),
                                y: clamp(desiredWorld.y, PADDING, WORLD_H - PADDING),
                            };

                            const current =
                                roomPointsDraftRef.current[activeSalonId] ??
                                draftPoints;
                            const nextPts = current.slice();
                            nextPts[idx * 2] = clampedWorld.x;
                            nextPts[idx * 2 + 1] = clampedWorld.y;

                            if (!wouldKeepAllTablesInside(nextPts)) {
                                return worldToScreen(lastValidWorld);
                            }

                            lastValidVertexWorldRef.current[key] = clampedWorld;
                            return worldToScreen(clampedWorld);
                        }}
                        onDragMove={(e) => {
                            if (deleteTableArmed) return;

                            const abs = e.target.getAbsolutePosition();
                            const world = screenToWorld({ x: abs.x, y: abs.y });

                            const current =
                                roomPointsDraftRef.current[activeSalonId] ??
                                draftPoints;
                            const next = current.slice();
                            next[idx * 2] = world.x;
                            next[idx * 2 + 1] = world.y;

                            roomPointsDraftRef.current[activeSalonId] = next;
                            syncRoomLines(next);
                        }}
                        onDragEnd={(e) => {
                            if (deleteTableArmed) return;

                            const abs = e.target.getAbsolutePosition();
                            const world = screenToWorld({ x: abs.x, y: abs.y });

                            const current =
                                roomPointsDraftRef.current[activeSalonId] ??
                                draftPoints;
                            const next = current.slice();
                            next[idx * 2] = world.x;
                            next[idx * 2 + 1] = world.y;

                            commitRoomPoints(next);
                            isDraggingSomethingRef.current = false;
                            setDirty(true);
                        }}
                    />
                ))}
            </Group>
        );
    }

    return (
        <div className="w-full h-full bg-surface-2 overflow-hidden">
            <Modal
                open={guard.open}
                title="Cambios sin guardar"
                onClose={guard.cancelLeave}
            >
                <div className="text-sm text-fg-muted">
                    Tienes cambios sin guardar. Si sales ahora, <b>se perderán</b>.
                </div>

                <div className="mt-4 flex items-center justify-end gap-2">
                    <IconButton
                        icon="↩️"
                        variant="neutral"
                        onClick={guard.cancelLeave}
                    >
                        Quedarme
                    </IconButton>
                    <IconButton
                        icon="🚪"
                        variant="danger"
                        onClick={() => {
                            setDirty(false);
                            guard.confirmLeave();
                        }}
                    >
                        Salir igualmente
                    </IconButton>
                </div>
            </Modal>

            <div className="h-full p-4 grid grid-cols-[360px_1fr] gap-4">
                <div className="rounded-2xl border border-border bg-surface shadow-sm p-4 flex flex-col gap-4 overflow-hidden">
                    <div className="flex items-center justify-between">
                        <div className="text-lg font-extrabold text-fg">
                            Zonas
                        </div>
                        <IconButton
                            icon="➕"
                            variant="primary"
                            onClick={createNewSalon}
                        >
                            Nueva
                        </IconButton>
                    </div>

                    <div className="flex-1 overflow-auto pr-1">
                        {loadingDb ? (
                            <div className="h-full grid place-items-center text-fg-muted">
                                Cargando…
                            </div>
                        ) : emptyState ? (
                            <div className="h-full grid place-items-center">
                                <div className="w-full rounded-2xl border border-border bg-surface-2 p-4 text-center">
                                    <div className="text-base font-bold text-fg">
                                        No hay zonas todavía
                                    </div>
                                    <div className="mt-1 text-sm text-fg-muted">
                                        Crea la primera zona para empezar.
                                    </div>
                                    <div className="mt-4 flex justify-center">
                                        <IconButton
                                            icon="✨"
                                            variant="primary"
                                            onClick={createNewSalon}
                                        >
                                            Crear primera zona
                                        </IconButton>
                                    </div>
                                </div>
                            </div>
                        ) : (
                            <div className="flex flex-col gap-2">
                                {salons.map((s) => (
                                    <div
                                        key={s.id}
                                        className={cn(
                                            "rounded-2xl border p-3 flex flex-col gap-2",
                                            s.id === activeSalonId
                                                ? "border-accent bg-accent-soft"
                                                : "border-border bg-surface",
                                        )}
                                    >
                                        <div className="flex items-center gap-2">
                                            <Chip
                                                active={s.id === activeSalonId}
                                                onClick={() => {
                                                    setActiveSalonId(s.id);
                                                    roomPointsDraftRef.current[s.id] =
                                                        s.room.points.slice();
                                                    insertedVertexStackRef.current[s.id] =
                                                        insertedVertexStackRef.current[s.id] ??
                                                        [];
                                                    requestAnimationFrame(() =>
                                                        syncRoomLines(
                                                            roomPointsDraftRef.current[s.id],
                                                        ),
                                                    );
                                                }}
                                            >
                                                {s.id === activeSalonId
                                                    ? "✅ Activa"
                                                    : "Seleccionar"}
                                            </Chip>

                                            <div className="ml-auto">
                                                <IconButton
                                                    icon="🗑️"
                                                    variant="danger"
                                                    disabled={salons.length <= 1}
                                                    onClick={() => deleteSalonById(s.id)}
                                                >
                                                    Eliminar
                                                </IconButton>
                                            </div>
                                        </div>

                                        <div>
                                            <div className="text-xs font-semibold text-fg-muted mb-1">
                                                Nombre zona
                                            </div>
                                            <input
                                                value={s.name}
                                                onChange={(e) =>
                                                    renameSalon(s.id, e.target.value)
                                                }
                                                className="h-10 w-full rounded-xl border border-border bg-surface px-3 text-sm text-fg outline-none focus:border-accent"
                                            />
                                        </div>

                                        <div className="flex items-center justify-between text-xs text-fg-muted">
                                            <span>Mesas: {s.tables.length}</span>
                                            <span>
                                                Polígono: {s.room.points.length / 2} puntos
                                            </span>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>

                    <div className="border-t border-border pt-4 flex flex-col gap-2">
                        <div className="text-sm font-bold text-fg">
                            Herramientas
                        </div>

                        <div className="grid grid-cols-2 gap-2">
                            <IconButton
                                icon="➕"
                                variant="accent"
                                onClick={openAddTableModal}
                                disabled={!activeSalon || deleteTableArmed}
                            >
                                Añadir mesa
                            </IconButton>

                            <IconButton
                                icon="📍"
                                variant="neutral"
                                onClick={beginAddPoint}
                                disabled={
                                    !activeSalon ||
                                    addPointArmed ||
                                    placeTableByClick ||
                                    deleteTableArmed
                                }
                            >
                                {addPointArmed ? "Click mapa…" : "Añadir punto"}
                            </IconButton>

                            <IconButton
                                icon="🧹"
                                variant="neutral"
                                onClick={removeLastVertex}
                                disabled={
                                    !activeSalon ||
                                    deleteTableArmed ||
                                    (roomPointsDraftRef.current[activeSalonId]?.length ?? 0) <= 6
                                }
                            >
                                Quitar punto
                            </IconButton>

                            <IconButton
                                icon="↩️"
                                variant="primary"
                                onClick={undo}
                                disabled={
                                    historyRef.current.length === 0 || deleteTableArmed
                                }
                            >
                                Deshacer
                            </IconButton>

                            <IconButton
                                icon="🔍"
                                variant="neutral"
                                onClick={resetZoom}
                                disabled={!activeSalon || deleteTableArmed}
                            >
                                Reset zoom
                            </IconButton>

                            <IconButton
                                icon="🗑️"
                                variant={deleteTableArmed ? "danger" : "neutral"}
                                disabled={
                                    !activeSalon || addPointArmed || placeTableByClick
                                }
                                onClick={() => {
                                    setDeleteTableArmed((v) => {
                                        const next = !v;
                                        if (next) {
                                            setAddPointArmed(false);
                                            setPlaceTableByClick(false);
                                            setPendingTableDraft(null);
                                        }
                                        return next;
                                    });
                                }}
                            >
                                {deleteTableArmed ? "Click mesa…" : "Borrar mesa"}
                            </IconButton>

                            <IconButton
                                icon="💾"
                                variant="primary"
                                disabled={!activeSalon}
                                onClick={async () => {
                                    try {
                                        await mesasSaveLayout(salonsRef.current as any);
                                        queryClient.invalidateQueries({ queryKey: mesasKeys.layout() });

                                        const fresh = await mesasLoadLayout();
                                        setSalons(fresh as Salon[]);
                                        setActiveSalonId((prev) => {
                                            if (fresh.some((s) => s.id === prev)) return prev;
                                            return fresh[0]?.id ?? "";
                                        });

                                        for (const s of fresh as Salon[]) {
                                            roomPointsDraftRef.current[s.id] = s.room.points.slice();
                                            insertedVertexStackRef.current[s.id] = [];
                                        }

                                        if (fresh[0]?.room?.points?.length) {
                                            requestAnimationFrame(() => syncRoomLines(fresh[0].room.points));
                                        }

                                        setDirty(false);
                                    } catch (e) {
                                        console.error(
                                            "No se pudo guardar el layout en API/local fallback:",
                                            e,
                                        );
                                    }
                                }}
                            >
                                Guardar layout
                            </IconButton>
                        </div>

                        {placeTableByClick && (
                            <div className="mt-2 rounded-2xl border border-border bg-accent-soft p-3 text-sm text-fg">
                                <b>🧭 Colocar mesa:</b> haz click en el mapa.
                                <div className="mt-2">
                                    <IconButton
                                        icon="✕"
                                        variant="danger"
                                        onClick={() => {
                                            setPlaceTableByClick(false);
                                            setPendingTableDraft(null);
                                        }}
                                    >
                                        Cancelar
                                    </IconButton>
                                </div>
                            </div>
                        )}

                        {addPointArmed && (
                            <div className="mt-2 rounded-2xl border border-border bg-surface-2 p-3 text-sm text-fg">
                                <b>📍 Añadir punto:</b> click donde quieras (dentro o
                                fuera). Se inserta en el borde más cercano.
                                <div className="mt-2">
                                    <IconButton
                                        icon="✕"
                                        variant="danger"
                                        onClick={() => setAddPointArmed(false)}
                                    >
                                        Cancelar
                                    </IconButton>
                                </div>
                            </div>
                        )}

                        {deleteTableArmed && (
                            <div className="mt-2 rounded-2xl border border-danger/30 bg-danger-soft p-3 text-sm text-rose-900">
                                <b>🗑️ Borrar mesa:</b> haz click encima de una mesa
                                para eliminarla.
                                <div className="mt-2">
                                    <IconButton
                                        icon="✕"
                                        variant="danger"
                                        onClick={() => setDeleteTableArmed(false)}
                                    >
                                        Cancelar
                                    </IconButton>
                                </div>
                            </div>
                        )}

                        {dirty && (
                            <div className="mt-2 rounded-2xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
                                <b>⚠️ Cambios sin guardar</b> — pulsa{" "}
                                <b>Guardar layout</b> para no perderlos.
                            </div>
                        )}
                    </div>
                </div>

                <div className="rounded-2xl border border-border bg-surface shadow-sm overflow-hidden">
                    <div className="w-full h-full p-3">
                        <div
                            ref={canvasBoxRef}
                            className="w-full h-full rounded-2xl border border-border overflow-hidden bg-surface"
                        >
                            {!activeSalon ? (
                                <div className="w-full h-full grid place-items-center text-fg-muted">
                                    {loadingDb
                                        ? "Cargando…"
                                        : "Crea una zona para empezar."}
                                </div>
                            ) : (
                                <Stage
                                    ref={stageRef}
                                    width={canvasSize.width}
                                    height={canvasSize.height}
                                    onWheel={handleWheel}
                                    onMouseDown={handleStageMouseDown}
                                    onMouseMove={onStageMouseMove}
                                    onMouseUp={onStageMouseUp}
                                    onMouseLeave={onStageMouseUp}
                                    style={{
                                        cursor:
                                            addPointArmed ||
                                                placeTableByClick ||
                                                deleteTableArmed
                                                ? "crosshair"
                                                : isPanningRef.current
                                                    ? "grabbing"
                                                    : "default",
                                        background: dark ? "#17191f" : "#ffffff",
                                    }}
                                >
                                    <Layer ref={layerRef}>
                                        <Group
                                            x={viewPos.x}
                                            y={viewPos.y}
                                            scaleX={viewScale}
                                            scaleY={viewScale}
                                        >
                                            <Rect
                                                x={0}
                                                y={0}
                                                width={WORLD_W}
                                                height={WORLD_H}
                                                fill={dark ? "#17191f" : "#ffffff"}
                                                onMouseDown={onBgMouseDown}
                                            />

                                            <Text
                                                text={activeSalon.name}
                                                x={20}
                                                y={16}
                                                fontSize={20}
                                                fill={dark ? "#e7e9ee" : "#0f172a"}
                                                opacity={0.95}
                                            />
                                            <Text
                                                text={`Mesas: ${activeTables.length} · Zoom: ${Math.round(
                                                    viewScale * 100,
                                                )}%`}
                                                x={20}
                                                y={42}
                                                fontSize={13}
                                                fill="#64748b"
                                            />

                                            <RoomEditor />
                                            {activeTables.map((t) => (
                                                <TableNode key={t.id} table={t} />
                                            ))}
                                        </Group>
                                    </Layer>
                                </Stage>
                            )}
                        </div>

                        <div className="mt-3 text-xs text-fg-muted">
                            • Zoom con rueda. • Mover mapa arrastrando el fondo. •
                            Deshacer revierte mesas y paredes.
                        </div>
                    </div>
                </div>
            </div>

            <Modal
                open={addTableOpen}
                title="Añadir mesa"
                onClose={() => setAddTableOpen(false)}
            >
                <div className="grid grid-cols-2 gap-3">
                    <div className="col-span-2">
                        <div className="text-xs font-semibold text-fg-muted mb-1">
                            Nombre / Nº mesa
                        </div>
                        <input
                            value={tableForm.name}
                            onChange={(e) =>
                                setTableForm((p) => ({ ...p, name: e.target.value }))
                            }
                            className="h-10 w-full rounded-xl border border-border bg-surface px-3 text-sm text-fg outline-none focus:border-accent"
                            placeholder="Ej: M12"
                        />
                    </div>

                    <div>
                        <div className="text-xs font-semibold text-fg-muted mb-1">
                            Comensales
                        </div>
                        <input
                            type="number"
                            value={tableForm.seats}
                            onChange={(e) =>
                                setTableForm((p) => ({
                                    ...p,
                                    seats: Number(e.target.value),
                                }))
                            }
                            className="h-10 w-full rounded-xl border border-border bg-surface px-3 text-sm text-fg outline-none focus:border-accent"
                            min={1}
                        />
                    </div>

                    <div>
                        <div className="text-xs font-semibold text-fg-muted mb-1">
                            Forma
                        </div>
                        <select
                            value={tableForm.shape}
                            onChange={(e) =>
                                setTableForm((p) => ({
                                    ...p,
                                    shape: e.target.value as TableShape,
                                }))
                            }
                            className="h-10 w-full rounded-xl border border-border bg-surface px-3 text-sm text-fg outline-none focus:border-accent"
                        >
                            <option value="rounded">Rect redondeada</option>
                            <option value="rect">Recta</option>
                            <option value="circle">Circular</option>
                        </select>
                    </div>

                    <div className="col-span-2">
                        <div className="text-xs font-semibold text-fg-muted mb-1">
                            Tamaño
                        </div>
                        <div className="flex gap-2">
                            <Chip
                                active={tableForm.size === "S"}
                                onClick={() =>
                                    setTableForm((p) => ({ ...p, size: "S" }))
                                }
                            >
                                S
                            </Chip>
                            <Chip
                                active={tableForm.size === "M"}
                                onClick={() =>
                                    setTableForm((p) => ({ ...p, size: "M" }))
                                }
                            >
                                M
                            </Chip>
                            <Chip
                                active={tableForm.size === "L"}
                                onClick={() =>
                                    setTableForm((p) => ({ ...p, size: "L" }))
                                }
                            >
                                L
                            </Chip>
                        </div>

                        <div className="mt-2 text-xs text-fg-muted">
                            {(() => {
                                const d = sizeToDims(
                                    tableForm.shape,
                                    tableForm.size,
                                );
                                return tableForm.shape === "circle"
                                    ? `Radio aprox: ${Math.round(d.radius ?? 0)} px`
                                    : `Dimensiones: ${d.width}×${d.height} px`;
                            })()}
                        </div>
                    </div>

                    <div className="col-span-2">
                        <div className="text-xs font-semibold text-fg-muted mb-1">
                            Colocación
                        </div>
                        <div className="flex gap-2">
                            <Chip
                                active={tableForm.placement === "auto"}
                                onClick={() =>
                                    setTableForm((p) => ({
                                        ...p,
                                        placement: "auto",
                                    }))
                                }
                            >
                                Automática
                            </Chip>
                            <Chip
                                active={tableForm.placement === "click"}
                                onClick={() =>
                                    setTableForm((p) => ({
                                        ...p,
                                        placement: "click",
                                    }))
                                }
                            >
                                Elegir con click
                            </Chip>
                        </div>
                    </div>

                    <div className="col-span-2 pt-2 flex items-center justify-end gap-2 border-t border-border mt-1">
                        <IconButton
                            icon="✕"
                            variant="danger"
                            onClick={() => setAddTableOpen(false)}
                        >
                            Cancelar
                        </IconButton>

                        <IconButton
                            icon="✅"
                            variant="primary"
                            onClick={() => {
                                const dims = sizeToDims(
                                    tableForm.shape,
                                    tableForm.size,
                                );

                                const t: Table = {
                                    id: `table-${Date.now()}-${Math.floor(
                                        Math.random() * 1000,
                                    )}`,
                                    name:
                                        tableForm.name.trim() ||
                                        `Mesa ${activeTables.length + 1}`,
                                    x: 0,
                                    y: 0,
                                    width: dims.width,
                                    height: dims.height,
                                    radius: dims.radius,
                                    seats: Math.max(
                                        1,
                                        Number(tableForm.seats) || 4,
                                    ),
                                    shape: tableForm.shape,
                                };

                                setAddTableOpen(false);
                                setDeleteTableArmed(false);

                                if (tableForm.placement === "click") {
                                    finalizeAddTableByClick(t);
                                } else {
                                    finalizeAddTableAuto(t);
                                }
                            }}
                        >
                            Crear mesa
                        </IconButton>
                    </div>
                </div>
            </Modal>
        </div>
    );
}