// pages/Notificaciones.tsx
//
// Centro de notificaciones del usuario logueado. Lee por `id_usuario` (de useAuth) y permite
// marcar como leída / todas como leídas. El estado "leído" es por usuario.
//
// Al pulsar una notificación se marca como leída y, si su `accion` tiene destino conocido
// (ver `features/notificaciones/acciones.ts`), se navega a la pantalla que resuelve el aviso.
import {
  Bell,
  CheckCheck,
  ChevronRight,
  Info,
  CheckCircle2,
  AlertTriangle,
  AlertCircle,
  RefreshCw,
  type LucideIcon,
} from "lucide-react";
import { useNavigate } from "react-router-dom";

import { useAuth } from "../../shared/stores/useAuth";
import { cn } from "../../shared/lib/cn";
import type { NotificacionRow } from "../../features/notificaciones/notificacionesApis";
import { destinoDeAccion } from "../../features/notificaciones/acciones";
import {
  useMarcarLeida,
  useMarcarTodasLeidas,
  useNotificaciones,
} from "../../features/notificaciones/notificacionesQueries";

/** Aspecto por severidad (icono + colores suaves, claro/oscuro). */
const SEVERIDAD: Record<string, { icon: LucideIcon; className: string }> = {
  info: { icon: Info, className: "bg-sky-500/15 text-sky-500" },
  exito: { icon: CheckCircle2, className: "bg-emerald-500/15 text-emerald-500" },
  aviso: { icon: AlertTriangle, className: "bg-amber-500/15 text-amber-500" },
  error: { icon: AlertCircle, className: "bg-rose-500/15 text-rose-500" },
};

function aspecto(severidad: string) {
  return SEVERIDAD[severidad] ?? SEVERIDAD.info;
}

/** "YYYY-MM-DD HH:MM:SS" → "YYYY-MM-DD HH:MM" (formato local del backend, sin segundos). */
function fmtFecha(s: string): string {
  if (!s) return "";
  return s.replace("T", " ").slice(0, 16);
}

