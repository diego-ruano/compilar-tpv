import { usePermisos } from "../../shared/lib/usePermisos";
// Mesas.tsx
import { useCallback, useEffect, useMemo, useState } from "react";

import MesaComandaModal from "../../features/mesas/MesaComandaModal";

import TopBar from "../../features/mesas/TopBar";
import SalonTabs from "../../features/mesas/SalonTabs";
import MapCanvas from "../../features/mesas/MapCanvas";
import Legend from "../../features/mesas/Legend";
import KitchenBoard from "../../features/mesas/KitchenBoard";

import { fitTransform } from "../../features/mesas/geometry";
import { useElementSize } from "../../features/mesas/useElementSize";
import type { MesaMetaOut } from "@tpv/contracts";
import type { Salon } from "../../features/mesas/types";
import { useAuth } from "../../shared/stores/useAuth";
import { useMode } from "../../shared/stores/useMode";
import { useToast } from "../../shared/toast";
import { toAppError } from "@tpv/client";

import {
    useMesasLayout,
    useMesasMesaMeta,
} from "../../features/mesas/mesasQueries";

type MesaMetaMap = Record<number, MesaMetaOut> & Record<string, MesaMetaOut>;

export default function Mesas() {
    const [activeSalonId, setActiveSalonId] = useState<string>("");

    const [modalOpen, setModalOpen] = useState(false);
    const [mesaSel, setMesaSel] = useState<{
        mesaId: string;
        mesaNombre: string;
    } | null>(null);

    const { ref: mapBoxRef, size: mapSize } = useElementSize<HTMLDivElement>();

    const { idUsuario } = useAuth();
    const { puede } = usePermisos();
    const toast = useToast();
    const esCocinero = !puede("servicio.vender") && puede("servicio.cocina");
    const canEditMesas = puede("plano.gestionar");

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

    // Un plano que no se ha podido cargar no puede parecer un plano vacío. Se avisa al empezar a
    // fallar, no en cada reintento: las consultas se repiten solas. Si falla al refrescar, sigue
    // a la vista el último plano bueno y no hace falta decir nada.
    useEffect(() => {
        if (layoutQuery.isError && !layoutQuery.data)
            toast.error("No se pudo cargar el plano", toAppError(layoutQuery.error).message);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [layoutQuery.isError]);
    useEffect(() => {
        if (metaQuery.isError)
            toast.error("No se pudo cargar el estado de las mesas", toAppError(metaQuery.error).message);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [metaQuery.isError]);

    const activeSalon = useMemo(
        () => salons.find((s) => s.id === activeSalonId) ?? null,
        [salons, activeSalonId],
    );

    // En la Handy se encajan sólo las mesas: en una pantalla estrecha, con el salón entero salen
    // diminutas. Lo que sobre del contorno se corta por los bordes.
    const soloMesas = useMode((s) => s.mode) === "handy";
    const view = useMemo(() => {
        if (!activeSalon) return { x: 0, y: 0, scale: 1 };
        return fitTransform(activeSalon, mapSize.width, mapSize.height, 26, { soloMesas });
    }, [activeSalon, mapSize.width, mapSize.height, soloMesas]);

    const handleOpenMesa = useCallback((mesaId: string, mesaNombre: string) => {
        setMesaSel({ mesaId, mesaNombre });
        setModalOpen(true);
    }, []);

    const handleReloadAll = () => {
        void layoutQuery.refetch();
        void metaQuery.refetch();
    };

    return (
        <div className="flex h-full min-h-0 w-full touch-pan-y flex-col items-center gap-3 overflow-y-auto overscroll-contain bg-bg p-2 pt-3 sm:gap-4 sm:p-4 lg:overflow-hidden lg:p-6 lg:pt-5">
            <TopBar isCocinero={esCocinero} canEditMesas={canEditMesas} />

            {esCocinero ? (
                <KitchenBoard idUsuarioCocinero={idUsuario} />
            ) : (
                <>
                    <div className="flex h-[clamp(32rem,calc(100dvh-8rem),52rem)] min-h-0 w-full shrink-0 flex-col rounded-2xl border border-border bg-surface p-3 shadow-sm sm:p-4 lg:h-auto lg:flex-1 lg:p-6">
                        <div className="flex shrink-0 flex-col gap-2 sm:flex-row sm:items-center sm:gap-4">
                            <h2 className="whitespace-nowrap text-lg font-bold leading-none text-fg">
                                Salones
                            </h2>

                            <SalonTabs
                                salons={salons}
                                activeSalonId={activeSalonId}
                                onChangeSalon={setActiveSalonId}
                            />

                            <Legend />
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
                                void metaQuery.refetch();
                            }}
                        />
                    ) : null}
                </>
            )}
        </div>
    );
}
