import React, { useEffect, useMemo, useRef, useState } from "react";
import { Stage, Layer, Rect, Group, Text } from "react-konva";
import { toAppError } from "@tpv/client";
import {
    mesasLoadLayout,
    mesasSaveLayout,
} from "../../../features/mesasComponents/mesasApi";
import { mesasKeys } from "../../../features/mesasComponents/mesasQueries";
import { queryClient } from "../../../shared/lib/queryClient";
import { useLocation, useNavigate } from "react-router-dom";
import { useTheme } from "../../../shared/stores/useTheme";
import { conAviso } from "../../../shared/lib/conAviso";
import { useToast } from "../../../shared/toast";
import { TableNode, RoomEditor, type ContextoEditor } from "../../../features/mesas/editor/NodosEditor";
import { clamp, getTableBBox, isTableInsidePolygon, findInsidePosition, insertPointAtNearestEdge,
    type Salon, type Table, type TableShape, type TableSize, type RoomPoly } from "../../../features/mesas/editor/geometria";

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
        "h-10 min-w-0 justify-center px-3 sm:px-4 rounded-xl border text-xs sm:text-sm font-semibold shadow-sm transition inline-flex items-center gap-2 select-none";
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
            <span className="min-w-0 truncate">{children}</span>
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
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/30 p-2 sm:p-4">
            <div className="max-h-[calc(100dvh-1rem)] w-full max-w-[520px] overflow-hidden rounded-2xl border border-border bg-surface shadow-xl sm:max-h-[calc(100dvh-2rem)]">
                <div className="flex items-center justify-between gap-3 border-b border-border p-3 sm:p-4">
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
                <div className="max-h-[calc(100dvh-5.5rem)] overflow-y-auto p-3 sm:p-4">{children}</div>
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

            void navigate(location.pathname, { replace: true });
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
        pendingActionRef.current = () => void navigate(to, opts);
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
    const toast = useToast();
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
        void (async () => {
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
        // Nombre vacío a propósito: es obligatorio que el usuario lo escriba antes de guardar
        // (evita nombres autogenerados que chocaban con el UNIQUE de Zonas).
        const name = "";
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

    function onBgPointerDown(e: any) {
        if (isDraggingSomethingRef.current) return;
        if (addPointArmed || placeTableByClick || deleteTableArmed) return;

        e.cancelBubble = true;

        isPanningRef.current = true;
        const p = getStagePointerScreen();
        if (!p) return;

        panStartRef.current = p;
        viewStartPosRef.current = { ...viewPos };
    }

    function onStagePointerMove() {
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

    function onStagePointerUp() {
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

    function handleStagePointerDown() {
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

    const contextoEditor: ContextoEditor = {
        activeRoom, activeSalonId, roomPointsDraftRef, deleteTableArmed, deleteTableById, isDraggingSomethingRef, isPanningRef, pushHistory, salonsRef, lastValidTableWorldRef, screenToWorld, worldToScreen, updateTablePos, setDirty, dark, roomStrokeLineRef, lastValidVertexWorldRef, PADDING, WORLD_W, WORLD_H, wouldKeepAllTablesInside, syncRoomLines, commitRoomPoints
    };

    return (
        <div className="h-full w-full touch-pan-y overflow-y-auto overscroll-contain bg-surface-2 lg:overflow-hidden">
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

            <div className="grid min-h-full w-full grid-cols-1 gap-3 p-2 sm:p-3 lg:h-full lg:grid-cols-[minmax(320px,360px)_minmax(0,1fr)] lg:gap-4 lg:p-4">
                <div className="flex h-[min(72dvh,46rem)] min-h-[32rem] flex-col gap-3 overflow-hidden rounded-2xl border border-border bg-surface p-3 shadow-sm sm:gap-4 sm:p-4 lg:h-auto lg:min-h-0">
                    <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2">
                        <div className="min-w-0 justify-self-start">
                            <IconButton
                                icon="←"
                                variant="neutral"
                                onClick={() => void guard.guardedNavigate("/Mesas")}
                            >
                                Volver
                            </IconButton>
                        </div>

                        <div className="text-center text-lg font-extrabold text-fg">
                            Zonas
                        </div>
                        <div className="min-w-0 justify-self-end">
                            <IconButton
                                icon="➕"
                                variant="primary"
                                onClick={createNewSalon}
                            >
                                Nueva
                            </IconButton>
                        </div>
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
                                onClick={conAviso(async () => {
                                    try {
                                        // Nombre de zona obligatorio: bloquear el guardado si alguna está vacía.
                                        const sinNombre = salonsRef.current.find(
                                            (s) => !s.name.trim(),
                                        );
                                        if (sinNombre) {
                                            setActiveSalonId(sinNombre.id);
                                            toast.warning("Cada zona necesita un nombre antes de guardar.");
                                            return;
                                        }

                                        await mesasSaveLayout(salonsRef.current as any);
                                        void queryClient.invalidateQueries({ queryKey: mesasKeys.layout() });

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
                                        console.error("No se pudo guardar el layout:", e);
                                        toast.error("No se pudo guardar el plano", toAppError(e).message);
                                    }
                                })}
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

                <div className="h-[clamp(26rem,72dvh,52rem)] min-w-0 overflow-hidden rounded-2xl border border-border bg-surface shadow-sm lg:h-auto">
                    <div className="flex h-full w-full min-h-0 flex-col p-2 sm:p-3">
                        <div
                            ref={canvasBoxRef}
                            className="min-h-0 w-full flex-1 touch-none overflow-hidden rounded-2xl border border-border bg-surface"
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
                                    onPointerDown={handleStagePointerDown}
                                    onPointerMove={onStagePointerMove}
                                    onPointerUp={onStagePointerUp}
                                    onPointerLeave={onStagePointerUp}
                                    onPointerCancel={onStagePointerUp}
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
                                                onPointerDown={onBgPointerDown}
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

                                            <RoomEditor contexto={contextoEditor} />
                                            {activeTables.map((t) => (
                                                <TableNode key={t.id} table={t} contexto={contextoEditor} />
                                            ))}
                                        </Group>
                                    </Layer>
                                </Stage>
                            )}
                        </div>

                        <div className="mt-2 text-[11px] text-fg-muted sm:mt-3 sm:text-xs">
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
