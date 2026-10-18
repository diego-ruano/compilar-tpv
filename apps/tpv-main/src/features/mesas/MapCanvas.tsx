// La sala: el marco y los mensajes de la Main alrededor del plano compartido (`@tpv/plano`).
import React from "react";
import type { MesaMetaOut } from "@tpv/contracts";
import { Lienzo } from "@tpv/plano";

import type { Salon } from "./types";
import { aspectoDeMesa } from "./aspectoMesa";
import { parseMesaId } from "./ParseMesaId";
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
    mesaMetaById: Record<number, MesaMetaOut>;
    onOpenMesa: (mesaId: string, mesaNombre: string) => void;
}) {
    const dark = useTheme((s) => s.theme === "dark");

    // Colores del lienzo según el tema (Konva necesita valores literales).
    const canvasBg = dark ? "#17191f" : "#ffffff";
    const roomStroke = dark ? "rgba(148,163,184,0.45)" : "rgba(15,23,42,0.55)";

    return (
        <div className="mt-3 min-h-0 w-full flex-1 overflow-hidden rounded-2xl border border-border bg-surface sm:mt-4">
            <div ref={mapBoxRef} className="h-full min-h-0 w-full">
                {loading ? (
                    <div className="grid h-full w-full place-items-center text-fg-muted">Cargando…</div>
                ) : !activeSalon ? (
                    <div className="grid h-full w-full place-items-center text-fg-muted">No hay salones guardados.</div>
                ) : (
                    <Lienzo
                        salon={activeSalon}
                        tamano={mapSize}
                        vista={view}
                        fondo={canvasBg}
                        bordeSalon={roomStroke}
                        aspecto={(t) => aspectoDeMesa(t, mesaMetaById as any, dark)}
                        onPulsarMesa={(t) => {
                            const idMesa = parseMesaId(t.id);
                            if (idMesa) onOpenMesa(idMesa, t.name);
                        }}
                    />
                )}
            </div>
        </div>
    );
}
