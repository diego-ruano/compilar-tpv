import React, { useEffect, useMemo, useState } from "react";
import { Paso, TicketItem } from "../types";
import { cn } from "../utils";

export default function TicketPanel({
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
  onStartEfectivo,
  onCancelarCobro,

  onGuardarNota,

  formatMoney,
}: {
  ticket: TicketItem[];
  paso: Paso;
  totalPendiente: number;
  totalSeleccionado: number;
  haySeleccion: boolean;

  onCobrarTodo: () => void;
  onCobrarFraccionado: () => void;

  onToggleSeleccion: (id: string) => void;
  onEliminarLinea: (id: string) => void;

  onCobrarTarjeta: () => void | Promise<void>;
  onStartEfectivo: () => void;
  onCancelarCobro: () => void;

  onGuardarNota: (detalleId: number, nota: string) => void | Promise<void>;

  formatMoney: (n: number) => string;
}) {
  const hayPendientes = ticket.some((t) => !t.pagado);

  const canCobrarTodo = hayPendientes;
  const canCobrarFraccionado = haySeleccion;
  const canCobrarMetodo = haySeleccion;

  const [notaOpen, setNotaOpen] = useState(false);
  const [notaSaving, setNotaSaving] = useState(false);
  const [notaTicketId, setNotaTicketId] = useState<string | null>(null);
  const [notaValue, setNotaValue] = useState("");

  const currentItem = useMemo(() => {
    if (!notaTicketId) return null;
    return ticket.find((t) => t.id === notaTicketId) ?? null;
  }, [notaTicketId, ticket]);

  const openNotaModal = (t: TicketItem) => {
    if (!(Number(t.detalleId) > 0)) return;

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
    if (!(Number(currentItem.detalleId) > 0)) return;

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
        order-2 lg:order-none
        w-full lg:w-[380px] xl:w-[420px]
        lg:shrink-0
        bg-blanco rounded-xl shadow-xs
        p-3 sm:p-4
        flex flex-col min-h-0
      "
    >
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
        <h3 className="text-base sm:text-lg font-bold text-negro">Ticket</h3>

        <div className="text-xs sm:text-sm font-semibold text-black/70">
          Total pendiente: <span className="text-black">{formatMoney(totalPendiente)}</span>
        </div>
      </div>

      <div className="mt-3 flex flex-col sm:flex-row items-stretch gap-2">
        <button
          className={cn(
            "flex-1 px-3 py-2.5 rounded-xl text-sm font-semibold transition",
            canCobrarTodo
              ? "bg-black text-white hover:bg-black/90"
              : "bg-black/10 text-black/40 cursor-not-allowed",
          )}
          disabled={!canCobrarTodo}
          onClick={onCobrarTodo}
          type="button"
        >
          Cobrar todo
        </button>

        <button
          className={cn(
            "flex-1 px-3 py-2.5 rounded-xl text-sm font-semibold transition",
            canCobrarFraccionado
              ? "bg-white border border-black/10 hover:bg-black/5"
              : "bg-black/10 text-black/40 cursor-not-allowed",
          )}
          disabled={!canCobrarFraccionado}
          onClick={onCobrarFraccionado}
          type="button"
        >
          Cobrar fraccionado
        </button>
      </div>

      <div className="mt-4 flex-1 min-h-0 overflow-y-auto pr-1 rounded-xl border border-black/10 bg-white">
        {ticket.length === 0 ? (
          <div className="p-4 text-sm text-black/60">Añade productos para empezar.</div>
        ) : (
          <div className="p-3 flex flex-col gap-2">
            {ticket.map((t) => {
              const checked = t.seleccionado && !t.pagado;
              const notas = String(t.notas ?? "").trim();
              const tieneNota = Boolean(notas);
              const lineaGuardada = Number(t.detalleId) > 0;
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
                    "w-full rounded-xl border p-3 text-left transition flex items-center justify-between gap-3",
                    "border-black/10 hover:bg-black/5",
                    t.pagado && "opacity-70",
                  )}
                  aria-disabled={disabledLine}
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <div
                      className={cn(
                        "w-6 h-6 rounded-full border flex items-center justify-center shrink-0",
                        checked ? "border-emerald-500 bg-emerald-500" : "border-black/20 bg-white",
                        t.pagado && "border-black/10 bg-black/5",
                      )}
                    >
                      {checked ? <div className="w-2.5 h-2.5 rounded-full bg-white" /> : null}
                    </div>

                    <div className="min-w-0">
                      <p
                        className={cn(
                          "font-semibold truncate text-sm sm:text-base",
                          t.pagado && "line-through text-black/50",
                        )}
                      >
                        {t.nombre}

                        {tieneNota ? (
                          <span className="ml-2 text-[11px] font-bold px-2 py-0.5 rounded-full border border-amber-200 bg-amber-50 text-amber-900">
                            NOTA
                          </span>
                        ) : null}
                      </p>

                      <p className="text-xs text-black/50">
                        {t.pagado ? "Cobrado" : "Pendiente"}
                      </p>

                      {tieneNota ? (
                        <p className="mt-1 text-xs text-black/70 truncate">📝 {notas}</p>
                      ) : null}
                    </div>
                  </div>

                  <div className="flex items-center gap-2 shrink-0">
                    <span
                      className={cn(
                        "font-bold text-sm sm:text-base",
                        t.pagado && "line-through text-black/40",
                      )}
                    >
                      {formatMoney(t.precio)}
                    </span>

                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        openNotaModal(t);
                      }}
                      disabled={!lineaGuardada}
                      className={cn(
                        "w-8 h-8 flex items-center justify-center rounded-lg border transition",
                        !lineaGuardada
                          ? "border-black/10 text-black/25 bg-black/5 cursor-not-allowed"
                          : "border-black/10 text-black/55 hover:bg-black/5 hover:text-black",
                      )}
                      title={
                        lineaGuardada
                          ? "Añadir/editar nota"
                          : "La nota estará disponible cuando la línea esté confirmada"
                      }
                    >
                      ✏️
                    </button>

                    {!t.pagado && (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          onEliminarLinea(t.id);
                        }}
                        className="w-8 h-8 flex items-center justify-center rounded-lg border border-black/10 text-black/50 hover:bg-rose-50 hover:text-rose-600 hover:border-rose-200 transition"
                        title="Eliminar producto"
                      >
                        🗑️
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="mt-4 rounded-xl border border-black/10 bg-white p-3">
        <div className="flex items-center justify-between">
          <p className="text-sm text-black/60">Seleccionado</p>
          <p className="font-bold">{formatMoney(totalSeleccionado)}</p>
        </div>

        {paso === "metodo" ? (
          <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-2">
            <button
              className={cn(
                "px-3 py-2.5 sm:py-3 rounded-xl text-sm font-semibold transition",
                canCobrarMetodo
                  ? "bg-black text-white hover:bg-black/90"
                  : "bg-black/10 text-black/40 cursor-not-allowed",
              )}
              disabled={!canCobrarMetodo}
              onClick={onCobrarTarjeta}
              type="button"
            >
              Cobrar con tarjeta
            </button>

            <button
              className={cn(
                "px-3 py-2.5 sm:py-3 rounded-xl text-sm font-semibold transition",
                canCobrarMetodo
                  ? "bg-white border border-black/10 hover:bg-black/5"
                  : "bg-black/10 text-black/40 cursor-not-allowed",
              )}
              disabled={!canCobrarMetodo}
              onClick={onStartEfectivo}
              type="button"
            >
              Cobrar en efectivo
            </button>

            <button
              className="sm:col-span-2 px-3 py-2.5 rounded-xl border border-black/10 bg-white hover:bg-black/5 text-sm font-semibold"
              onClick={onCancelarCobro}
              type="button"
            >
              Cancelar cobro
            </button>
          </div>
        ) : (
          <p className="mt-2 text-xs text-black/50">
            Selecciona productos pendientes y pulsa “Cobrar fraccionado”, o pulsa “Cobrar todo”.
          </p>
        )}
      </div>

      {notaOpen ? (
        <div className="fixed inset-0 z-[120]">
          <button
            type="button"
            className="absolute inset-0 bg-black/30"
            onClick={closeNotaModal}
            aria-label="Cerrar"
          />

          <div className="absolute left-1/2 top-1/2 w-[560px] max-w-[92vw] -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-black/10 bg-white shadow-xl overflow-hidden max-h-[calc(100vh-1.5rem)]">
            <div className="p-3 sm:p-4 border-b border-black/10 flex items-center justify-between gap-3">
              <div className="min-w-0">
                <h3 className="text-base sm:text-lg font-bold text-negro">Nota del producto</h3>
                <p className="text-xs sm:text-sm text-negro/60 truncate">
                  {currentItem ? currentItem.nombre : "—"}
                </p>
              </div>

              <button
                type="button"
                onClick={closeNotaModal}
                disabled={notaSaving}
                className="px-3 py-2 rounded-xl border border-black/10 bg-white hover:bg-black/5 text-sm font-semibold"
              >
                Cerrar
              </button>
            </div>

            <div className="p-3 sm:p-4 overflow-y-auto max-h-[calc(100vh-9rem)]">
              <label className="text-sm font-semibold text-negro">Escribe una nota para cocina</label>

              <textarea
                value={notaValue}
                onChange={(e) => setNotaValue(e.target.value)}
                placeholder="Ej: sin queso, bien hecho, sin cebolla…"
                className="mt-2 w-full min-h-[110px] sm:min-h-[120px] rounded-2xl border border-black/10 bg-white px-4 py-3 outline-none focus:ring-2 focus:ring-black/10 resize-none"
                disabled={notaSaving}
              />

              <p className="mt-2 text-xs text-black/50">Tip: Ctrl/⌘ + Enter para guardar.</p>

              <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={closeNotaModal}
                  disabled={notaSaving}
                  className="w-full px-4 py-2.5 rounded-xl border border-black/20 hover:bg-gris transition font-semibold"
                >
                  Cancelar
                </button>

                <button
                  type="button"
                  onClick={() => void saveNota()}
                  disabled={notaSaving}
                  className={cn(
                    "w-full px-4 py-2.5 rounded-xl font-extrabold transition",
                    notaSaving
                      ? "bg-gray-400 cursor-not-allowed text-white"
                      : "bg-black text-white hover:bg-black/90",
                  )}
                >
                  {notaSaving ? "Guardando..." : "Guardar nota"}
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}