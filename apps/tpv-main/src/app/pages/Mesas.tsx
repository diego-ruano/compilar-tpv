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
        mesaId: string;
        mesaNombre: string;
    } | null>(null);

    const { ref: mapBoxRef, size: mapSize } = useElementSize<HTMLDivElement>();

    const { role, idUsuario } = useAuth();
    const esCocinero = role === "Cocinero";
    const canEditMesas = !(role === "Cocinero" || role === "Camarero");

    // Layout/meta cacheados con TanStack Query (se recargan vía refetch).
    // Se deshabilitan mientras el modal del ticket está abierto: el floor view
    // no es visible, y evitamos refetches innecesarios por cada cambio de línea.
    // Al cerrar el modal, las queries se reactivan y hacen un único refetch.
    const layoutQuery = useMesasLayout({ enabled: !modalOpen });
    const metaQuery = useMesasMesaMeta({ enabled: !modalOpen });

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

    const handleOpenMesa = useCallback((mesaId: string, mesaNombre: string) => {
        setMesaSel({ mesaId, mesaNombre });
        setModalOpen(true);
    }, []);

    const handleReloadAll = () => {
        layoutQuery.refetch();
        metaQuery.refetch();
    };

    return (
        <div className="flex h-full min-h-0 w-full flex-col items-center gap-4 overflow-hidden bg-bg p-3 pt-3 sm:p-6 sm:pt-4 lg:p-10 lg:pt-5">
            <TopBar isCocinero={esCocinero} canEditMesas={canEditMesas} />

            {esCocinero ? (
                <KitchenBoard idUsuarioCocinero={idUsuario} />
            ) : (
                <>
                    <div className="flex min-h-0 w-full flex-1 flex-col rounded-2xl border border-border bg-surface p-4 shadow-sm sm:p-6">
                        <div className="flex shrink-0 flex-wrap items-center gap-4">
                            <h2 className="whitespace-nowrap text-lg font-bold leading-none text-fg">
                                Salones
                            </h2>

                            <SalonTabs
                                salons={salons}
                                activeSalonId={activeSalonId}
                                onChangeSalon={setActiveSalonId}
                            />


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
                                // mesaSel.mesaId es el UUID puro, la clave con la que
                                // mesasLoadMesaMeta indexa el mapa. Lookup directo.
                                (mesaMetaById[mesaSel.mesaId] ?? null) as any
                            }
                            onClose={() => {
                                setModalOpen(false);
                                setMesaSel(null);
                                // Refresca la ocupación del plano UNA sola vez al volver.
                                // Las queries de mesas se deshabilitan mientras el modal está
                                // abierto (el plano no es visible); antes onChanged disparaba un
                                // refetch en cada cambio de línea, redundante y concurrente con la
                                // reactivación de las queries al cerrar. refetch() ignora staleTime,
                                // así que el plano queda fresco aunque el modal se cierre enseguida.
                                metaQuery.refetch();
                            }}
                        />
                    ) : null}
                </>
            )}
        </div>
    );
}
