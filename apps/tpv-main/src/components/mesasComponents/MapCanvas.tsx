// components/mesasComponents/MapCanvas.tsx
import React from "react";
import { Stage, Layer, Rect, Line, Group } from "react-konva";
import type { Salon, MesaMeta } from "./types";
import TableNode from "./TableNode";

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
    onOpenMesa: (mesaId: number, mesaNombre: string) => void;
}) {
    return (
        <div className="mt-6 w-full rounded-2xl border border-black/10 bg-white overflow-hidden">
            <div
                ref={mapBoxRef}
                className="w-full h-[420px] md:h-[480px] lg:h-[520px]"
            >
                {loading ? (
                    <div className="w-full h-full grid place-items-center text-negro/60">
                        Cargando…
                    </div>
                ) : !activeSalon ? (
                    <div className="w-full h-full grid place-items-center text-negro/60">
                        No hay salones guardados.
                    </div>
                ) : (
                    <Stage
                        width={mapSize.width}
                        height={mapSize.height}
                        style={{ background: "#fff" }}
                    >
                        <Layer>
                            <Rect
                                x={0}
                                y={0}
                                width={mapSize.width}
                                height={mapSize.height}
                                fill="#ffffff"
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
                                    stroke="rgba(15,23,42,0.55)"
                                    strokeWidth={2}
                                    lineJoin="round"
                                />

                                {activeSalon.tables.map((t) => (
                                    <TableNode
                                        key={t.id}
                                        table={t}
                                        mesaMetaById={mesaMetaById}
                                        onOpenMesa={onOpenMesa}
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
