import { commands, toAppError } from "@tpv/client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { nombreDeMesa } from "@tpv/plano/nombre";
import { cocinaSetLineaEstado, type KitchenRow } from "./mesasApi";
import { conAviso } from "../../shared/lib/conAviso";
import { useSyncSignal } from "../../shared/stores/useSyncSignal";

type KitchenLine = {
    idDetalle: string;
    cantidad: number;
    nombre: string;
    notas: string | null;
    estadoCocina: "PENDIENTE" | "PREPARADO" | string;
    pagado: 0 | 1;
};

type KitchenComanda = {
    idComanda: string;
    /** `null` en un ticket de barra, que no tiene mesa (RI-69). */
    mesa: string | null;
    apertura: string;
    lines: KitchenLine[];
};

function cn(...classes: Array<string | false | undefined | null>) {
    return classes.filter(Boolean).join(" ");
}

function formatFecha(dt: string) {
    if (!dt) return "";
    return dt.replace("T", " ").slice(0, 16);
}

function emitVrChanged() {
    window.dispatchEvent(new CustomEvent("vr:changed"));
}

export default function KitchenBoard({
    idUsuarioCocinero,
}: {
    idUsuarioCocinero: string | null;
}) {
    const [loading, setLoading] = useState(true);
    const [rows, setRows] = useState<KitchenRow[]>([]);
    const [refreshTick, setRefreshTick] = useState(0);
    const [error, setError] = useState<string | null>(null);
    const [ocupadas, setOcupadas] = useState<Set<string>>(() => new Set());
    const enCurso = useRef(new Set<string>());
    const lecturas = useRef({ version: 0, activo: true });
    useEffect(() => {
        const vista = lecturas.current;
        vista.activo = true;
        return () => { vista.activo = false; ++vista.version; };
    }, []);

    // ✅ Evitar auto-recarga del propio evento vr:changed que emite KitchenBoard
    const ignoreNextChanged = useRef(false);

    // ✅ Preservar scroll (sirve tanto si es ventana como contenedor)
    const scrollRef = useRef<HTMLDivElement>(null);
    const scrollPosRef = useRef({ winY: 0, boxY: 0 });
    const restorePendingRef = useRef(false);

    function rememberScroll() {
        restorePendingRef.current = true;
        scrollPosRef.current = {
            winY: window.scrollY ?? 0,
            boxY: scrollRef.current?.scrollTop ?? 0,
        };
    }

    function restoreScroll() {
        if (!restorePendingRef.current) return;
        restorePendingRef.current = false;

        requestAnimationFrame(() => {
            if (scrollRef.current) {
                scrollRef.current.scrollTop = scrollPosRef.current.boxY;
            }
            window.scrollTo({
                top: scrollPosRef.current.winY,
                behavior: "auto",
            });
        });
    }

    /** `mostrarCarga = false` relee sin quitar la lista de la vista (un aviso de otro equipo). */
    const load = useCallback(async (mostrarCarga = true) => {
        const lectura = ++lecturas.current.version;
        if (mostrarCarga) setLoading(true);
        try {
            const r = await commands.kitchenListTodayPending();
            if (!lecturas.current.activo || lectura !== lecturas.current.version) return;
            setRows(r);
            setError(null);
        } catch (e) {
            if (lecturas.current.activo && lectura === lecturas.current.version) setError(toAppError(e).message);
        } finally {
            if (lecturas.current.activo && lectura === lecturas.current.version) {
                setLoading(false);
                restoreScroll();
            }
        }
    }, []);

    useEffect(() => {
        void load();
    }, [load, refreshTick]);

    useEffect(() => {
        const onChanged = () => {
            // ✅ si el evento lo emitimos nosotros, lo ignoramos
            if (ignoreNextChanged.current) {
                ignoreNextChanged.current = false;
                return;
            }
            rememberScroll();
            setRefreshTick((x) => x + 1);
        };

        window.addEventListener("vr:changed", onChanged);
        return () => window.removeEventListener("vr:changed", onChanged);

    }, []);

    // INC-20261030-006: lo que cambia en otro equipo —una línea nueva, una nota, un Preparado, un
    // cobro, una retirada— llega por la señal de sincronización, y `vr:changed` es sólo de esta
    // ventana. Sin escucharla, una cocina abierta seguía vacía o con estados viejos hasta pulsar
    // Recargar. Mientras se marca una línea, la relectura espera a que termine: si no, el acuse de
    // la marca invalidaba la lectura en curso y el cambio remoto se perdía.
    const recargaPendiente = useRef(false);
    const recargarPorCambioRemoto = useCallback(() => {
        if (enCurso.current.size > 0) {
            recargaPendiente.current = true;
            return;
        }
        recargaPendiente.current = false;
        rememberScroll();
        void load(false);
    }, [load]);
    const syncTick = useSyncSignal((s) => s.tick);
    // El aviso que ya estaba al montar lo cubre la primera lectura.
    const tickAlMontar = useRef(syncTick);
    useEffect(() => {
        if (syncTick === tickAlMontar.current) return;
        const info = useSyncSignal.getState().comanda;
        if (info.touchedComanda || info.uncertain) recargarPorCambioRemoto();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [syncTick]);

    const comandas: KitchenComanda[] = useMemo(() => {
        const map = new Map<string, KitchenComanda>();

        for (const r of rows) {
            const idComanda = String(r.ID_Comanda ?? "");
            if (!map.has(idComanda)) {
                map.set(idComanda, {
                    idComanda,
                    mesa: r.Numero_Mesa ?? null,
                    apertura: String(r.Fecha_Hora_Apertura ?? ""),
                    lines: [],
                });
            }

            map.get(idComanda)!.lines.push({
                idDetalle: String(r.ID_Detalle ?? ""),
                cantidad: Number(r.Cantidad ?? 1),
                nombre: String(r.Nombre_Producto ?? ""),
                notas: r.Notas ? String(r.Notas) : null,
                estadoCocina:
                    (String(r.Estado_Cocina ?? "PENDIENTE") as any) ||
                    "PENDIENTE",
                pagado: Number(r.Pagado ?? 0) ? 1 : 0,
            });
        }

        // Ocultar comandas 100% preparadas
        return Array.from(map.values()).filter((c) => {
            if (!c.lines.length) return false;
            const pendientes = c.lines.filter(
                (l) => l.estadoCocina !== "PREPARADO",
            ).length;
            return pendientes > 0;
        });
    }, [rows]);

    const marcarLinea = useCallback(
        async (idDetalle: string, next: "PREPARADO" | "PENDIENTE") => {
            if (!idUsuarioCocinero || enCurso.current.has(idDetalle)) return;
            enCurso.current.add(idDetalle);
            setOcupadas(new Set(enCurso.current));
            ++lecturas.current.version;
            try {
                await cocinaSetLineaEstado({ idDetalle, idUsuarioCocinero, estado: next });
                if (!lecturas.current.activo) return;
                ++lecturas.current.version;
                // RI-47: la respuesta confirma esta transición; no desaparece nada antes del acuse.
                rememberScroll();
                setRows((prev) =>
                    prev.map((r) =>
                        r.ID_Detalle === idDetalle
                            ? { ...r, Estado_Cocina: next }
                            : r,
                    ),
                );

                // ✅ avisar al resto de la app, pero sin auto-refresh de KitchenBoard
                ignoreNextChanged.current = true;
                emitVrChanged();

                // ✅ por si el reflow mueve algo
                restoreScroll();
            } catch (e) {
                if (lecturas.current.activo) setError(toAppError(e).message);
                throw e;
            } finally {
                enCurso.current.delete(idDetalle);
                if (lecturas.current.activo) {
                    setOcupadas(new Set(enCurso.current));
                    setLoading(false);
                    if (recargaPendiente.current) recargarPorCambioRemoto();
                }
            }
        },
        [idUsuarioCocinero, recargarPorCambioRemoto],
    );

    return (
        <div className="h-full w-full rounded-2xl border border-border bg-surface p-6 shadow-sm">
            <div className="flex items-end justify-between gap-4">
                <div>
                    <h2 className="text-xl font-bold">COCINA</h2>
                    <p className="text-sm text-fg-muted">
                        Click en una línea para marcarla como preparada.
                    </p>
                    {!idUsuarioCocinero ? (
                        <p className="text-xs text-danger mt-1">
                            ⚠️ No hay usuario cocinero logueado.
                        </p>
                    ) : null}
                </div>

                <button
                    type="button"
                    onClick={() => {
                        rememberScroll();
                        setRefreshTick((x) => x + 1);
                    }}
                    className="h-9 px-3 rounded-xl border border-border bg-surface hover:bg-surface-2 text-sm font-semibold"
                >
                    Recargar
                </button>
            </div>

            {error && <p role="alert" className="mt-3 text-sm text-danger">{error}</p>}

            {/* ✅ si el scroll real lo hace un contenedor interno, este ref lo preserva */}
            <div ref={scrollRef} className="mt-6">
                {loading ? (
                    <div className="w-full grid place-items-center text-fg-muted py-20">
                        Cargando…
                    </div>
                ) : comandas.length === 0 ? (
                    <div className="w-full grid place-items-center text-fg-muted py-20">
                        {error ? "No se pudo cargar la cocina. Pulsa Recargar para reintentar." : "No hay comandas pendientes de cocina."}
                    </div>
                ) : (
                    <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
                        {comandas.map((c) => {
                            const pendientes = c.lines.filter(
                                (l) => l.estadoCocina !== "PREPARADO",
                            ).length;

                            return (
                                <div
                                    key={c.idComanda}
                                    className="rounded-2xl border border-border bg-surface p-4"
                                >
                                    <div className="flex items-center justify-between gap-3">
                                        <div className="min-w-0">
                                            <p className="text-lg font-extrabold">
                                                {c.mesa !== null ? nombreDeMesa(c.mesa) : "Barra"} · Comanda #
                                                {c.idComanda}
                                            </p>
                                            <p className="text-sm text-fg-muted">
                                                Apertura:{" "}
                                                {formatFecha(c.apertura)}
                                            </p>
                                        </div>

                                        <div
                                            className={cn(
                                                "px-3 py-1 rounded-xl text-sm font-bold border",
                                                pendientes > 0
                                                    ? "bg-amber-50 text-warning border-amber-200"
                                                    : "bg-emerald-50 text-emerald-800 border-emerald-200",
                                            )}
                                        >
                                            {pendientes > 0
                                                ? `${pendientes} pendiente`
                                                : "Todo preparado"}
                                        </div>
                                    </div>

                                    <div className="mt-4 flex flex-col gap-2">
                                        {c.lines.map((l) => {
                                            const preparado =
                                                l.estadoCocina === "PREPARADO";

                                            const pillPago =
                                                l.pagado === 1
                                                    ? "border-emerald-200 bg-emerald-50 text-emerald-800"
                                                    : "border-border bg-surface text-fg-muted";

                                            return (
                                                <button
                                                    key={l.idDetalle}
                                                    type="button"
                                                    disabled={
                                                        !idUsuarioCocinero || ocupadas.has(l.idDetalle)
                                                    }
                                                    aria-busy={ocupadas.has(l.idDetalle)}
                                                    onClick={conAviso(() =>
                                                        marcarLinea(
                                                            l.idDetalle,
                                                            preparado
                                                                ? "PENDIENTE"
                                                                : "PREPARADO",
                                                        )
                                                    )}
                                                    className={cn(
                                                        "w-full rounded-xl border p-3 text-left transition flex items-center justify-between gap-3",
                                                        "border-border hover:bg-surface-2",
                                                        !idUsuarioCocinero &&
                                                            "opacity-50 cursor-not-allowed",
                                                    )}
                                                >
                                                    <div className="flex items-start gap-3 min-w-0">
                                                        <div
                                                            className={cn(
                                                                "mt-0.5 w-6 h-6 rounded-full border flex items-center justify-center shrink-0",
                                                                preparado
                                                                    ? "border-success bg-emerald-500"
                                                                    : "border-border bg-surface",
                                                            )}
                                                        >
                                                            {preparado ? (
                                                                <div className="w-2.5 h-2.5 rounded-full bg-surface" />
                                                            ) : null}
                                                        </div>

                                                        <div className="min-w-0">
                                                            <p
                                                                className={cn(
                                                                    "font-semibold truncate",
                                                                    preparado &&
                                                                        "line-through text-fg-subtle",
                                                                )}
                                                            >
                                                                {l.cantidad}×{" "}
                                                                {l.nombre}
                                                            </p>

                                                            {l.notas ? (
                                                                <div className="mt-1">
                                                                    <span className="inline-flex max-w-full items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-2 py-1 text-xs font-semibold text-amber-900">
                                                                        <span className="shrink-0">
                                                                            📝
                                                                        </span>
                                                                        <span className="min-w-0 break-words">
                                                                            {
                                                                                l.notas
                                                                            }
                                                                        </span>
                                                                    </span>
                                                                </div>
                                                            ) : null}

                                                            <div className="mt-2 flex items-center gap-2 flex-wrap">
                                                                <span
                                                                    className={cn(
                                                                        "text-xs font-semibold",
                                                                        preparado
                                                                            ? "text-success"
                                                                            : "text-fg-subtle",
                                                                    )}
                                                                >
                                                                    {ocupadas.has(l.idDetalle) ? "Guardando…" : preparado
                                                                        ? "Preparado"
                                                                        : "Pendiente"}
                                                                </span>

                                                                <span
                                                                    className={cn(
                                                                        "text-[11px] font-bold px-2 py-1 rounded-full border",
                                                                        pillPago,
                                                                    )}
                                                                >
                                                                    {l.pagado ===
                                                                    1
                                                                        ? "PAGADO"
                                                                        : "NO PAGADO"}
                                                                </span>
                                                            </div>
                                                        </div>
                                                    </div>

                                                    <span
                                                        className={cn(
                                                            "text-xs font-semibold px-2 py-1 rounded-lg border",
                                                            preparado
                                                                ? "border-emerald-200 bg-emerald-50 text-success"
                                                                : "border-border bg-surface text-fg-muted",
                                                        )}
                                                    >
                                                        #{l.idDetalle}
                                                    </span>
                                                </button>
                                            );
                                        })}
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                )}
            </div>
        </div>
    );
}
