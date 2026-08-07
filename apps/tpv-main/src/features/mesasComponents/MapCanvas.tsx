// components/mesasComponents/MapCanvas.tsx
import React from "react";
import { Stage, Layer, Rect, Line, Group } from "react-konva";
import type { Salon, MesaMeta } from "./types";
import TableNode from "./TableNode";
import { useTheme } from "../../shared/stores/useTheme";

export default function MapCanvas({
    loading,
    activeSalon,
    mapBoxRef,
    mapSize,
    view,
    mesaMetaById,
    onOpenMesa,
}: {
    loading: boolean;
    activeSalon: Salon | null;
    mapBoxRef: React.RefObject<HTMLDivElement | null>;
    mapSize: { width: number; height: number };
    view: { x: number; y: number; scale: number };
    mesaMetaById: Record<number, MesaMeta>;
    onOpenMesa: (mesaId: string, mesaNombre: string) => void;
}) {
    const dark = useTheme((s) => s.theme === "dark");

    // Colores del lienzo según el tema (Konva necesita valores literales).
    const canvasBg = dark ? "#17191f" : "#ffffff";
    const roomStroke = dark ? "rgba(148,163,184,0.45)" : "rgba(15,23,42,0.55)";

    return (
        <div className="mt-3 min-h-0 w-full flex-1 overflow-hidden rounded-2xl border border-border bg-surface sm:mt-4">
            <div
                ref={mapBoxRef}
                className="h-full min-h-0 w-full"
            >
                {loading ? (
                    <div className="grid h-full w-full place-items-center text-fg-muted">
                        Cargando…
                    </div>
                ) : !activeSalon ? (
                    <div className="grid h-full w-full place-items-center text-fg-muted">
                        No hay salones guardados.
                    </div>
                ) : !mapSize.width || !mapSize.height ? null : (
                    <Stage
                        width={mapSize.width}
                        height={mapSize.height}
                        style={{ background: canvasBg }}
                    >
                        <Layer>
                            <Rect
                                x={0}
                                y={0}
                                width={mapSize.width}
                                height={mapSize.height}
                                fill={canvasBg}
                            />

                            <Group
                                x={view.x}
                                y={view.y}
                                scaleX={view.scale}
                                scaleY={view.scale}
                            >
                                <Line
                                    points={activeSalon.room.points}
                                    closed
                                    stroke={roomStroke}
                                    strokeWidth={2}
                                    lineJoin="round"
                                />

                                {activeSalon.tables.map((t) => (
                                    <TableNode
                                        key={t.id}
                                        table={t}
                                        mesaMetaById={mesaMetaById}
                                        onOpenMesa={onOpenMesa}
                                        dark={dark}
                                    />
                                ))}
                            </Group>
                        </Layer>
                    </Stage>
                )}
            </div>
        </div>
    );
}
