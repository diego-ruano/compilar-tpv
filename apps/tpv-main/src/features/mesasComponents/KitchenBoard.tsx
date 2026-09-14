import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
    cocinaListHoyPendientes,
    cocinaSetLineaEstado,
    type KitchenRow,
} from "./mesasApi";
import { conAviso } from "../../shared/lib/conAviso";

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
    mesa: string;
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

    const load = useCallback(async () => {
        setLoading(true);
        try {
            const r = await cocinaListHoyPendientes();
            setRows(r ?? []);
        } catch (e) {
            console.error("KitchenBoard load error:", e);
            setRows([]);
        } finally {
            setLoading(false);
            // ✅ si veníamos de una recarga/refresh, restauramos scroll
            restoreScroll();
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

    const comandas: KitchenComanda[] = useMemo(() => {
        const map = new Map<string, KitchenComanda>();

        for (const r of rows) {
            const idComanda = String(r.ID_Comanda ?? "");
            if (!map.has(idComanda)) {
                map.set(idComanda, {
                    idComanda,
                    mesa: String(r.Numero_Mesa ?? ""),
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
            try {
                if (!idUsuarioCocinero) return;

                // ✅ evitar salto: guardamos scroll antes de tocar estado/DOM
                rememberScroll();

                // ✅ optimistic update: NO recargamos toda la lista, así no “sube arriba”
                setRows((prev) =>
                    prev.map((r) =>
                        String(r.ID_Detalle ?? "") === idDetalle
                            ? { ...r, Estado_Cocina: next }
                            : r,
                    ),
                );

                await cocinaSetLineaEstado({
                    idDetalle,
                    idUsuarioCocinero,
                    estado: next,
                });

                // ✅ avisar al resto de la app, pero sin auto-refresh de KitchenBoard
                ignoreNextChanged.current = true;
                emitVrChanged();

                // ✅ por si el reflow mueve algo
                restoreScroll();
            } catch (e) {
                console.error("Error marcando cocina:", e);
                // fallback opcional:
                // rememberScroll();
                // setRefreshTick((x) => x + 1);
            }
        },
        [idUsuarioCocinero],
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

            {/* ✅ si el scroll real lo hace un contenedor interno, este ref lo preserva */}
            <div ref={scrollRef} className="mt-6">
                {loading ? (
                    <div className="w-full grid place-items-center text-fg-muted py-20">
                        Cargando…
                    </div>
                ) : comandas.length === 0 ? (
                    <div className="w-full grid place-items-center text-fg-muted py-20">
                        No hay comandas pendientes de cocina.
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
                                                Mesa {c.mesa} · Comanda #
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
                                                        !idUsuarioCocinero
                                                    }
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
                                                                    {preparado
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
