import React, { useMemo } from "react";
import ReactApexChart from "react-apexcharts";
import type { ApexOptions } from "apexcharts";

import {
  type ProveedoresStatsResponse,
  type StatsRange,
} from "./statsApis";
import { useProveedoresStats } from "./statsQueries";

/* =========================
   Helpers
========================= */
function formatEur(n: number) {
  return new Intl.NumberFormat("es-ES", {
    style: "currency",
    currency: "EUR",
    maximumFractionDigits: 2,
  }).format(Number.isFinite(n) ? n : 0);
}

function rangeLabel(r: StatsRange) {
  if (r === "hoy") return "Hoy";
  if (r === "semana") return "Semana";
  if (r === "mes") return "Mes";
  return "Año";
}

function clamp(n: number, a: number, b: number) {
  return Math.max(a, Math.min(b, n));
}

/* =========================
   UI helpers
========================= */
function ChartCard({
  title,
  subtitle,
  loading,
  emptyText,
  heightClass = "min-h-[320px]",
  children,
}: {
  title: string;
  subtitle?: string;
  loading?: boolean;
  emptyText?: string;
  heightClass?: string;
  children: React.ReactNode;
}) {
  return (
    <section
      className={[
        "bg-blanco rounded-xl shadow-xs border border-black/5",
        "p-4 flex flex-col min-w-0",
        heightClass,
      ].join(" ")}
    >
      <header className="min-w-0">
        <h4 className="text-base font-extrabold text-negro truncate">{title}</h4>
        {subtitle ? <p className="text-sm text-negro/60 truncate">{subtitle}</p> : null}
      </header>

      <div className="mt-3 flex-1 min-h-0 overflow-hidden">
        {loading ? (
          <div className="h-full flex items-center justify-center text-sm text-negro/50">
            Cargando…
          </div>
        ) : (
          children
        )}

        {!loading && emptyText ? <div className="mt-2 text-xs text-negro/40">{emptyText}</div> : null}
      </div>
    </section>
  );
}

function KPICard({
  label,
  value,
  sub,
}: {
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
}) {
  return (
    <div className="bg-blanco rounded-xl shadow-xs p-4 border border-black/5 min-w-0">
      <p className="text-sm text-negro/60 truncate">{label}</p>
      <p className="text-2xl font-extrabold text-negro mt-1 truncate">{value}</p>
      {sub ? <div className="text-xs text-negro/40 mt-1 min-w-0">{sub}</div> : null}
    </div>
  );
}

