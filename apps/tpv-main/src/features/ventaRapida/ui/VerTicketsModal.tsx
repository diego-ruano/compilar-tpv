// src/features/ventaRapida/ui/VerTicketsModal.tsx
import React, { useEffect, useMemo, useState, useCallback, useRef } from "react";
import { Search, ChevronDown, ChevronUp, Trash2, FolderOpen } from "lucide-react";
import { cn } from "../utils";

import type { ComandaBarraRow, IndexRow, VerTicketsDetalleRow } from "@tpv/contracts";

import { vrGetIndexRows, vrGetDetallesVerTicket } from "../ventaRapidaAPI";
import { conAviso } from "../../../shared/lib/conAviso";
import { eur, escalar } from "../../../shared/lib/dinero";

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

function estadoTicket(c: ComandaBarraRow) {
  if (c.Total_Pendiente <= 0) return "COBRADO";
  if (c.Pendientes_Cocina > 0) return "PEDIDO";

  return "PREPARADO";
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
  comandas: ComandaBarraRow[];

  onOpenTicket: (idComanda: string) => void;
  onDeleteTicket: (idComanda: string) => void;
  onCobrarTicket: (idComanda: string) => void | Promise<void>;
}) {
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [detallesByComanda, setDetallesByComanda] = useState<Record<string, VerTicketsDetalleRow[]>>({});
  const [loadingDetallesId, setLoadingDetallesId] = useState<string | null>(null);

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
  const [indexByComanda, setIndexByComanda] = useState<Record<string, IndexRow>>({});
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
    const filtered = comandas
      .map((c) => ({ c, dt: parseWhen(c.Fecha_Hora_Apertura) }))
      .filter(({ dt }) => isTodayLocal(dt));

    return filtered.map(({ c, dt }) => {
      const totalPendiente = c.Total_Pendiente;
      const total = c.Total_Comanda;
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
        pendientesCocina: c.Pendientes_Cocina,
        pendientesPago: c.Pendientes_Pago,
      };
    });
  }, [comandas]);

  const prefetchIndex = useCallback(
    async (idsHoy: string[]) => {
      if (!idsHoy.length) return;
      if (loadingIndex) return;

      const runId = ++indexRunIdRef.current;

      setLoadingIndex(true);
      try {
        const rows = await vrGetIndexRows(idsHoy);

        if (indexRunIdRef.current !== runId) return;

        const map: Record<string, IndexRow> = {};
        for (const r of rows) map[r.ID_Comanda] = r;
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

    const idsHoy = baseRows.map((r) => r.c.ID_Comanda).filter((id) => id.length > 0);

    void prefetchIndex(idsHoy);
  }, [open, s, baseRows, prefetchIndex]);

  const loadDetalles = useCallback(async (idComanda: string) => {
    setLoadingDetallesId(idComanda);
    try {
      const det = await vrGetDetallesVerTicket(idComanda);
      setDetallesByComanda((prev) => ({ ...prev, [idComanda]: det }));
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
    async (idComanda: string) => {
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
        const id = String(r.c.ID_Comanda ?? "");
        const idx = indexByComanda[id];

        const baseText = [
          String(r.when ?? ""),
          String(r.c.Fecha_Hora_Apertura ?? ""),
          String(r.c.ID_Comanda ?? ""),
          String(r.est ?? ""),
          String(r.c.Estado ?? ""),
          String(r.totalPendiente ?? ""),
          String(r.total ?? ""),
          eur(r.totalPendiente),
          eur(r.total),
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
      "h-9 px-3 rounded-xl border text-sm font-semibold transition cursor-pointer",
      active
        ? "bg-accent text-accent-fg border-accent shadow-sm"
        : "bg-surface border-border hover:bg-surface-2 text-fg-muted",
    );

  return (
    <div className="fixed inset-0 z-[80]">
      <button
        type="button"
        className="absolute inset-0 bg-black/50"
        onClick={onClose}
        aria-label="Cerrar"
      />

      <div className="absolute left-1/2 top-1/2 max-h-[calc(100dvh-1.5rem)] w-[980px] max-w-[94vw] -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-2xl border border-border bg-surface text-fg shadow-xl">
        <div className="flex items-start justify-between gap-3 border-b border-border p-3 sm:items-center sm:p-4">
          <div className="min-w-0">
            <h3 className="text-base font-bold text-fg sm:text-lg">Tickets (Barra) · Hoy</h3>
            <p className="text-xs text-fg-muted sm:text-sm">
              Filtra, busca, despliega detalles, abre, cobra o elimina.
            </p>
          </div>

          <button
            type="button"
            onClick={onClose}
            className="rounded-xl border border-border bg-surface px-3 py-2 text-sm font-semibold text-fg transition hover:bg-surface-2 cursor-pointer"
          >
            Cerrar
          </button>
        </div>

        <div className="border-b border-border p-3 sm:p-4">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div className="flex flex-wrap items-center gap-2">
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

            <div className="flex w-full min-w-0 items-center gap-2 lg:w-auto">
              <div className="relative w-full lg:w-[360px]">
                <Search
                  className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-fg-subtle"
                  aria-hidden
                />
                <input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="Buscar por hora, importe, productos, etc…"
                  className="w-full rounded-xl border border-border bg-surface-2 py-2.5 pl-9 pr-4 text-fg outline-none transition focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-ring"
                />
              </div>
              {showIndexHint ? (
                <span className="whitespace-nowrap text-xs text-fg-subtle">
                  Indexando productos…
                </span>
              ) : null}
            </div>
          </div>
        </div>

        <div className="p-3 sm:p-4">
          {rows.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-2 rounded-2xl border border-border bg-bg p-8 text-center">
              <div className="grid size-12 place-items-center rounded-2xl bg-surface-2 text-fg-subtle">
                <FolderOpen className="size-6" aria-hidden />
              </div>
              <p className="text-sm font-medium text-fg">Sin tickets</p>
              <p className="text-xs text-fg-muted">
                No hay tickets que coincidan con el filtro/búsqueda (hoy).
              </p>
            </div>
          ) : (
            <div className="max-h-[70vh] overflow-y-auto pr-1 lg:max-h-[72vh]">
              <div className="grid grid-cols-1 gap-3">
                {rows.map(({ c, when, totalPendiente, total, est, pendientesCocina, pendientesPago }) => {
                  const badge =
                    est === "COBRADO"
                      ? "border-success/30 bg-success-soft text-success"
                      : est === "PREPARADO"
                        ? "border-accent/30 bg-accent-soft text-accent"
                        : "border-warning/30 bg-warning-soft text-warning";

                  const estadoComandaBadge =
                    String(c.Estado).toLowerCase() === "pagada"
                      ? "border-success/30 bg-success-soft text-success"
                      : "border-border bg-surface-2 text-fg-muted";

                  const isExpanded = expandedId === c.ID_Comanda;
                  const detalles = detallesByComanda[c.ID_Comanda] ?? [];
                  const loadingThis = loadingDetallesId === c.ID_Comanda;

                  return (
                    <div
                      key={c.ID_Comanda}
                      className="overflow-hidden rounded-2xl border border-border bg-surface"
                    >
                      <div className="flex flex-col justify-between gap-3 p-3 sm:flex-row sm:items-center sm:p-4">
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className={cn("rounded-full border px-2 py-1 text-xs font-bold", badge)}>
                              {est}
                            </span>
                            <span
                              className={cn(
                                "rounded-full border px-2 py-1 text-xs font-bold",
                                estadoComandaBadge,
                              )}
                            >
                              {String(c.Estado).toUpperCase()}
                            </span>
                            <p className="text-sm text-fg-muted">{when}</p>
                          </div>

                          <p className="mt-1 truncate font-bold text-fg">
                            Ticket #{String(c.ID_Comanda)} ·{" "}
                            <span className="font-semibold text-fg-muted">
                              cocina {pendientesCocina} · pago {pendientesPago}
                            </span>
                          </p>

                          <p className="mt-1 text-sm text-fg-muted">
                            Pendiente: <span className="font-bold text-fg">{eur(totalPendiente)}</span>
                            <span className="mx-2 text-fg-subtle">·</span>
                            Total: <span className="font-semibold text-fg">{eur(total)}</span>
                          </p>
                        </div>

                        <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
                          <button
                            type="button"
                            onClick={() => void toggleDetalles(c.ID_Comanda)}
                            className="inline-flex items-center gap-1.5 rounded-xl border border-border bg-surface px-3 py-2 text-sm font-semibold text-fg transition hover:bg-surface-2 cursor-pointer"
                          >
                            {isExpanded ? (
                              <ChevronUp className="size-4" aria-hidden />
                            ) : (
                              <ChevronDown className="size-4" aria-hidden />
                            )}
                            {isExpanded ? "Ocultar detalles" : "Más detalles"}
                          </button>

                          <button
                            type="button"
                            onClick={() => onOpenTicket(String(c.ID_Comanda))}
                            className="rounded-xl bg-accent px-3 py-2 text-sm font-semibold text-accent-fg shadow-sm transition hover:bg-accent-hover cursor-pointer"
                          >
                            Abrir
                          </button>

                          <button
                            type="button"
                            onClick={conAviso(() => onCobrarTicket(String(c.ID_Comanda)))}
                            className={cn(
                              "rounded-xl px-3 py-2 text-sm font-semibold transition",
                              totalPendiente > 0
                                ? "border border-border bg-surface text-fg hover:bg-surface-2 cursor-pointer"
                                : "bg-surface-2 text-fg-subtle cursor-not-allowed",
                            )}
                            disabled={totalPendiente <= 0}
                          >
                            Cobrar
                          </button>

                          <button
                            type="button"
                            onClick={() => onDeleteTicket(String(c.ID_Comanda))}
                            className="inline-flex items-center gap-1.5 rounded-xl border border-border px-3 py-2 text-sm font-semibold text-fg-muted transition hover:border-danger/30 hover:bg-danger-soft hover:text-danger cursor-pointer"
                          >
                            <Trash2 className="size-4" aria-hidden />
                            Eliminar
                          </button>
                        </div>
                      </div>

                      {isExpanded ? (
                        <div className="px-3 pb-3 sm:px-4 sm:pb-4">
                          <div className="rounded-xl border border-border bg-bg p-3">
                            {loadingThis ? (
                              <p className="text-sm text-fg-muted">Cargando productos…</p>
                            ) : detalles.length === 0 ? (
                              <p className="text-sm text-fg-muted">Este ticket no tiene líneas.</p>
                            ) : (
                              <div className="grid grid-cols-1 gap-2">
                                {detalles.map((d) => {
                                  const estado = String(d.Estado_Cocina ?? "").toUpperCase();
                                  const noCocina = estado === "NO_COCINA";
                                  const cocinaOk = estado === "PREPARADO";

                                  const badgeCocina = noCocina
                                    ? "border-border bg-surface text-fg-muted"
                                    : cocinaOk
                                      ? "border-success/30 bg-success-soft text-success"
                                      : "border-warning/30 bg-warning-soft text-warning";

                                  const labelCocina = noCocina
                                    ? "NO COCINA"
                                    : cocinaOk
                                      ? "PREPARADO"
                                      : estado || "PENDIENTE";

                                  const badgePago =
                                    d.Pagado === 1
                                      ? "border-success/30 bg-success-soft text-success"
                                      : "border-border bg-surface text-fg-muted";

                                  // Centimos por una cantidad fraccionaria: vuelve a ser
                                  // flotante, asi que se redondea al centimo como hace el SQL.
                                  const importe = escalar(
                                    d.Precio_Unitario,
                                    d.Cantidad,
                                  );

                                  return (
                                    <div
                                      key={d.ID_Detalle}
                                      className="flex items-start justify-between gap-3 rounded-xl border border-border bg-surface p-3"
                                    >
                                      <div className="min-w-0">
                                        <div className="flex flex-wrap items-center gap-2">
                                          <span
                                            className={cn(
                                              "rounded-full border px-2 py-1 text-[11px] font-bold",
                                              badgeCocina,
                                            )}
                                          >
                                            {labelCocina}
                                          </span>
                                          <span
                                            className={cn(
                                              "rounded-full border px-2 py-1 text-[11px] font-bold",
                                              badgePago,
                                            )}
                                          >
                                            {d.Pagado === 1 ? "PAGADO" : "PAGO PEND."}
                                          </span>
                                          <span className="text-xs text-fg-subtle">#{d.ID_Detalle}</span>
                                        </div>

                                        <p className="mt-1 truncate font-bold text-fg">
                                          {d.Nombre}{" "}
                                          <span className="font-semibold text-fg-muted">
                                            x{Number(d.Cantidad || 1)}
                                          </span>
                                        </p>

                                        {d.Notas ? (
                                          <p className="mt-1 text-xs text-fg-muted">
                                            Nota: <span className="font-semibold text-fg">{d.Notas}</span>
                                          </p>
                                        ) : null}
                                      </div>

                                      <div className="shrink-0 text-right">
                                        <p className="text-sm font-bold text-fg">{eur(importe)}</p>
                                        <p className="text-xs text-fg-subtle">
                                          {eur(d.Precio_Unitario)} / ud
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
