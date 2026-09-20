import React, { useEffect, useMemo } from "react";
import ReactApexChart from "react-apexcharts";
import type { ApexOptions } from "apexcharts";

import { useToast } from "../../shared/toast";
import { cn } from "../ventaRapida/utils";

import { APEX_CHART_BASE } from "./apexBase";
import {
    type StatsRange,
    type TrabajadoresStatsResponse,
    type TrabajadorCardStats,
} from "./statsApis";
import { useTrabajadoresStats } from "./statsQueries";
import { CERO, deCentimos, eur as formatEur } from "../../shared/lib/dinero";

/**
 * ✅ NUEVO (frontend):
 * Esperamos que el backend empiece a devolver en cada trabajador:
 *   horas_trabajadas: number
 * calculadas desde fichajes (entrada/salida), sumando turnos partidos sin contar huecos.
 *
 * Para no romper TypeScript si aún no está, lo tratamos como opcional.
 */
type TrabajadorCardStatsExt = TrabajadorCardStats & {
    horas_trabajadas?: number; // total horas en el rango
};


function formatHours(n: number) {
    const v = Number.isFinite(n) ? n : 0;
    return `${v.toFixed(2)} h`;
}

const AVATAR_COLORS = [
    "bg-rose-500",
    "bg-amber-500",
    "bg-emerald-500",
    "bg-sky-500",
    "bg-[#2B81D4]",
    "bg-[#0F2C56]",
    "bg-teal-500",
    "bg-orange-500",
    "bg-lime-500",
    "bg-cyan-500",
];

function avatarColorById(id: string) {
    // Hash estable del id (UUID string) a un índice de color.
    let h = 0;
    for (const ch of String(id || "")) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    const idx = h % AVATAR_COLORS.length;
    return AVATAR_COLORS[idx];
}

function initialFromName(name: string) {
    const s = (name || "").trim();
    return s ? s[0]!.toUpperCase() : "?";
}

function TareasLine({
    asignadas,
    finalizadas,
}: {
    asignadas: number;
    finalizadas: number;
}) {
    return (
        <p className="text-sm text-fg-muted">
            <span className="font-semibold text-fg">Tareas:</span>{" "}
            {finalizadas}/{asignadas}
        </p>
    );
}

function HorasLine({ horas }: { horas: number }) {
    return (
        <p className="text-sm text-fg-muted">
            <span className="font-semibold text-fg">Horas trabajadas:</span>{" "}
            {formatHours(horas)}
        </p>
    );
}

function EmployeeCard({
    w,
    lines,
}: {
    w: TrabajadorCardStatsExt;
    lines: React.ReactNode;
}) {
    const avatarBg = avatarColorById(w.id_trabajador);
    const initial = initialFromName(w.nombre);

    return (
        <div className="bg-surface rounded-xl shadow-sm p-4 border border-border overflow-hidden">
            <div className="flex items-start gap-3">
                <div
                    className={cn(
                        "w-11 h-11 rounded-full flex items-center justify-center text-white font-extrabold shrink-0",
                        avatarBg,
                    )}
                >
                    {initial}
                </div>

                <div className="min-w-0 flex-1">
                    <p className="text-base font-extrabold text-fg truncate">
                        {w.nombre}
                    </p>
                    <p className="text-xs text-fg-subtle truncate">{w.rol}</p>

                    <div className="mt-3 flex flex-col gap-1 min-w-0">
                        {lines}
                    </div>
                </div>
            </div>
        </div>
    );
}

function Section({
    title,
    subtitle,
    children,
}: {
    title: string;
    subtitle: string;
    children: React.ReactNode;
}) {
    return (
        <div className="bg-surface rounded-xl shadow-sm p-4 flex flex-col gap-3 min-h-0 overflow-hidden">
            <div className="min-w-0">
                <h4 className="text-base font-extrabold text-fg truncate">
                    {title}
                </h4>
                <p className="text-sm text-fg-muted truncate">{subtitle}</p>
            </div>
            <div className="min-h-0">{children}</div>
        </div>
    );
}

/**
 * ✅ Leyenda estilo Mesas / foto:
 * - solo circulito de color
 * - texto normal
 * - sin borde en el circulito
 *
 * Nota TS: Apex markers en legend a veces no tipa "radius", por eso any.
 */
