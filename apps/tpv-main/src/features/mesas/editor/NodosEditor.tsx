import type { ComponentRef, RefObject } from "react";
import { Group, Circle, Rect, Text, Line } from "react-konva";
import { clamp, constrainToPolygonSmooth, pointsToXY, type Table, type Salon, type RoomPoly } from "./geometria";

type Punto = { x: number; y: number };

/** Datos y operaciones del editor. Los tipos de componente permanecen estables durante el arrastre. */
export interface ContextoEditor {
    activeRoom: RoomPoly | undefined;
    activeSalonId: string;
    roomPointsDraftRef: RefObject<Record<string, number[]>>;
    deleteTableArmed: boolean;
    deleteTableById: (id: string) => void;
    isDraggingSomethingRef: RefObject<boolean>;
    isPanningRef: RefObject<boolean>;
    pushHistory: (salons: Salon[]) => void;
    salonsRef: RefObject<Salon[]>;
    lastValidTableWorldRef: RefObject<Record<string, Punto>>;
    screenToWorld: (p: Punto) => Punto;
    worldToScreen: (p: Punto) => Punto;
    updateTablePos: (id: string, punto: Punto) => void;
    setDirty: (dirty: boolean) => void;
    dark: boolean;
    roomStrokeLineRef: RefObject<ComponentRef<typeof Line> | null>;
    lastValidVertexWorldRef: RefObject<Record<string, Punto>>;
    PADDING: number;
    WORLD_W: number;
    WORLD_H: number;
    wouldKeepAllTablesInside: (points: number[]) => boolean;
    syncRoomLines: (points: number[]) => void;
    commitRoomPoints: (points: number[]) => void;
}

export function TableNode({ table, contexto }: { table: Table; contexto: ContextoEditor }) {
    const { activeRoom, activeSalonId, roomPointsDraftRef, deleteTableArmed, deleteTableById, isDraggingSomethingRef, isPanningRef, pushHistory, salonsRef, lastValidTableWorldRef, screenToWorld, worldToScreen, updateTablePos, setDirty, dark } = contexto;
    if (!activeRoom) return null;
    const roomPts =
        roomPointsDraftRef.current[activeSalonId] ?? activeRoom.points;

    return (
        <Group
            x={table.x}
            y={table.y}
            draggable={!deleteTableArmed}
            onPointerDown={(e) => {
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
                if (deleteTableArmed) return posScreen;

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

export function RoomEditor({ contexto }: { contexto: ContextoEditor }) {
    const { activeRoom, activeSalonId, roomPointsDraftRef, deleteTableArmed, isDraggingSomethingRef, isPanningRef, pushHistory, salonsRef, screenToWorld, worldToScreen, setDirty, dark, roomStrokeLineRef, lastValidVertexWorldRef, PADDING, WORLD_W, WORLD_H, wouldKeepAllTablesInside, syncRoomLines, commitRoomPoints } = contexto;
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
                        if (deleteTableArmed) return posScreen;

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