export default function Notificaciones() {
  const idUsuario = useAuth((s) => s.idUsuario);
  const navigate = useNavigate();

  const notificaciones = useNotificaciones(idUsuario);
  const marcarLeida = useMarcarLeida();
  const marcarTodas = useMarcarTodasLeidas();

  const items: NotificacionRow[] = notificaciones.data ?? [];
  const noLeidas = items.filter((n) => !n.leida).length;
  const loading =
    notificaciones.isFetching || marcarLeida.isPending || marcarTodas.isPending;

  function onCardClick(n: NotificacionRow) {
    if (idUsuario && !n.leida) {
      marcarLeida.mutate({ idNotificacion: n.id_notificacion, idUsuario });
    }
    // Navegar es lo último: la mutación (y su invalidación en `onSuccess`) sobrevive al desmontaje
    // de esta pantalla, así que el marcado se completa aunque salgamos de aquí al instante.
    const destino = destinoDeAccion(n.accion);
    if (destino) navigate(destino.to, { state: destino.state });
  }

  function onMarcarTodas() {
    if (!idUsuario || noLeidas === 0) return;
    marcarTodas.mutate({ idUsuario });
  }

  return (
    <div className="flex h-full min-h-0 w-full flex-col gap-3 overflow-y-auto overscroll-contain bg-bg p-2 pt-3 [scrollbar-gutter:stable] sm:gap-4 sm:p-4 sm:pt-4 lg:p-6 lg:pt-5">
      {/* HEADER */}
      <div className="flex w-full shrink-0 flex-col items-stretch gap-3 rounded-2xl border border-border bg-surface p-3 shadow-sm xs:flex-row xs:items-center xs:justify-between sm:p-4">
        <div className="flex min-w-0 items-center gap-3">
          <div className="grid size-11 shrink-0 place-items-center rounded-2xl bg-accent-soft text-accent">
            <Bell className="size-6" aria-hidden />
          </div>
          <div className="min-w-0">
            <h2 className="break-words text-xl font-bold leading-tight text-fg sm:text-2xl">Notificaciones</h2>
            <p className="text-sm text-fg-muted">
              {noLeidas > 0
                ? `${noLeidas} sin leer`
                : "Estás al día"}
            </p>
          </div>
        </div>

        <div className="grid shrink-0 grid-cols-[auto_1fr] items-center gap-2 xs:flex">
          <button
            type="button"
            onClick={() => notificaciones.refetch()}
            aria-label="Recargar"
            title="Recargar"
            className="grid size-9 cursor-pointer place-items-center rounded-xl border border-border bg-surface text-fg-muted transition hover:bg-surface-2 hover:text-fg"
          >
            <RefreshCw className={cn("size-4", loading && "animate-spin")} aria-hidden />
          </button>

          <button
            type="button"
            onClick={onMarcarTodas}
            disabled={noLeidas === 0}
            className={cn(
              "inline-flex min-w-0 items-center justify-center gap-1.5 whitespace-normal break-words rounded-xl px-3 py-2 text-center text-sm font-semibold leading-tight transition",
              noLeidas === 0
                ? "cursor-not-allowed border border-border bg-surface text-fg-subtle"
                : "cursor-pointer bg-accent text-accent-fg shadow-sm hover:bg-accent-hover active:scale-[0.98]",
            )}
          >
            <CheckCheck className="size-4" aria-hidden />
            <span>Marcar todas</span>
          </button>
        </div>
      </div>

      {/* LISTA */}
      {notificaciones.isLoading ? (
        <p className="text-sm text-fg-muted">Cargando notificaciones…</p>
      ) : items.length === 0 ? (
        <div className="flex min-h-[240px] flex-1 flex-col items-center justify-center gap-2 rounded-2xl border border-border bg-surface p-5 text-center shadow-sm sm:p-10">
          <div className="grid size-12 place-items-center rounded-2xl bg-surface-2 text-fg-subtle">
            <Bell className="size-6" aria-hidden />
          </div>
          <p className="text-sm font-medium text-fg">Sin notificaciones</p>
          <p className="text-xs text-fg-muted">Aquí aparecerán tus avisos.</p>
        </div>
      ) : (
        <div className="flex w-full min-w-0 flex-col gap-2">
          {items.map((n) => {
            const a = aspecto(n.severidad);
            const Icon = a.icon;
            const destino = destinoDeAccion(n.accion);
            return (
              <button
                key={n.id_notificacion}
                type="button"
                onClick={() => onCardClick(n)}
                title={destino ? "Ir a la pantalla relacionada" : undefined}
                className={cn(
                  "group flex w-full min-w-0 items-start gap-2 rounded-2xl border p-3 text-left shadow-sm transition sm:gap-3 sm:p-4",
                  n.leida
                    ? "border-border bg-surface hover:bg-surface-2"
                    : "border-accent/40 bg-accent-soft/40 hover:bg-accent-soft/60",
                )}
              >
                <div
                  className={cn(
                    "grid size-9 shrink-0 place-items-center rounded-xl sm:size-10",
                    a.className,
                  )}
                >
                  <Icon className="size-5" aria-hidden />
                </div>

                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 flex-col gap-0.5 xs:flex-row xs:items-start xs:justify-between xs:gap-2">
                    <p
                      className={cn(
                        "min-w-0 break-words text-sm xs:truncate",
                        n.leida ? "font-medium text-fg" : "font-bold text-fg",
                      )}
                    >
                      {n.titulo}
                    </p>
                    <span className="shrink-0 whitespace-nowrap text-[11px] text-fg-subtle sm:text-xs">
                      {fmtFecha(n.creada_en)}
                    </span>
                  </div>

                  {n.cuerpo ? (
                    <p className="mt-1 line-clamp-3 break-words text-sm text-fg-muted sm:mt-0.5 sm:line-clamp-2">{n.cuerpo}</p>
                  ) : null}
                </div>

                {!n.leida && (
                  <span
                    className="mt-1.5 size-2 shrink-0 rounded-full bg-accent sm:size-2.5"
                    aria-label="No leída"
                    title="No leída"
                  />
                )}

                {destino && (
                  <ChevronRight
                    className="mt-0.5 size-4 shrink-0 text-fg-subtle transition group-hover:translate-x-0.5 group-hover:text-fg-muted"
                    aria-hidden
                  />
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
