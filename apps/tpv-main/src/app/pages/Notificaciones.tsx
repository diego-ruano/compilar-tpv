// pages/Notificaciones.tsx
//
// Centro de notificaciones del usuario logueado. Lee por `id_usuario` (de useAuth) y permite
// marcar como leída / todas como leídas. El estado "leído" es por usuario.
import {
  Bell,
  CheckCheck,
  Info,
  CheckCircle2,
  AlertTriangle,
  AlertCircle,
  RefreshCw,
  type LucideIcon,
} from "lucide-react";

import { useAuth } from "../../shared/stores/useAuth";
import { cn } from "../../shared/lib/cn";
import type { NotificacionRow } from "../../features/notificaciones/notificacionesApis";
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

  const notificaciones = useNotificaciones(idUsuario);
  const marcarLeida = useMarcarLeida();
  const marcarTodas = useMarcarTodasLeidas();

  const items: NotificacionRow[] = notificaciones.data ?? [];
  const noLeidas = items.filter((n) => !n.leida).length;
  const loading =
    notificaciones.isFetching || marcarLeida.isPending || marcarTodas.isPending;

  function onCardClick(n: NotificacionRow) {
    if (!idUsuario || n.leida) return;
    marcarLeida.mutate({ idNotificacion: n.id_notificacion, idUsuario });
  }

  function onMarcarTodas() {
    if (!idUsuario || noLeidas === 0) return;
    marcarTodas.mutate({ idUsuario });
  }

  return (
    <div className="flex min-h-full w-full flex-col gap-4 bg-bg p-3 pt-3 sm:p-6 sm:pt-4 lg:p-10 lg:pt-5">
      {/* HEADER */}
      <div className="flex w-full items-center justify-between gap-3 rounded-2xl border border-border bg-surface p-4 shadow-sm">
        <div className="flex min-w-0 items-center gap-3">
          <div className="grid size-11 shrink-0 place-items-center rounded-2xl bg-accent-soft text-accent">
            <Bell className="size-6" aria-hidden />
          </div>
          <div className="min-w-0">
            <h2 className="text-xl font-bold text-fg sm:text-2xl">Notificaciones</h2>
            <p className="text-sm text-fg-muted">
              {noLeidas > 0
                ? `${noLeidas} sin leer`
                : "Estás al día"}
            </p>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2">
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
              "inline-flex items-center gap-1.5 rounded-xl px-3 py-2 text-sm font-semibold transition",
              noLeidas === 0
                ? "cursor-not-allowed border border-border bg-surface text-fg-subtle"
                : "cursor-pointer bg-accent text-accent-fg shadow-sm hover:bg-accent-hover active:scale-[0.98]",
            )}
          >
            <CheckCheck className="size-4" aria-hidden />
            <span className="hidden sm:inline">Marcar todas</span>
          </button>
        </div>
      </div>

      {/* LISTA */}
      {notificaciones.isLoading ? (
        <p className="text-sm text-fg-muted">Cargando notificaciones…</p>
      ) : items.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 rounded-2xl border border-border bg-surface p-10 text-center shadow-sm">
          <div className="grid size-12 place-items-center rounded-2xl bg-surface-2 text-fg-subtle">
            <Bell className="size-6" aria-hidden />
          </div>
          <p className="text-sm font-medium text-fg">Sin notificaciones</p>
          <p className="text-xs text-fg-muted">Aquí aparecerán tus avisos.</p>
        </div>
      ) : (
        <div className="flex w-full flex-col gap-2">
          {items.map((n) => {
            const a = aspecto(n.severidad);
            const Icon = a.icon;
            return (
              <button
                key={n.id_notificacion}
                type="button"
                onClick={() => onCardClick(n)}
                className={cn(
                  "group flex w-full items-start gap-3 rounded-2xl border p-4 text-left shadow-sm transition",
                  n.leida
                    ? "border-border bg-surface hover:bg-surface-2"
                    : "border-accent/40 bg-accent-soft/40 hover:bg-accent-soft/60",
                )}
              >
                <div
                  className={cn(
                    "grid size-10 shrink-0 place-items-center rounded-xl",
                    a.className,
                  )}
                >
                  <Icon className="size-5" aria-hidden />
                </div>

                <div className="min-w-0 flex-1">
                  <div className="flex items-start justify-between gap-2">
                    <p
                      className={cn(
                        "truncate text-sm",
                        n.leida ? "font-medium text-fg" : "font-bold text-fg",
                      )}
                    >
                      {n.titulo}
                    </p>
                    <span className="shrink-0 text-xs text-fg-subtle">
                      {fmtFecha(n.creada_en)}
                    </span>
                  </div>

                  {n.cuerpo ? (
                    <p className="mt-0.5 line-clamp-2 text-sm text-fg-muted">{n.cuerpo}</p>
                  ) : null}
                </div>

                {!n.leida && (
                  <span
                    className="mt-1.5 size-2.5 shrink-0 rounded-full bg-accent"
                    aria-label="No leída"
                    title="No leída"
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