function useLegendClean() {
    return useMemo(
        () =>
            ({
                show: true,
                position: "bottom",
                labels: { useSeriesColors: false }, // ✅ texto normal
                markers: {
                    width: 10,
                    height: 10,
                    radius: 999, // ✅ circulito
                    strokeWidth: 0, // ✅ sin borde
                },
            }) as any,
        [],
    );
}

function HorasBarChart({
    title,
    subtitle,
    workers,
    color = "#0ea5e9", // ✅ azul Mesas (sky-500)
}: {
    title: string;
    subtitle: string;
    workers: TrabajadorCardStatsExt[];
    color?: string;
}) {
    const legendClean = useLegendClean();

    const labels = useMemo(() => workers.map((w) => w.nombre), [workers]);
    const values = useMemo(
        () =>
            workers.map((w) =>
                Number.isFinite(w.horas_trabajadas as number)
                    ? Number(w.horas_trabajadas)
                    : 0,
            ),
        [workers],
    );

    const height = useMemo(
        () => Math.max(260, Math.min(620, labels.length * 30)),
        [labels.length],
    );

    const options: ApexOptions = useMemo(
        () => ({
            chart: { ...APEX_CHART_BASE, type: "bar", toolbar: { show: false }, fontFamily: "inherit" },
            colors: [color], // ✅ color directo
            stroke: { width: 0 }, // ✅ sin borde negro
            plotOptions: {
                bar: {
                    horizontal: true,
                    borderRadius: 8,
                    barHeight: "70%",
                },
            },
            dataLabels: { enabled: false },
            grid: { strokeDashArray: 4 },
            xaxis: {
                categories: labels,
                labels: { trim: true },
            },
            yaxis: { labels: { maxWidth: 180 } },
            legend: legendClean,
            tooltip: {
                fillSeriesColor: false, // ✅ no “bloque” de color
                y: {
                    formatter: (val: number) => formatHours(val),
                    title: { formatter: () => "Horas" },
                },
            },
        }),
        [labels, color, legendClean],
    );

    const series = useMemo(() => [{ name: "Horas", data: values }], [values]);

    return (
        <div className="bg-surface rounded-xl border border-border p-4 flex flex-col min-h-0 overflow-hidden">
            <div className="min-w-0">
                <h5 className="text-sm font-extrabold text-fg truncate">
                    {title}
                </h5>
                <p className="text-xs text-fg-subtle truncate">{subtitle}</p>
            </div>

            <div className="mt-3 flex-1 min-h-[260px] overflow-x-auto overflow-y-hidden">
                {labels.length === 0 ? (
                    <div className="flex h-full items-center justify-center text-sm text-fg-subtle">
                        No hay datos de horas en este rango.
                    </div>
                ) : (
                    <div className="h-full min-w-[480px]">
                        <ReactApexChart
                            type="bar"
                            height="100%"
                            options={options}
                            series={series as any}
                        />
                    </div>
                )}
            </div>
        </div>
    );
}

