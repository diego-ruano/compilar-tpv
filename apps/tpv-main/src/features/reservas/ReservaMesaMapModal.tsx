// components/reservas/ReservaMesaMapModal.tsx
import { useEffect, useMemo, useRef, useState } from "react";
import { X } from "lucide-react";
import MapCanvas from "../mesasComponents/MapCanvas";
import SalonTabs from "../mesasComponents/SalonTabs";
import type { Salon, MesaMeta } from "../mesasComponents/types";

type Props = {
    open: boolean;
    onClose: () => void;

    salons: Salon[];
    activeSalonId: string;
    onChangeSalon: (id: string) => void;

    mesaMetaById: Record<number, MesaMeta>;

    onSelectMesa: (idMesa: string, nombreMesa: string) => void;

    title?: string;
};

function computeViewToFit(
    salon: Salon | null,
    mapSize: { width: number; height: number },
) {
    // view por defecto
    if (!salon || mapSize.width <= 0 || mapSize.height <= 0) {
        return { x: 0, y: 0, scale: 1 };
    }

    // bounds desde puntos del room + mesas
    let minX = Infinity,
        minY = Infinity,
        maxX = -Infinity,
        maxY = -Infinity;

    const pts = salon.room?.points ?? [];
    for (let i = 0; i < pts.length; i += 2) {
        const x = Number(pts[i] ?? 0);
        const y = Number(pts[i + 1] ?? 0);
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
    }

    for (const t of salon.tables ?? []) {
        const x = Number(t.x ?? 0);
        const y = Number(t.y ?? 0);

        if (t.shape === "circle") {
            const r = Number(t.radius ?? 45);
            minX = Math.min(minX, x);
            minY = Math.min(minY, y);
            maxX = Math.max(maxX, x + r * 2);
            maxY = Math.max(maxY, y + r * 2);
        } else {
            const w = Number(t.width ?? 120);
            const h = Number(t.height ?? 70);
            minX = Math.min(minX, x);
            minY = Math.min(minY, y);
            maxX = Math.max(maxX, x + w);
            maxY = Math.max(maxY, y + h);
        }
    }

    if (!Number.isFinite(minX) || !Number.isFinite(minY)) {
        return { x: 0, y: 0, scale: 1 };
    }

    const padding = 28;
    const contentW = Math.max(1, maxX - minX);
    const contentH = Math.max(1, maxY - minY);

    const scaleX = (mapSize.width - padding * 2) / contentW;
    const scaleY = (mapSize.height - padding * 2) / contentH;
    const scale = Math.max(0.2, Math.min(scaleX, scaleY));

    // centrado
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;

    const x = mapSize.width / 2 - cx * scale;
    const y = mapSize.height / 2 - cy * scale;

    return { x, y, scale };
}

export default function ReservaMesaMapModal({
    open,
    onClose,
    salons,
    activeSalonId,
    onChangeSalon,
    mesaMetaById,
    onSelectMesa,
    title = "SELECCIONAR MESA",
}: Props) {
    const mapBoxRef = useRef<HTMLDivElement | null>(null);
    const [mapSize, setMapSize] = useState({ width: 900, height: 520 });

    const activeSalon = useMemo(
        () => salons.find((s) => s.id === activeSalonId) ?? null,
        [salons, activeSalonId],
    );

    // ResizeObserver para medir el contenedor del canvas
    useEffect(() => {
        if (!open) return;
        const el = mapBoxRef.current;
        if (!el) return;

        const ro = new ResizeObserver(() => {
            const r = el.getBoundingClientRect();
            setMapSize({
                width: Math.max(1, Math.floor(r.width)),
                height: Math.max(1, Math.floor(r.height)),
            });
        });

        ro.observe(el);

        // medida inicial
        const r = el.getBoundingClientRect();
        setMapSize({
            width: Math.max(1, Math.floor(r.width)),
            height: Math.max(1, Math.floor(r.height)),
        });

        return () => ro.disconnect();
    }, [open]);

    const view = useMemo(() => computeViewToFit(activeSalon, mapSize), [activeSalon, mapSize]);

    if (!open) return null;

    return (
        <div
            className="fixed inset-0 z-[999] flex items-center justify-center bg-black/50 p-1.5 sm:p-4"
            onMouseDown={onClose}
        >
            <div
                className="flex max-h-[calc(100dvh-0.75rem)] w-full max-w-6xl flex-col overflow-y-auto rounded-2xl border border-border bg-surface p-2.5 text-fg shadow-xl sm:max-h-[calc(100dvh-2rem)] sm:p-4"
                onMouseDown={(e) => e.stopPropagation()}
            >
                {/* Header */}
                <div className="mb-3 flex items-center justify-between gap-3">
                    <div className="min-w-0 truncate text-sm font-extrabold tracking-widest text-fg sm:text-base">{title}</div>

                    <button
                        type="button"
                        onClick={onClose}
                        className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-danger/30 bg-danger-soft px-3 py-1.5 text-xs font-extrabold tracking-widest text-danger transition hover:opacity-90"
                    >
                        <X className="size-4" aria-hidden />
                        CERRAR
                    </button>
                </div>

                {/* Tabs */}
                <SalonTabs salons={salons} activeSalonId={activeSalonId} onChangeSalon={onChangeSalon} />

                {/* Canvas container */}
                <div className="mt-3 overflow-hidden rounded-2xl border border-border bg-surface-2">
                    {/* OJO: este div es el que MapCanvas usa para medir */}
                    <div ref={mapBoxRef} className="flex h-[clamp(20rem,62dvh,32.5rem)] w-full">
                        <MapCanvas
                            loading={false}
                            activeSalon={activeSalon}
                            mapBoxRef={mapBoxRef}
                            mapSize={mapSize}
                            view={view}
                            mesaMetaById={mesaMetaById}
                            onOpenMesa={(idMesa, mesaNombre) => {
                                onSelectMesa(idMesa, mesaNombre);
                                onClose();
                            }}
                        />
                    </div>
                </div>

                <div className="mt-3 text-xs text-fg-muted">
                    Pulsa una mesa en el mapa para seleccionarla.
                </div>
            </div>
        </div>
    );
}
