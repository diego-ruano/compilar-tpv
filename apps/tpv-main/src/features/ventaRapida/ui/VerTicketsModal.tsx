// src/features/ventaRapida/ui/VerTicketsModal.tsx
import React, { useEffect, useMemo, useState, useCallback, useRef } from "react";
import { cn, eur } from "../utils";

import {
  type IndexRow as ApiIndexRow,
  type VerTicketsDetalleRow as ApiDetalleRow,
} from "../ventaRapidaAPI";

import { vrGetIndexRows, vrGetDetallesVerTicket } from "../ventaRapidaAPI";

export type VentaRapidaComandaBarraRow = {
  ID_Comanda: number;
  Fecha_Hora_Apertura: string;
  Estado: "Abierta" | "Pagada" | string;

  Total_Pendiente: number;
  Total_Comanda: number;

  Pendientes_Cocina: number;
  Pendientes_Pago: number;
};

type LineaDetalleUI = ApiDetalleRow;
type IndexRow = ApiIndexRow;

function parseWhen(fecha: string) {
  const t = Date.parse(fecha);
  return Number.isFinite(t) ? new Date(t) : new Date();
}

function isTodayLocal(dt: Date) {
  const now = new Date();
  return (
    dt.getFullYear() === now.getFullYear() &&
    dt.getMonth() === now.getMonth() &&
    dt.getDate() === now.getDate()
  );
}

function estadoTicket(c: VentaRapidaComandaBarraRow) {
  const pendPago = Number(c.Total_Pendiente ?? 0);
  if (pendPago <= 0) return "COBRADO";

  const pendCocina = Number(c.Pendientes_Cocina ?? 0);
  if (pendCocina > 0) return "PEDIDO";

  return "PREPARADO";
}

function asArray<T>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[];

  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;

    if (Array.isArray(obj.data)) return obj.data as T[];
    if (Array.isArray(obj.rows)) return obj.rows as T[];
    if (Array.isArray(obj.result)) return obj.result as T[];
    if (Array.isArray(obj.comandas)) return obj.comandas as T[];
    if (Array.isArray(obj.items)) return obj.items as T[];
  }

  return [];
}

type Filtro = "RECIENTES" | "COBRADOS" | "PREPARADOS" | "PEDIDOS";

