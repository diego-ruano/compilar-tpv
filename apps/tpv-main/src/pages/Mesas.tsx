// Mesas.tsx
import { useCallback, useEffect, useMemo, useState } from "react";

import MesaComandaModal from "../components/mesasComponents/MesaComandaModal";

import TopBar from "../components/mesasComponents/TopBar";
import SalonTabs from "../components/mesasComponents/SalonTabs";
import MapCanvas from "../components/mesasComponents/MapCanvas";
import Legend from "../components/mesasComponents/Legend";
import KitchenBoard from "../components/mesasComponents/KitchenBoard";

import { fitTransform } from "../components/mesasComponents/geometry";
import { useElementSize } from "../components/mesasComponents/useElementSize";
import type { Salon, MesaMeta } from "../components/mesasComponents/types";
import { useAuth } from "../shared/stores/useAuth";

import {
    mesasLoadLayout,
    mesasLoadMesaMeta,
} from "../components/mesasComponents/mesasApi";

type MesaMetaMap = Record<number, MesaMeta> & Record<string, MesaMeta>;

export default function Mesas() {
    const [loading, setLoading] = useState(true);
    const [salons, setSalons] = useState<Salon[]>([]);
    const [activeSalonId, setActiveSalonId] = useState<string>("");

    const [mesaMetaById, setMesaMetaById] = useState<MesaMetaMap>({} as any);

    const [modalOpen, setModalOpen] = useState(false);
    const [mesaSel, setMesaSel] = useState<{
        mesaId: number;
        mesaNombre: string;
    } | null>(null);

    const { ref: mapBoxRef, size: mapSize } = useElementSize<HTMLDivElement>();

    const { role, idUsuario } = useAuth();
    const esCocinero = role === "Cocinero";
    const canEditMesas = !(role === "Cocinero" || role === "Camarero");

    const loadLayout = useCallback(async () => {
        setLoading(true);
        try {
            const cast = await mesasLoadLayout();
            setSalons(cast);
            setActiveSalonId((prev) => {
                if (!cast.length) return "";
                if (prev && cast.some((s) => s.id === prev)) return prev;
                return cast[0].id;
            });
        } catch (e) {
            console.error("Error cargando layout:", e);
            setSalons([]);
            setActiveSalonId("");
        } finally {
            setLoading(false);
        }
    }, []);

    const loadMesaMeta = useCallback(async () => {
        try {
            const map = (await mesasLoadMesaMeta()) as any as MesaMetaMap;
            setMesaMetaById(map);
        } catch (e) {
            console.error("Error cargando meta mesas:", e);
            setMesaMetaById({} as any);
        }
    }, []);

    useEffect(() => {
        (async () => {
            await loadLayout();
            await loadMesaMeta();
        })();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

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

    const handleReloadAll = useCallback(async () => {
        await loadLayout();
        await loadMesaMeta();
    }, [loadLayout, loadMesaMeta]);

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