/* =========================
   Componente
========================= */
export default function ProveedoresStats({ range }: { range: StatsRange }) {
  const query = useProveedoresStats(range);

  const data: ProveedoresStatsResponse | null = query.data ?? null;
  const loading = query.isFetching;
  const error = query.isError
    ? (query.error as any)?.message || String(query.error)
    : null;

  const cargar = () => query.refetch();

  const BLUE = "#0ea5e9";

  const total = data?.total_gasto ?? 0;
  const numGastos = data?.num_gastos ?? 0;
  const gastoMedio = data?.gasto_medio ?? (numGastos > 0 ? total / numGastos : 0);
  const pctSobreTotalGastos = data?.porcentaje_sobre_total_gastos ?? 0;

  const topProvName = data?.proveedor_top?.nombre ?? "—";
  const topProvTotal = data?.proveedor_top?.total ?? 0;

  const pctTop = useMemo(() => {
    if (total <= 0) return 0;
    return clamp(Math.round((topProvTotal / total) * 100), 0, 100);
  }, [topProvTotal, total]);

  const evoLabels = data?.gastos_evolucion?.labels ?? [];
  const evoValues = data?.gastos_evolucion?.values ?? [];

  const provLabels = data?.gasto_por_proveedor?.labels ?? [];
  const provValues = data?.gasto_por_proveedor?.values ?? [];

  const evoSeries = useMemo(() => [{ name: "Gasto proveedores", data: evoValues }], [evoValues]);

  const evoOptions: ApexOptions = useMemo(
    () => ({
      chart: {
        type: "line",
        toolbar: { show: false },
        zoom: { enabled: false },
        fontFamily: "inherit",
        animations: { enabled: true },
      },
      colors: [BLUE],
      grid: { strokeDashArray: 4 },
      dataLabels: { enabled: false },
      stroke: { width: 3, curve: "smooth" },
      xaxis: {
        categories: evoLabels,
        labels: {
          rotate: -35,
          hideOverlappingLabels: true,
          trim: true,
          style: { fontSize: "12px" },
        },
      },
      yaxis: { labels: { formatter: (v: number) => formatEur(v) } },
      tooltip: {
        shared: true,
        fillSeriesColor: false,
        y: { formatter: (v: number) => formatEur(v), title: { formatter: () => "Gasto" } },
      },
      legend: {
        show: true,
        labels: { useSeriesColors: false },
        markers: { width: 10, height: 10, strokeWidth: 0 } as any,
      } as any,
    }),
    [evoLabels],
  );

  const barsHeight = useMemo(() => {
    const estimated = provLabels.length * 34 + 120;
    return Math.max(320, Math.min(760, estimated));
  }, [provLabels.length]);

  const barsSeries = useMemo(() => [{ name: "Total", data: provValues }], [provValues]);

  const barsOptions: ApexOptions = useMemo(
    () => ({
      chart: {
        type: "bar",
        toolbar: { show: false },
        fontFamily: "inherit",
        animations: { enabled: true },
      },
      colors: [BLUE],
      plotOptions: {
        bar: {
          horizontal: true,
          borderRadius: 8,
          barHeight: "70%",
        },
      },
      stroke: { width: 0 },
      dataLabels: { enabled: false },
      grid: { strokeDashArray: 4 },
      xaxis: {
        categories: provLabels,
        labels: { trim: true, style: { fontSize: "12px" } },
      },
      tooltip: {
        shared: false,
        fillSeriesColor: false,
        marker: { show: true },
        y: { formatter: (v: number) => formatEur(v), title: { formatter: () => "Total" } },
      },
      legend: {
        show: true,
        labels: { useSeriesColors: false },
        markers: { width: 10, height: 10, strokeWidth: 0 } as any,
      } as any,
    }),
    [provLabels],
  );

  const ultimos = data?.ultimos_gastos ?? [];

  return (
    <div className="w-full h-full min-h-0 flex flex-col gap-4">
      <div className="bg-blanco rounded-xl shadow-xs p-4 border border-black/5 min-w-0">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div className="min-w-0">
            <h3 className="text-lg font-bold text-negro truncate">Proveedores</h3>
            <p className="text-sm text-negro/60 truncate">
              Gasto a proveedores, top proveedor, evolución y reparto · Rango: {rangeLabel(range)}
            </p>
          </div>

          <div className="flex items-center justify-between sm:justify-end gap-3">
            <span className="text-xs text-negro/50">{loading ? "Cargando…" : "Actualizado"}</span>
            <button
              onClick={() => void cargar()}
              disabled={loading}
              className="px-3 py-2 rounded-lg bg-white border border-black/10 shadow-xs text-sm font-semibold hover:opacity-90 disabled:opacity-60 whitespace-nowrap"
              title="Recargar"
            >
              Recargar
            </button>
          </div>
        </div>
      </div>

      {error ? (
        <div className="bg-blanco rounded-xl shadow-xs p-4 border border-rose-200 text-rose-700 min-w-0">
          <p className="font-bold">Error</p>
          <p className="text-sm break-words">{error}</p>
        </div>
      ) : null}

      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4 min-w-0">
        <KPICard label="Gasto total a proveedores" value={formatEur(total)} />

        <KPICard
          label="Proveedor top"
          value={topProvName}
          sub={
            <span className="truncate block">
              {formatEur(topProvTotal)} · {pctTop}% del total
            </span>
          }
        />

        <KPICard
          label="Nº gastos a proveedores"
          value={numGastos}
          sub={<span className="truncate block">{pctSobreTotalGastos.toFixed(2)}% del total de gastos</span>}
        />

        <KPICard
          label="Gasto medio / gasto"
          value={formatEur(gastoMedio)}
          sub={<span className="truncate block">total / nº gastos</span>}
        />
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4 flex-1 min-h-0 min-w-0">
        <ChartCard
          title="Evolución del gasto en proveedores"
          subtitle="Gasto por hora/día/mes (según el rango)"
          loading={loading}
          heightClass="min-h-[340px]"
          emptyText={
            range === "hoy"
              ? "Nota: si Cuentas_Gastos.Fecha es DATE (sin hora), en 'Hoy' todo cae en la hora 00."
              : undefined
          }
        >
          {evoLabels.length === 0 ? (
            <div className="h-full flex items-center justify-center text-sm text-negro/50">
              No hay datos para este rango.
            </div>
          ) : (
            <div className="w-full h-full [&_.apexcharts-tooltip-marker]:!rounded-full">
              <ReactApexChart type="line" height={320} options={evoOptions} series={evoSeries as any} />
            </div>
          )}
        </ChartCard>

        <ChartCard
          title="Reparto del gasto por proveedor"
          subtitle="Cuánto has gastado en cada proveedor"
          loading={loading}
          heightClass="min-h-[340px]"
        >
          {provLabels.length === 0 ? (
            <div className="h-full flex items-center justify-center text-sm text-negro/50">
              No hay gastos de proveedor en este rango.
            </div>
          ) : (
            <div className="w-full min-h-0 overflow-auto pr-1 [&_.apexcharts-tooltip-marker]:!rounded-full">
              <ReactApexChart type="bar" height={barsHeight} options={barsOptions} series={barsSeries as any} />
            </div>
          )}
        </ChartCard>

        <div className="xl:col-span-2 min-h-0 min-w-0">
          <ChartCard
            title="Últimos gastos a proveedores"
            subtitle="Movimientos recientes"
            loading={loading}
            heightClass="min-h-[260px]"
          >
            {ultimos.length === 0 ? (
              <div className="h-full flex items-center justify-center text-sm text-negro/50">
                No hay movimientos recientes en este rango.
              </div>
            ) : (
              <div className="w-full overflow-auto">
                <table className="w-full text-sm">
                  <thead className="text-negro/70">
                    <tr className="border-b border-black/10">
                      <th className="text-left font-bold py-2 pr-3 whitespace-nowrap">Fecha</th>
                      <th className="text-left font-bold py-2 pr-3 whitespace-nowrap">Proveedor</th>
                      <th className="text-left font-bold py-2 pr-3 min-w-[240px]">Concepto</th>
                      <th className="text-right font-bold py-2 whitespace-nowrap">Importe</th>
                    </tr>
                  </thead>
                  <tbody>
                    {ultimos.map((g, i) => (
                      <tr key={i} className="border-b border-black/5">
                        <td className="py-2 pr-3 whitespace-nowrap text-negro/80">{g.fecha}</td>
                        <td className="py-2 pr-3 whitespace-nowrap font-semibold text-negro">{g.proveedor}</td>
                        <td className="py-2 pr-3 text-negro/80">{g.concepto}</td>
                        <td className="py-2 text-right whitespace-nowrap font-bold text-negro">
                          {formatEur(g.importe)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </ChartCard>
        </div>
      </div>
    </div>
  );
}