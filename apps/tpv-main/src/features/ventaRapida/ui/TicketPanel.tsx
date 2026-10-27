import React, { useEffect, useMemo, useState } from "react";
import {
  Check,
  ChevronDown,
  Pencil,
  Trash2,
  StickyNote,
  ReceiptText,
  Printer,
} from "lucide-react";
import { Paso, TicketItem } from "../types";
import { cn, lineaGuardada } from "../utils";
import PrintTicketModal, { type CobroImprimible } from "../../../shared/ticket/PrintTicketModal";
import { useMode } from "../../../shared/stores/useMode";
import { conAviso } from "../../../shared/lib/conAviso";
import type { Dinero } from "@tpv/contracts";
import { eur } from "../../../shared/lib/dinero";

export default function TicketPanel({
  ocupado = false,
  ticket,
  paso,
  totalPendiente,
  totalSeleccionado,
  haySeleccion,

  onCobrarTodo,
  onCobrarFraccionado,

  onToggleSeleccion,
  onEliminarLinea,

  onCobrarTarjeta,
  ultimoCobro,
  onStartEfectivo,
  onCancelarCobro,

  quiereFactura,
  onQuiereFacturaChange,

  onGuardarNota,

}: {
  ocupado?: boolean;
  ticket: TicketItem[];
  paso: Paso;
  totalPendiente: Dinero;
  totalSeleccionado: Dinero;
  haySeleccion: boolean;

  onCobrarTodo: () => void;
  onCobrarFraccionado: () => void;

  onToggleSeleccion: (id: string) => void;
  onEliminarLinea: (id: string) => void;

  onCobrarTarjeta: () => void | Promise<void>;
  /**
   * El último cobro de la venta en curso. Con él se puede imprimir su ticket (el de su factura);
   * sin él, sólo una precuenta.
   */
  ultimoCobro?: CobroImprimible | null;
  onStartEfectivo: () => void;
  onCancelarCobro: () => void;

  /** FISCAL-02: el cliente pide factura completa. Los datos se piden al cobrar. */
  quiereFactura: boolean;
  onQuiereFacturaChange: (v: boolean) => void;

  onGuardarNota: (detalleId: string, nota: string) => void | Promise<void>;

}) {
  const hayPendientes = ticket.some((t) => !t.pagado);

  // Cobrar es cosa de la Main: es la que tiene impresora y cajón. Cerrar una venta desde un Handy
  // dejaría al cliente sin ticket y el dinero sin registrar. El servidor también lo rechaza; esto
  // es para que no se llegue a intentar.
  const esMain = useMode((s) => s.mode) === "tpv";
  const canCobrarTodo = esMain && hayPendientes && !ocupado;
  const canCobrarFraccionado = esMain && haySeleccion && !ocupado;
  const canCobrarMetodo = haySeleccion && !ocupado;

  const [notaOpen, setNotaOpen] = useState(false);
  const [notaSaving, setNotaSaving] = useState(false);
  const [notaTicketId, setNotaTicketId] = useState<string | null>(null);
  const [notaValue, setNotaValue] = useState("");

  const [printOpen, setPrintOpen] = useState(false);
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({});

  const currentItem = useMemo(() => {
    if (!notaTicketId) return null;
    return ticket.find((t) => t.id === notaTicketId) ?? null;
  }, [notaTicketId, ticket]);

  const groupedTicket = useMemo(() => {
    const groups = new Map<string, TicketItem[]>();

    for (const item of ticket) {
      const key = String(item.categoriaNombre ?? "").trim() || "Sin categoría";
      const bucket = groups.get(key) ?? [];
      bucket.push(item);
      groups.set(key, bucket);
    }

    return Array.from(groups.entries()).map(([name, items]) => ({
      name,
      items,
    }));
  }, [ticket]);

  useEffect(() => {
    setExpandedGroups((prev) => {
      const next = { ...prev };
      let changed = false;

      for (const group of groupedTicket) {
        if (next[group.name] === undefined) {
          next[group.name] = true;
          changed = true;
        }
      }

      return changed ? next : prev;
    });
  }, [groupedTicket]);

  const toggleGroup = (name: string) => {
    setExpandedGroups((prev) => ({ ...prev, [name]: !prev[name] }));
  };

  const openNotaModal = (t: TicketItem) => {
    if (!lineaGuardada(t)) return;

    setNotaTicketId(t.id);
    setNotaValue(String(t.notas ?? ""));
    setNotaOpen(true);
  };

  const closeNotaModal = () => {
    if (notaSaving) return;

    setNotaOpen(false);
    setNotaSaving(false);
    setNotaTicketId(null);
    setNotaValue("");
  };

  const saveNota = async () => {
    if (!currentItem) return;
    if (!lineaGuardada(currentItem)) return;

    setNotaSaving(true);

    try {
      await onGuardarNota(currentItem.detalleId, notaValue);
      closeNotaModal();
    } catch (e) {
      console.error("Error guardando nota:", e);
      setNotaSaving(false);
    }
  };

  useEffect(() => {
    if (!notaOpen) return;

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeNotaModal();

      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
        void saveNota();
      }
    };

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);

    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notaOpen, currentItem, notaValue, notaSaving]);

  return (
    <div
      className="
        grid min-h-0 w-full grid-rows-[auto_auto_auto_auto] overflow-hidden p-3
        sm:p-4 lg:h-full lg:grid-rows-[auto_auto_minmax(0,1fr)_auto]
      "
    >
      <div className="min-h-0">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <h3 className="flex items-center gap-2 text-base font-bold text-fg sm:text-lg">
            <ReceiptText className="size-5 text-accent" aria-hidden />
            Ticket
          </h3>

          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => setPrintOpen(true)}
              disabled={ticket.length === 0}
              className={cn(
                "flex items-center gap-2 rounded-xl border px-3 py-1.5 text-xs font-semibold transition",
                ticket.length === 0
                  ? "border-border bg-surface-2 text-fg-subtle cursor-not-allowed"
                  : "border-border bg-surface text-fg hover:bg-surface-2 cursor-pointer",
              )}
              title="Imprimir ticket"
            >
              <Printer className="size-4" aria-hidden />
              Imprimir
            </button>

            <div className="text-xs font-semibold text-fg-muted sm:text-sm">
              Total pendiente:{" "}
              <span className="text-fg">{eur(totalPendiente)}</span>
            </div>
          </div>
        </div>
      </div>

      <div className="mt-3 flex min-h-0 flex-col items-stretch gap-2 sm:flex-row">
        <button
          className={cn(
            "flex-1 rounded-xl px-3 py-2.5 text-sm font-semibold transition active:scale-[0.98]",
            canCobrarTodo
              ? "bg-accent text-accent-fg shadow-sm hover:bg-accent-hover cursor-pointer"
              : "bg-surface-2 text-fg-subtle cursor-not-allowed",
          )}
          disabled={!canCobrarTodo}
          onClick={onCobrarTodo}
          type="button"
        >
          Cobrar todo
        </button>

        <button
          className={cn(
            "flex-1 rounded-xl px-3 py-2.5 text-sm font-semibold transition active:scale-[0.98]",
            canCobrarFraccionado
              ? "border border-border bg-surface text-fg hover:bg-surface-2 cursor-pointer"
              : "bg-surface-2 text-fg-subtle cursor-not-allowed",
          )}
          disabled={!canCobrarFraccionado}
          onClick={onCobrarFraccionado}
          type="button"
        >
          Cobrar fraccionado
        </button>
      </div>

      <div className="mt-4 max-h-[55dvh] min-h-0 overflow-hidden rounded-2xl border border-border bg-bg lg:max-h-none">
        {ticket.length === 0 ? (
          <div className="flex h-full min-h-[220px] flex-col items-center justify-center gap-2 p-8 text-center">
            <div className="grid size-12 place-items-center rounded-2xl bg-surface-2 text-fg-subtle">
              <ReceiptText className="size-6" aria-hidden />
            </div>
            <p className="text-sm font-medium text-fg">El ticket está vacío</p>
            <p className="text-xs text-fg-muted">Añade productos para empezar.</p>
          </div>
        ) : (
          <div
            className="
              h-full min-h-0 overflow-y-auto overscroll-contain p-3 pr-2
              [scrollbar-gutter:stable]
            "
          >
            <div className="flex min-h-0 flex-col gap-2">
              {groupedTicket.map(({ name, items }) => {
                const expanded = expandedGroups[name] ?? true;
                const pendingCount = items.filter((item) => !item.pagado).length;

                return (
                  <div
                    key={name}
                    className="shrink-0 overflow-hidden rounded-xl border border-border bg-surface"
                  >
                    <button
                      type="button"
                      className="flex w-full items-center justify-between gap-3 px-3 py-2.5 text-left"
                      onClick={() => toggleGroup(name)}
                    >
                      <div className="min-w-0">
                        <p className="truncate text-sm font-semibold text-fg">{name}</p>
                        <p className="text-xs text-fg-subtle">
                          {pendingCount} {pendingCount === 1 ? "línea" : "líneas"}
                        </p>
                      </div>

                      <ChevronDown
                        className={cn(
                          "size-4 shrink-0 text-fg-muted transition",
                          !expanded && "-rotate-90",
                        )}
                        aria-hidden
                      />
                    </button>

                    {expanded ? (
                      <div
                        className="
                          max-h-[280px] overflow-y-auto overscroll-contain border-t border-border/70 p-2 pr-1
                          [scrollbar-gutter:stable]
                        "
                      >
                        <div className="flex flex-col gap-2">
                          {items.map((t) => {
                            const checked = t.seleccionado && !t.pagado;
                            const notas = String(t.notas ?? "").trim();
                            const tieneNota = Boolean(notas);
                            const guardada = lineaGuardada(t);
                            const disabledLine = t.pagado;

                            return (
                              <div
                                key={t.id}
                                role="button"
                                tabIndex={disabledLine ? -1 : 0}
                                onClick={() => {
                                  if (!disabledLine) onToggleSeleccion(t.id);
                                }}
                                onKeyDown={(e) => {
                                  if (disabledLine) return;

                                  if (e.key === "Enter" || e.key === " ") {
                                    e.preventDefault();
                                    onToggleSeleccion(t.id);
                                  }
                                }}
                                className={cn(
                                  "flex w-full items-center justify-between gap-3 rounded-xl border px-3 py-2 text-left transition",
                                  checked
                                    ? "border-accent bg-accent-soft"
                                    : "border-border bg-surface hover:bg-surface-2",
                                  t.pagado && "opacity-70",
                                )}
                                aria-disabled={disabledLine}
                              >
                                <div className="flex min-w-0 items-center gap-3">
                                  <div
                                    className={cn(
                                      "grid size-6 shrink-0 place-items-center rounded-full border transition",
                                      checked
                                        ? "border-accent bg-accent text-accent-fg"
                                        : "border-border-strong bg-surface",
                                      t.pagado && "border-border bg-surface-2",
                                    )}
                                  >
                                    {checked ? <Check className="size-3.5" aria-hidden /> : null}
                                  </div>

                                  <div className="min-w-0">
                                    <p
                                      className={cn(
                                        "flex items-center gap-2 truncate text-sm font-semibold text-fg sm:text-base",
                                        t.pagado && "text-fg-subtle line-through",
                                      )}
                                    >
                                      <span className="truncate">{t.nombre}</span>

                                      {tieneNota ? (
                                        <span className="shrink-0 rounded-full border border-warning/30 bg-warning-soft px-2 py-0.5 text-[11px] font-bold text-warning">
                                          NOTA
                                        </span>
                                      ) : null}
                                    </p>

                                    <p className="text-xs text-fg-subtle">
                                      {t.pagado ? "Cobrado" : "Pendiente"}
                                    </p>

                                    {tieneNota ? (
                                      <p className="mt-1 flex items-center gap-1 truncate text-xs text-fg-muted">
                                        <StickyNote className="size-3 shrink-0" aria-hidden />
                                        {notas}
                                      </p>
                                    ) : null}
                                  </div>
                                </div>

                                <div className="flex shrink-0 items-center gap-2">
                                  <span
                                    className={cn(
                                      "text-sm font-bold text-fg sm:text-base",
                                      t.pagado && "text-fg-subtle line-through",
                                    )}
                                  >
                                    {eur(t.precio)}
                                  </span>

                                  <button
                                    type="button"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      openNotaModal(t);
                                    }}
                                    disabled={!guardada || ocupado}
                                    className={cn(
                                      "grid size-8 place-items-center rounded-lg border transition",
                                      !guardada
                                        ? "border-border bg-surface-2 text-fg-subtle cursor-not-allowed"
                                        : "border-border text-fg-muted hover:bg-surface-2 hover:text-fg cursor-pointer",
                                    )}
                                    title={
                                      guardada
                                        ? "Añadir/editar nota"
                                        : "La nota estará disponible cuando la línea esté confirmada"
                                    }
                                    aria-label="Nota"
                                  >
                                    <Pencil className="size-4" aria-hidden />
                                  </button>

                                  {!t.pagado && (
                                    <button
                                      type="button"
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        onEliminarLinea(t.id);
                                      }}
                                      className="grid size-8 place-items-center rounded-lg border border-border text-fg-muted transition hover:border-danger/30 hover:bg-danger-soft hover:text-danger cursor-pointer"
                                      title="Eliminar producto"
                                      aria-label="Eliminar"
                                      disabled={ocupado}
                                    >
                                      <Trash2 className="size-4" aria-hidden />
                                    </button>
                                  )}
                                </div>
                              </div>
                            );
                          })}
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

      <div className="mt-4 shrink-0 rounded-2xl border border-border bg-surface p-3">
        <div className="flex items-center justify-between">
          <p className="text-sm text-fg-muted">Seleccionado</p>
          <p className="text-lg font-bold text-fg">{eur(totalSeleccionado)}</p>
        </div>

        {paso === "metodo" ? (
          <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
            <button
              className={cn(
                "rounded-xl px-3 py-2.5 text-sm font-semibold transition active:scale-[0.98] sm:py-3",
                canCobrarMetodo
                  ? "bg-accent text-accent-fg shadow-sm hover:bg-accent-hover cursor-pointer"
                  : "bg-surface-2 text-fg-subtle cursor-not-allowed",
              )}
              disabled={!canCobrarMetodo}
              onClick={conAviso(onCobrarTarjeta)}
              type="button"
            >
              Cobrar con tarjeta
            </button>

            <button
              className={cn(
                "rounded-xl px-3 py-2.5 text-sm font-semibold transition active:scale-[0.98] sm:py-3",
                canCobrarMetodo
                  ? "border border-border bg-surface text-fg hover:bg-surface-2 cursor-pointer"
                  : "bg-surface-2 text-fg-subtle cursor-not-allowed",
              )}
              disabled={!canCobrarMetodo}
              onClick={onStartEfectivo}
              type="button"
            >
              Cobrar en efectivo
            </button>

            <label className="flex items-center gap-2 rounded-xl border border-border bg-surface px-3 py-2.5 text-sm sm:col-span-2">
              <input
                type="checkbox"
                checked={quiereFactura}
                onChange={(e) => onQuiereFacturaChange(e.target.checked)}
                className="h-4 w-4 accent-[var(--accent)]"
              />
              <span className="font-semibold text-fg">
                El cliente pide factura con NIF
              </span>
              <span className="text-xs text-fg-subtle">
                (se piden sus datos al cobrar)
              </span>
            </label>

            <button
              className="rounded-xl border border-border bg-surface px-3 py-2.5 text-sm font-semibold text-fg-muted transition hover:bg-surface-2 hover:text-fg cursor-pointer sm:col-span-2"
              disabled={ocupado}
              onClick={onCancelarCobro}
              type="button"
            >
              Cancelar cobro
            </button>
          </div>
        ) : (
          <p className="mt-2 text-xs text-fg-subtle">
            Selecciona productos pendientes y pulsa “Cobrar fraccionado”, o pulsa “Cobrar todo”.
          </p>
        )}
      </div>

      {notaOpen ? (
        <div className="fixed inset-0 z-[120]">
          <button
            type="button"
            className="absolute inset-0 bg-black/50"
            onClick={closeNotaModal}
            aria-label="Cerrar"
          />

          <div className="absolute left-1/2 top-1/2 max-h-[calc(100dvh-1.5rem)] w-[560px] max-w-[92vw] -translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-2xl border border-border bg-surface shadow-xl">
            <div className="flex items-center justify-between gap-3 border-b border-border p-3 sm:p-4">
              <div className="min-w-0">
                <h3 className="text-base font-bold text-fg sm:text-lg">Nota del producto</h3>
                <p className="truncate text-xs text-fg-muted sm:text-sm">
                  {currentItem ? currentItem.nombre : "—"}
                </p>
              </div>

              <button
                type="button"
                onClick={closeNotaModal}
                disabled={notaSaving}
                className="rounded-xl border border-border bg-surface px-3 py-2 text-sm font-semibold text-fg transition hover:bg-surface-2 cursor-pointer"
              >
                Cerrar
              </button>
            </div>

            <div className="max-h-[calc(100dvh-9rem)] overflow-y-auto p-3 sm:p-4">
              <label className="text-sm font-semibold text-fg">
                Escribe una nota para cocina
              </label>

              <textarea
                value={notaValue}
                onChange={(e) => setNotaValue(e.target.value)}
                placeholder="Ej: sin queso, bien hecho, sin cebolla…"
                className="mt-2 min-h-[110px] w-full resize-none rounded-2xl border border-border bg-surface-2 px-4 py-3 text-fg outline-none transition focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-ring sm:min-h-[120px]"
                disabled={notaSaving}
              />

              <p className="mt-2 text-xs text-fg-subtle">Tip: Ctrl/⌘ + Enter para guardar.</p>

              <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-2">
                <button
                  type="button"
                  onClick={closeNotaModal}
                  disabled={notaSaving}
                  className="w-full rounded-xl border border-border bg-surface px-4 py-2.5 font-semibold text-fg transition hover:bg-surface-2 cursor-pointer"
                >
                  Cancelar
                </button>

                <button
                  type="button"
                  onClick={() => void saveNota()}
                  disabled={notaSaving}
                  className={cn(
                    "w-full rounded-xl px-4 py-2.5 font-extrabold transition active:scale-[0.98]",
                    notaSaving
                      ? "bg-surface-2 text-fg-subtle cursor-not-allowed"
                      : "bg-accent text-accent-fg shadow-sm hover:bg-accent-hover cursor-pointer",
                  )}
                >
                  {notaSaving ? "Guardando..." : "Guardar nota"}
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}

      <PrintTicketModal
        open={printOpen}
        onClose={() => setPrintOpen(false)}
        items={ticket}
        cobro={ultimoCobro}
      />
    </div>
  );
}