export default function TrabajadoresStats({ range }: { range: StatsRange }) {
    const toast = useToast();

    const query = useTrabajadoresStats(range);

    const data: TrabajadoresStatsResponse | null = query.data ?? null;
    const loading = query.isFetching;

    useEffect(() => {
        if (query.isError) {
            console.error(query.error);
            toast.error(
                "Error",
                "No se pudieron cargar estadísticas de trabajadores.",
            );
        }
    }, [query.isError, query.error, toast]);

    const cocineros = (data?.cocineros ?? []) as TrabajadorCardStatsExt[];
    const camareros = (data?.camareros ?? []) as TrabajadorCardStatsExt[];
    const limpieza = (data?.limpieza ?? []) as TrabajadorCardStatsExt[];

    const legendClean = useLegendClean();

    // ✅ Ranking ventas: mismo azul Mesas
    const rankingLabels = data?.ranking_ventas?.labels ?? [];
    const rankingValues = data?.ranking_ventas?.values ?? [];

    const rankingHeight = useMemo(
        () => Math.max(260, Math.min(560, rankingLabels.length * 28)),
        [rankingLabels.length],
    );

    const rankingOptions: ApexOptions = useMemo(
        () => ({
            chart: { ...APEX_CHART_BASE, type: "bar", toolbar: { show: false }, fontFamily: "inherit" },
            colors: ["#0ea5e9"], // ✅ azul Mesas
            stroke: { width: 0 }, // ✅ sin borde negro
            plotOptions: {
                bar: {
                    horizontal: true,
                    borderRadius: 8,
                    barHeight: "70%",
                },
            },
            dataLabels: { enabled: false },
            grid: { strokeDashArray: 4 },
            xaxis: { categories: rankingLabels, labels: { trim: true } },
            yaxis: { labels: { maxWidth: 180 } },
            legend: legendClean,
            tooltip: {
                fillSeriesColor: false, // ✅ sin “bloque” de color
                y: {
                    formatter: (val: number) => formatEur(deCentimos(val)),
                    title: { formatter: () => "Ventas" },
                },
            },
        }),
        [rankingLabels, legendClean],
    );

    const rankingSeries = useMemo(
        () => [{ name: "Ventas", data: rankingValues }],
        [rankingValues],
    );

    return (
        <div className="w-full h-full flex flex-col gap-4 min-h-0 overflow-hidden">
            {/* Header fijo */}
            <div className="bg-surface rounded-xl shadow-sm p-4 flex items-center justify-between">
                <div className="min-w-0">
                    <h3 className="text-lg font-bold text-fg">
                        Trabajadores
                    </h3>
                    <p className="text-sm text-fg-muted">
                        Rendimiento por rol (comandas, cobros, tareas) +{" "}
                        <span className="font-semibold text-fg-muted">
                            horas trabajadas
                        </span>{" "}
                        (según fichajes).
                    </p>
                </div>

                <div className="text-xs text-fg-subtle shrink-0">
                    {loading ? "Cargando…" : "Actualizado"}
                </div>
            </div>

            {/* Contenido scrollable */}
            <div className="flex-1 min-h-0 overflow-y-auto pr-1">
                <div className="grid grid-cols-1 gap-4 min-h-0">
                    {/* COCINEROS */}
                    <Section
                        title="Cocineros"
                        subtitle="Comandas preparadas · Tareas · Horas trabajadas"
                    >
                        {cocineros.length === 0 ? (
                            <div className="text-sm text-fg-subtle">
                                No hay cocineros o no hay datos en este rango.
                            </div>
                        ) : (
                            <div className="grid grid-cols-1 gap-4 min-h-0 xl:grid-cols-2">
                                <div className="min-h-0">
                                    <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-1 2xl:grid-cols-2">
                                        {cocineros.map((w) => (
                                            <EmployeeCard
                                                key={`cocinero-${w.id_trabajador}`}
                                                w={w}
                                                lines={
                                                    <>
                                                        <p className="text-sm text-fg-muted">
                                                            <span className="font-semibold text-fg">
                                                                Comandas preparadas:
                                                            </span>{" "}
                                                            {w.comandas_preparadas ?? 0}
                                                        </p>
                                                        <TareasLine
                                                            asignadas={w.tareas_asignadas ?? 0}
                                                            finalizadas={w.tareas_finalizadas ?? 0}
                                                        />
                                                        <HorasLine horas={w.horas_trabajadas ?? 0} />
                                                    </>
                                                }
                                            />
                                        ))}
                                    </div>
                                </div>

                                <HorasBarChart
                                    title="Horas trabajadas (cocineros)"
                                    subtitle="Suma de fichajes entrada/salida (sin contar huecos entre turnos)."
                                    workers={cocineros}
                                    color="#0ea5e9"
                                />
                            </div>
                        )}
                    </Section>

                    {/* CAMAREROS */}
                    <Section
                        title="Camareros"
                        subtitle="Comandas tomadas · Cobros · Ticket medio · Tareas · Horas trabajadas + ranking ventas"
                    >
                        {camareros.length === 0 ? (
                            <div className="text-sm text-fg-subtle">
                                No hay camareros o no hay datos en este rango.
                            </div>
                        ) : (
                            <div className="grid grid-cols-1 gap-4 min-h-0 xl:grid-cols-2">
                                {/* Cards + horas */}
                                <div className="min-h-0">
                                    <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-1 2xl:grid-cols-2">
                                        {camareros.map((w) => (
                                            <EmployeeCard
                                                key={`camarero-${w.id_trabajador}`}
                                                w={w}
                                                lines={
                                                    <>
                                                        <p className="text-sm text-fg-muted">
                                                            <span className="font-semibold text-fg">
                                                                Comandas:
                                                            </span>{" "}
                                                            {w.comandas_tomadas ?? 0}
                                                        </p>

                                                        <p className="text-sm text-fg-muted">
                                                            <span className="font-semibold text-fg">
                                                                Cobros:
                                                            </span>{" "}
                                                            {w.cobros_realizados ?? 0}
                                                        </p>

                                                        <p className="text-sm text-fg-muted">
                                                            <span className="font-semibold text-fg">
                                                                Ticket medio:
                                                            </span>{" "}
                                                            {formatEur(w.ticket_medio_eur ?? CERO)}
                                                        </p>

                                                        <TareasLine
                                                            asignadas={w.tareas_asignadas ?? 0}
                                                            finalizadas={w.tareas_finalizadas ?? 0}
                                                        />

                                                        <HorasLine horas={w.horas_trabajadas ?? 0} />
                                                    </>
                                                }
                                            />
                                        ))}
                                    </div>
                                </div>

                                {/* Columna derecha: horas + ranking */}
                                <div className="flex flex-col gap-4 min-h-0">
                                    <HorasBarChart
                                        title="Horas trabajadas (camareros)"
                                        subtitle="Suma de fichajes entrada/salida (sin contar huecos entre turnos)."
                                        workers={camareros}
                                        color="#0ea5e9"
                                    />

                                    <div className="bg-surface rounded-xl border border-border p-4 flex flex-col min-h-0 overflow-hidden">
                                        <div className="min-w-0">
                                            <h5 className="text-sm font-extrabold text-fg truncate">
                                                Ranking de ventas por camarero
                                            </h5>
                                            <p className="text-xs text-fg-subtle truncate">
                                                Total vendido por trabajador (según el rango).
                                            </p>
                                        </div>

                                        <div className="mt-3 flex-1 min-h-0 overflow-auto">
                                            {rankingLabels.length === 0 ? (
                                                <div className="h-full flex items-center justify-center text-sm text-fg-subtle">
                                                    No hay datos de ranking para este rango.
                                                </div>
                                            ) : (
                                                <div className="min-w-[520px]">
                                                    <ReactApexChart
                                                        type="bar"
                                                        height={rankingHeight}
                                                        options={rankingOptions}
                                                        series={rankingSeries as any}
                                                    />
                                                </div>
                                            )}
                                        </div>
                                    </div>
                                </div>
                            </div>
                        )}
                    </Section>

                    {/* LIMPIEZA */}
                    <Section
                        title="Limpieza"
                        subtitle="Tareas · Horas trabajadas"
                    >
                        {limpieza.length === 0 ? (
                            <div className="text-sm text-fg-subtle">
                                No hay personal de limpieza o no hay datos en este rango.
                            </div>
                        ) : (
                            <div className="grid grid-cols-1 gap-4 min-h-0 xl:grid-cols-2">
                                <div className="min-h-0">
                                    <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-1 2xl:grid-cols-2">
                                        {limpieza.map((w) => (
                                            <EmployeeCard
                                                key={`limpieza-${w.id_trabajador}`}
                                                w={w}
                                                lines={
                                                    <>
                                                        <TareasLine
                                                            asignadas={w.tareas_asignadas ?? 0}
                                                            finalizadas={w.tareas_finalizadas ?? 0}
                                                        />
                                                        <HorasLine horas={w.horas_trabajadas ?? 0} />
                                                    </>
                                                }
                                            />
                                        ))}
                                    </div>
                                </div>

                                <HorasBarChart
                                    title="Horas trabajadas (limpieza)"
                                    subtitle="Suma de fichajes entrada/salida (sin contar huecos entre turnos)."
                                    workers={limpieza}
                                    color="#0ea5e9"
                                />
                            </div>
                        )}
                    </Section>
                </div>
            </div>
        </div>
    );
}
