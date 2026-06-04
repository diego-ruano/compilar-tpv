// Mesas.tsx
import { useCallback, useEffect, useMemo, useState } from "react";

import MesaComandaModal from "../../features/mesasComponents/MesaComandaModal";

import TopBar from "../../features/mesasComponents/TopBar";
import SalonTabs from "../../features/mesasComponents/SalonTabs";
import MapCanvas from "../../features/mesasComponents/MapCanvas";
import Legend from "../../features/mesasComponents/Legend";
import KitchenBoard from "../../features/mesasComponents/KitchenBoard";

import { fitTransform } from "../../features/mesasComponents/geometry";
import { useElementSize } from "../../features/mesasComponents/useElementSize";
import type { Salon, MesaMeta } from "../../features/mesasComponents/types";
import { useAuth } from "../../shared/stores/useAuth";

import {
    useMesasLayout,
    useMesasMesaMeta,
} from "../../features/mesasComponents/mesasQueries";

type MesaMetaMap = Record<number, MesaMeta> & Record<string, MesaMeta>;

export default function Mesas() {
    const [activeSalonId, setActiveSalonId] = useState<string>("");

    const [modalOpen, setModalOpen] = useState(false);
    const [mesaSel, setMesaSel] = useState<{
        mesaId: number;
        mesaNombre: string;
    } | null>(null);

    const { ref: mapBoxRef, size: mapSize } = useElementSize<HTMLDivElement>();

    const { role, idUsuario } = useAuth();
    const esCocinero = role === "Cocinero";
    const canEditMesas = !(role === "Cocinero" || role === "Camarero");

    // Layout/meta cacheados con TanStack Query (se recargan vía refetch).
    const layoutQuery = useMesasLayout();
    const metaQuery = useMesasMesaMeta();

    const salons = useMemo<Salon[]>(
        () => layoutQuery.data ?? [],
        [layoutQuery.data],
    );
    const mesaMetaById = useMemo<MesaMetaMap>(
        () => (metaQuery.data ?? ({} as any)) as MesaMetaMap,
        [metaQuery.data],
    );
    const loading = layoutQuery.isFetching;

    const loadMesaMeta = () => metaQuery.refetch();

    // Mantener un salón activo válido cuando cambia el layout (equivale al
    // setActiveSalonId(prev => ...) del loader anterior).
    useEffect(() => {
        setActiveSalonId((prev) => {
            if (!salons.length) return "";
            if (prev && salons.some((s) => s.id === prev)) return prev;
            return salons[0].id;
        });
    }, [salons]);

    // Log de errores de carga (equivale a los catch de los loaders anteriores).
    useEffect(() => {
        if (layoutQuery.isError)
            console.error("Error cargando layout:", layoutQuery.error);
        if (metaQuery.isError)
            console.error("Error cargando meta mesas:", metaQuery.error);
    }, [layoutQuery.isError, metaQuery.isError, layoutQuery.error, metaQuery.error]);

    const activeSalon = useMemo(
        () => salons.find((s) => s.id === activeSalonId) ?? null,
        [salons, activeSalonId],
    );

    const view = useMemo(() => {
        if (!activeSalon) return { x: 0, y: 0, scale: 1 };
        return fitTransform(activeSalon, mapSize.width, mapSize.height, 26);
    }, [activeSalon, mapSize.width, mapSize.height]);

    const handleOpenMesa = useCallback((mesaId: number, mesaNombre: string) => {
        setMesaSel({ mesaId, mesaNombre });
        setModalOpen(true);
    }, []);

    const handleReloadAll = () => {
        layoutQuery.refetch();
        metaQuery.refetch();
    };

    return (
        <div className="w-full min-h-full bg-gris flex flex-col p-10 pt-5 gap-4 items-center">
            <TopBar isCocinero={esCocinero} canEditMesas={canEditMesas} />

            {esCocinero ? (
                <KitchenBoard idUsuarioCocinero={idUsuario} />
            ) : (
                <>
                    <div className="w-full h-full bg-blanco rounded-xl p-10 shadow-xs">
                        <div className="flex items-center gap-4">
                            <h2 className="text-xl font-bold whitespace-nowrap leading-none">
                                SALONES
                            </h2>

                            <SalonTabs
                                salons={salons}
                                activeSalonId={activeSalonId}
                                onChangeSalon={setActiveSalonId}
                            />

                            {/* Botones ocultos SOLO visualmente */}
                            <div className="hidden">
                                <button
                                    type="button"
                                    onClick={handleReloadAll}
                                />
                                <button type="button" onClick={loadMesaMeta} />
                            </div>
                        </div>

                        <MapCanvas
                            loading={loading}
                            activeSalon={activeSalon}
                            mapBoxRef={mapBoxRef}
                            mapSize={mapSize}
                            view={view}
                            mesaMetaById={mesaMetaById as any}
                            onOpenMesa={handleOpenMesa}
                        />

                        <Legend />
                    </div>

                    {mesaSel ? (
                        <MesaComandaModal
                            open={modalOpen}
                            mesaId={mesaSel.mesaId}
                            mesaNombre={mesaSel.mesaNombre}
                            mesaMeta={
                                (mesaMetaById[mesaSel.mesaId] ??
                                    mesaMetaById[String(mesaSel.mesaId)] ??
                                    mesaMetaById[`db-mesa-${mesaSel.mesaId}`] ??
                                    null) as any
                            }
                            onClose={() => {
                                setModalOpen(false);
                                setMesaSel(null);
                            }}
                            onChanged={loadMesaMeta}
                        />
                    ) : null}
                </>
            )}
        </div>
    );
}