export default function VerTicketsModal({
  open,
  onClose,
  comandas,
  onOpenTicket,
  onDeleteTicket,
  onCobrarTicket,
}: {
  open: boolean;
  onClose: () => void;
  comandas: VentaRapidaComandaBarraRow[];

  onOpenTicket: (idComanda: string) => void;
  onDeleteTicket: (idComanda: string) => void;
  onCobrarTicket: (idComanda: string) => void | Promise<void>;
}) {
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [detallesByComanda, setDetallesByComanda] = useState<Record<number, LineaDetalleUI[]>>({});
  const [loadingDetallesId, setLoadingDetallesId] = useState<number | null>(null);

  const [filtro, setFiltro] = useState<Filtro>("RECIENTES");

  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const s = debouncedSearch.trim();

  useEffect(() => {
    const t = window.setTimeout(() => setDebouncedSearch(search), 250);
    return () => window.clearTimeout(t);
  }, [search]);

  const [loadingIndex, setLoadingIndex] = useState(false);
  const [showIndexHint, setShowIndexHint] = useState(false);
  const [indexByComanda, setIndexByComanda] = useState<Record<number, IndexRow>>({});
  const indexRunIdRef = useRef(0);

  useEffect(() => {
    if (!loadingIndex) {
      setShowIndexHint(false);
      return;
    }
    const t = window.setTimeout(() => setShowIndexHint(true), 300);
    return () => window.clearTimeout(t);
  }, [loadingIndex]);

  const baseRows = useMemo(() => {
    const listaComandas = asArray<VentaRapidaComandaBarraRow>(comandas);

    const filtered = listaComandas
      .map((c) => ({ c, dt: parseWhen(c.Fecha_Hora_Apertura) }))
      .filter(({ dt }) => isTodayLocal(dt));

    return filtered.map(({ c, dt }) => {
      const totalPendiente = Math.round(Number(c.Total_Pendiente ?? 0) * 100) / 100;
      const total = Math.round(Number(c.Total_Comanda ?? 0) * 100) / 100;
      const est = estadoTicket(c);

      const when = dt.toLocaleString("es-ES", {
        day: "2-digit",
        month: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      });

      return {
        c,
        dt,
        when,
        totalPendiente,
        total,
        est,
        pendientesCocina: Number(c.Pendientes_Cocina ?? 0),
        pendientesPago: Number(c.Pendientes_Pago ?? 0),
      };
    });
  }, [comandas]);

  const prefetchIndex = useCallback(
    async (idsHoy: number[]) => {
      if (!idsHoy.length) return;
      if (loadingIndex) return;

      const runId = ++indexRunIdRef.current;

      setLoadingIndex(true);
      try {
        const rows = await vrGetIndexRows(idsHoy);
        const safeRows = asArray<IndexRow>(rows);

        if (indexRunIdRef.current !== runId) return;

        const map: Record<number, IndexRow> = {};
        for (const r of safeRows) {
          map[Number(r.ID_Comanda)] = {
            ID_Comanda: Number(r.ID_Comanda),
            Productos: r.Productos ?? null,
            NumLineas: Number((r as any).NumLineas ?? 0),
            Unidades: Number((r as any).Unidades ?? 0),
          };
        }
        setIndexByComanda((prev) => ({ ...prev, ...map }));
      } catch (e) {
        console.error("prefetchIndex error:", e);
      } finally {
        if (indexRunIdRef.current === runId) setLoadingIndex(false);
      }
    },
    [loadingIndex],
  );

  useEffect(() => {
    if (!open) {
      setExpandedId(null);
      setLoadingDetallesId(null);
      setSearch("");
      setDebouncedSearch("");
      setFiltro("RECIENTES");
      setShowIndexHint(false);
      setLoadingIndex(false);
      indexRunIdRef.current++;
      return;
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    if (!s) return;

    const idsHoy = baseRows
      .map((r) => Number(r.c.ID_Comanda))
      .filter((n) => Number.isFinite(n));

    void prefetchIndex(idsHoy);
  }, [open, s, baseRows, prefetchIndex]);

  const loadDetalles = useCallback(async (idComanda: number) => {
    setLoadingDetallesId(idComanda);
    try {
      const det = await vrGetDetallesVerTicket(idComanda);
      const safeDet = asArray<LineaDetalleUI>(det);
      setDetallesByComanda((prev) => ({ ...prev, [idComanda]: safeDet }));
    } catch (e) {
      console.error("Error loadDetalles:", e);
      setDetallesByComanda((prev) => ({ ...prev, [idComanda]: [] }));
    } finally {
      setLoadingDetallesId(null);
    }
  }, []);

  useEffect(() => {
    if (!open) return;

    const onChanged = () => {
      if (expandedId == null) return;

      setDetallesByComanda((prev) => {
        const copy = { ...prev };
        delete copy[expandedId];
        return copy;
      });

      void loadDetalles(expandedId);
    };

    window.addEventListener("vr:changed", onChanged);
    return () => window.removeEventListener("vr:changed", onChanged);
  }, [open, expandedId, loadDetalles]);

  const toggleDetalles = useCallback(
    async (idComanda: number) => {
      if (expandedId === idComanda) {
        setExpandedId(null);
        return;
      }
      setExpandedId(idComanda);

      setDetallesByComanda((prev) => {
        const copy = { ...prev };
        delete copy[idComanda];
        return copy;
      });

      await loadDetalles(idComanda);
    },
    [expandedId, loadDetalles],
  );

  const rows = useMemo(() => {
    let out = [...baseRows];

    out = out.filter((r) => {
      if (filtro === "COBRADOS") return r.est === "COBRADO";
      if (filtro === "PREPARADOS") return r.est === "PREPARADO";
      if (filtro === "PEDIDOS") return r.est === "PEDIDO";
      return true;
    });

    if (s) {
      const needle = s.toLowerCase();

      out = out.filter((r) => {
        const id = Number(r.c.ID_Comanda);
        const idx = indexByComanda[id];

        const baseText = [
          String(r.when ?? ""),
          String(r.c.Fecha_Hora_Apertura ?? ""),
          String(r.c.ID_Comanda ?? ""),
          String(r.est ?? ""),
          String(r.c.Estado ?? ""),
          String(r.totalPendiente ?? ""),
          String(r.total ?? ""),
          eur(r.totalPendiente ?? 0),
          eur(r.total ?? 0),
          `cocina ${r.pendientesCocina}`,
          `pago ${r.pendientesPago}`,
          idx?.Productos ?? "",
          idx ? `lineas ${idx.NumLineas}` : "",
          idx ? `unidades ${idx.Unidades}` : "",
        ]
          .join(" · ")
          .toLowerCase();

        return baseText.includes(needle);
      });
    }

    out.sort((a, b) => b.dt.getTime() - a.dt.getTime());
    return out;
  }, [baseRows, filtro, s, indexByComanda]);

  if (!open) return null;

  const pill = (active: boolean) =>
    cn(
      "h-9 px-3 rounded-xl border text-sm font-semibold transition",
      active
        ? "bg-black text-white border-black"
        : "bg-white border-black/10 hover:bg-black/5 text-black/80",
    );

  return (
    <div className="fixed inset-0 z-[80]">
      <button
        type="button"
        className="absolute inset-0 bg-black/30"
        onClick={onClose}
        aria-label="Cerrar"
      />

      <div className="absolute left-1/2 top-1/2 w-[980px] max-w-[94vw] -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-black/10 bg-white shadow-xl overflow-hidden max-h-[calc(100vh-1.5rem)]">
        <div className="p-3 sm:p-4 border-b border-black/10 flex items-start sm:items-center justify-between gap-3">
          <div className="min-w-0">
            <h3 className="text-base sm:text-lg font-bold text-negro">Tickets (Barra) · Hoy</h3>
            <p className="text-xs sm:text-sm text-negro/60">
              Filtra, busca, despliega detalles, abre, cobra o elimina.
            </p>
          </div>

          <button
            type="button"
            onClick={onClose}
            className="px-3 py-2 rounded-xl border border-black/10 bg-white hover:bg-black/5 text-sm font-semibold"
          >
            Cerrar
          </button>
        </div>

        <div className="p-3 sm:p-4 border-b border-black/10">
          <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-3">
            <div className="flex items-center gap-2 flex-wrap">
              <button
                type="button"
                className={pill(filtro === "RECIENTES")}
                onClick={() => setFiltro("RECIENTES")}
              >
                Más recientes
              </button>
              <button
                type="button"
                className={pill(filtro === "PEDIDOS")}
                onClick={() => setFiltro("PEDIDOS")}
              >
                Pedidos
              </button>
              <button
                type="button"
                className={pill(filtro === "PREPARADOS")}
                onClick={() => setFiltro("PREPARADOS")}
              >
                Preparados
              </button>
              <button
                type="button"
                className={pill(filtro === "COBRADOS")}
                onClick={() => setFiltro("COBRADOS")}
              >
                Cobrados
              </button>
            </div>

            <div className="flex items-center gap-2 w-full lg:w-auto min-w-0">
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Buscar por hora, importe, productos, etc…"
                className="w-full lg:w-[360px] rounded-xl border border-black/10 bg-white px-4 py-2.5 outline-none focus:ring-2 focus:ring-black/10"
              />
              {showIndexHint ? (
                <span className="text-xs text-black/50 whitespace-nowrap">
                  Indexando productos…
                </span>
              ) : null}
            </div>
          </div>
        </div>

        <div className="p-3 sm:p-4">
          {rows.length === 0 ? (
            <div className="rounded-xl border border-black/10 bg-white p-4 text-sm text-black/60">
              No hay tickets que coincidan con el filtro/búsqueda (hoy).
            </div>
          ) : (
            <div className="max-h-[70vh] lg:max-h-[72vh] overflow-y-auto pr-1">
              <div className="grid grid-cols-1 gap-3">
                {rows.map(({ c, when, totalPendiente, total, est, pendientesCocina, pendientesPago }) => {
                  const badge =
                    est === "COBRADO"
                      ? "border-emerald-200 bg-emerald-50 text-emerald-800"
                      : est === "PREPARADO"
                        ? "border-sky-200 bg-sky-50 text-sky-800"
                        : "border-amber-200 bg-amber-50 text-amber-900";

                  const estadoComandaBadge =
                    String(c.Estado).toLowerCase() === "pagada"
                      ? "border-emerald-200 bg-emerald-50 text-emerald-800"
                      : "border-black/10 bg-black/5 text-black/70";

                  const isExpanded = expandedId === c.ID_Comanda;
                  const detalles = detallesByComanda[c.ID_Comanda] ?? [];
                  const loadingThis = loadingDetallesId === c.ID_Comanda;

                  return (
                    <div
                      key={c.ID_Comanda}
                      className="rounded-2xl border border-black/10 bg-white overflow-hidden"
                    >
                      <div className="p-3 sm:p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className={cn("text-xs font-bold px-2 py-1 rounded-full border", badge)}>
                              {est}
                            </span>
                            <span
                              className={cn(
                                "text-xs font-bold px-2 py-1 rounded-full border",
                                estadoComandaBadge,
                              )}
                            >
                              {String(c.Estado).toUpperCase()}
                            </span>
                            <p className="text-sm text-black/60">{when}</p>
                          </div>

                          <p className="mt-1 font-bold text-negro truncate">
                            Ticket #{String(c.ID_Comanda)} ·{" "}
                            <span className="text-black/60 font-semibold">
                              cocina {pendientesCocina} · pago {pendientesPago}
                            </span>
                          </p>

                          <p className="mt-1 text-sm text-black/60">
                            Pendiente: <span className="font-bold text-black">{eur(totalPendiente)}</span>
                            <span className="mx-2 text-black/20">·</span>
                            Total: <span className="font-semibold">{eur(total)}</span>
                          </p>
                        </div>

                        <div className="flex flex-wrap items-center gap-2 shrink-0 justify-end">
                          <button
                            type="button"
                            onClick={() => void toggleDetalles(c.ID_Comanda)}
                            className={cn(
                              "px-3 py-2 rounded-xl text-sm font-semibold transition border",
                              "border-black/10 bg-white hover:bg-black/5",
                            )}
                          >
                            {isExpanded ? "Ocultar detalles" : "Más detalles"}
                          </button>

                          <button
                            type="button"
                            onClick={() => onOpenTicket(String(c.ID_Comanda))}
                            className="px-3 py-2 rounded-xl bg-black text-white hover:bg-black/90 text-sm font-semibold"
                          >
                            Abrir
                          </button>

                          <button
                            type="button"
                            onClick={() => onCobrarTicket(String(c.ID_Comanda))}
                            className={cn(
                              "px-3 py-2 rounded-xl text-sm font-semibold transition",
                              totalPendiente > 0
                                ? "bg-white border border-black/10 hover:bg-black/5"
                                : "bg-black/10 text-black/40 cursor-not-allowed",
                            )}
                            disabled={totalPendiente <= 0}
                          >
                            Cobrar
                          </button>

                          <button
                            type="button"
                            onClick={() => onDeleteTicket(String(c.ID_Comanda))}
                            className="px-3 py-2 rounded-xl border border-black/10 text-black/60 hover:bg-rose-50 hover:text-rose-700 hover:border-rose-200 text-sm font-semibold transition"
                          >
                            Eliminar
                          </button>
                        </div>
                      </div>

                      {isExpanded ? (
                        <div className="px-3 sm:px-4 pb-3 sm:pb-4">
                          <div className="rounded-xl border border-black/10 bg-black/[0.02] p-3">
                            {loadingThis ? (
                              <p className="text-sm text-black/60">Cargando productos…</p>
                            ) : detalles.length === 0 ? (
                              <p className="text-sm text-black/60">Este ticket no tiene líneas.</p>
                            ) : (
                              <div className="grid grid-cols-1 gap-2">
                                {detalles.map((d) => {
                                  const estado = String(d.Estado_Cocina ?? "").toUpperCase();
                                  const noCocina = estado === "NO_COCINA";
                                  const cocinaOk = estado === "PREPARADO";

                                  const badgeCocina = noCocina
                                    ? "border-black/10 bg-white text-black/70"
                                    : cocinaOk
                                      ? "border-emerald-200 bg-emerald-50 text-emerald-800"
                                      : "border-amber-200 bg-amber-50 text-amber-900";

                                  const labelCocina = noCocina
                                    ? "NO COCINA"
                                    : cocinaOk
                                      ? "PREPARADO"
                                      : estado || "PENDIENTE";

                                  const badgePago =
                                    d.Pagado === 1
                                      ? "border-emerald-200 bg-emerald-50 text-emerald-800"
                                      : "border-black/10 bg-white text-black/70";

                                  const importe =
                                    Math.round(
                                      Number(d.Cantidad) * Number(d.Precio_Unitario) * 100,
                                    ) / 100;

                                  return (
                                    <div
                                      key={d.ID_Detalle}
                                      className="rounded-xl border border-black/10 bg-white p-3 flex items-start justify-between gap-3"
                                    >
                                      <div className="min-w-0">
                                        <div className="flex items-center gap-2 flex-wrap">
                                          <span
                                            className={cn(
                                              "text-[11px] font-bold px-2 py-1 rounded-full border",
                                              badgeCocina,
                                            )}
                                          >
                                            {labelCocina}
                                          </span>
                                          <span
                                            className={cn(
                                              "text-[11px] font-bold px-2 py-1 rounded-full border",
                                              badgePago,
                                            )}
                                          >
                                            {d.Pagado === 1 ? "PAGADO" : "PAGO PEND."}
                                          </span>
                                          <span className="text-xs text-black/50">#{d.ID_Detalle}</span>
                                        </div>

                                        <p className="mt-1 font-bold text-negro truncate">
                                          {d.Nombre}{" "}
                                          <span className="font-semibold text-black/60">
                                            x{Number(d.Cantidad || 1)}
                                          </span>
                                        </p>

                                        {d.Notas ? (
                                          <p className="mt-1 text-xs text-black/60">
                                            Nota: <span className="font-semibold">{d.Notas}</span>
                                          </p>
                                        ) : null}
                                      </div>

                                      <div className="shrink-0 text-right">
                                        <p className="text-sm font-bold text-negro">{eur(importe)}</p>
                                        <p className="text-xs text-black/50">
                                          {eur(Number(d.Precio_Unitario || 0))} / ud
                                        </p>
                                      </div>
                                    </div>
                                  );
                                })}
                              </div>
                            )}
                          </div>
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}