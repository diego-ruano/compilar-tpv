// src/features/cuentas/DevolverModal.tsx
//
// Devolver PARTE de un cobro: unas líneas, o unas unidades de una línea. Lo hacen el administrador y
// el camarero (`docs/arquitectura/permisos.md`).
//
// Es dinero que sale por una venta real, así que el backend lo registra como un pago negativo con
// su factura rectificativa. Aquí se elige qué se devuelve, por dónde sale el dinero (sólo el
// efectivo resta del arqueo) y por qué. Lo que cuesta cada línea es una vista previa: el importe que
// vale es el que devuelve el backend.

import { useEffect, useMemo, useState } from "react";
import { Minus, Plus, Undo2, X } from "lucide-react";
import type { CobroDevolubleDto, DevolucionDto, Dinero, LineaDevolubleDto } from "@tpv/contracts";
import { toAppError } from "@tpv/client";

import { ModalShell } from "../../shared/ui";
import { cn } from "../../shared/lib/cn";
import { CERO, escalar, eur, restar, sumar } from "../../shared/lib/dinero";
import { conAviso } from "../../shared/lib/conAviso";
import { cuentasLineasDevolubles, type EntradaDto } from "./cuentasApis";
import { useDevolverLineas } from "./cuentasQueries";

type Metodo = "Efectivo" | "Tarjeta" | "Otro";

const METODOS: { valor: Metodo; detalle: string }[] = [
    { valor: "Efectivo", detalle: "Sale del cajón" },
    { valor: "Tarjeta", detalle: "Por el datáfono" },
    { valor: "Otro", detalle: "Transferencia, Bizum…" },
];

type Props = {
    entrada: EntradaDto;
    /** Empieza con todo lo que queda elegido: es «devolver lo que queda». */
    todo?: boolean;
    onCerrar: () => void;
    onHecho: (d: DevolucionDto) => void;
};

/** Una cantidad de stock, a milésimas como en el backend (RI-26). */
function milesimas(x: number): number {
    return Math.round(x * 1000) / 1000;
}

function quedan(l: LineaDevolubleDto): number {
    return milesimas(l.cantidad - l.devueltas);
}

/** Al peso (0,35 kg) no se cuentan unidades: se devuelve lo que queda o nada. */
function esAlPeso(l: LineaDevolubleDto): boolean {
    return !Number.isInteger(l.cantidad) || !Number.isInteger(l.devueltas);
}

/** Lo devuelto de una línea: lo devuelto en total después menos lo de antes, como el backend. */
function importeDe(l: LineaDevolubleDto, unidades: number): Dinero {
    if (unidades <= 0) return CERO;
    return restar(
        escalar(l.precio_unitario, milesimas(l.devueltas + unidades)),
        escalar(l.precio_unitario, l.devueltas),
    );
}

export default function DevolverModal({ entrada, todo = false, onCerrar, onHecho }: Props) {
    const [cobro, setCobro] = useState<CobroDevolubleDto | null>(null);
    const [errorCarga, setErrorCarga] = useState<string | null>(null);
    const [unidades, setUnidades] = useState<Record<string, number>>({});
    const [metodo, setMetodo] = useState<Metodo>("Efectivo");
    const [motivo, setMotivo] = useState("");
    const [error, setError] = useState<string | null>(null);
    const devolver = useDevolverLineas();
    const guardando = devolver.isPending;

    useEffect(() => {
        let vivo = true;
        cuentasLineasDevolubles(entrada.id)
            .then((c) => {
                if (!vivo) return;
                setCobro(c);
                setMetodo(c.metodo === "Tarjeta" ? "Tarjeta" : "Efectivo");
                if (todo) {
                    setUnidades(Object.fromEntries(c.lineas.map((l) => [l.id_detalle, quedan(l)])));
                }
            })
            .catch((e: unknown) => {
                if (vivo) setErrorCarga(toAppError(e).message);
            });
        return () => {
            vivo = false;
        };
    }, [entrada.id, todo]);

    const lineas = useMemo(() => cobro?.lineas ?? [], [cobro]);
    const total = useMemo(
        () => sumar(...lineas.map((l) => importeDe(l, unidades[l.id_detalle] ?? 0))),
        [lineas, unidades],
    );
    const elegidas = lineas.filter((l) => (unidades[l.id_detalle] ?? 0) > 0);
    const queda = lineas.some((l) => quedan(l) > 0);
    const puede = !guardando && elegidas.length > 0 && motivo.trim().length > 0;

    const poner = (l: LineaDevolubleDto, n: number) =>
        setUnidades((prev) => ({ ...prev, [l.id_detalle]: Math.max(0, Math.min(quedan(l), n)) }));

    const confirmar = async () => {
        setError(null);
        try {
            const hecha = await devolver.mutateAsync({
                id_pago: entrada.id,
                lineas: elegidas.map((l) => ({ id_detalle: l.id_detalle, cantidad: unidades[l.id_detalle] })),
                metodo,
                motivo: motivo.trim(),
            });
            onHecho(hecha);
        } catch (e) {
            setError(toAppError(e).message);
        }
    };

    const cerrar = () => (guardando ? null : onCerrar());

    return (
        <ModalShell open onClose={cerrar} className="fixed inset-0 z-[60] flex items-center justify-center">
            <div className="absolute inset-0 bg-black/40" onClick={cerrar} />

            <div className="relative flex max-h-[92vh] w-[600px] max-w-[94vw] flex-col rounded-3xl border border-border bg-surface p-6 shadow-xl">
                <div className="flex items-start justify-between gap-3">
                    <div className="flex min-w-0 items-start gap-3">
                        <div className="grid size-10 shrink-0 place-items-center rounded-2xl bg-accent-soft text-accent">
                            <Undo2 className="size-5" aria-hidden />
                        </div>
                        <div className="min-w-0">
                            <h3 className="text-lg font-semibold text-fg">Devolver</h3>
                            <p className="text-sm text-fg-muted">
                                {entrada.cliente} · {eur(entrada.importe)}
                                {cobro && cobro.devuelto > 0 ? ` · ya devuelto ${eur(cobro.devuelto)}` : ""}
                            </p>
                        </div>
                    </div>
                    <button
                        type="button"
                        className="grid size-9 cursor-pointer place-items-center rounded-xl border border-border bg-surface text-fg-muted transition hover:bg-surface-2 hover:text-fg"
                        onClick={cerrar}
                        title="Cancelar"
                    >
                        <X className="size-4" aria-hidden />
                    </button>
                </div>

                <div className="mt-4 min-h-0 flex-1 overflow-y-auto">
                    {errorCarga ? (
                        <p className="rounded-2xl border border-danger/30 bg-danger-soft px-4 py-2 text-sm text-danger">
                            {errorCarga}
                        </p>
                    ) : !cobro ? (
                        <p className="text-sm text-fg-muted">Cargando las líneas del cobro…</p>
                    ) : !queda ? (
                        <p className="text-sm text-fg-muted">De este cobro ya se ha devuelto todo.</p>
                    ) : (
                        <div className="grid gap-2">
                            <div className="flex items-center justify-between text-xs font-semibold text-fg-muted">
                                <span>Qué se devuelve</span>
                                <button
                                    type="button"
                                    disabled={guardando}
                                    onClick={() =>
                                        setUnidades(Object.fromEntries(lineas.map((l) => [l.id_detalle, quedan(l)])))
                                    }
                                    className="rounded-lg px-2 py-1 text-accent hover:bg-accent-soft"
                                >
                                    Todo lo que queda
                                </button>
                            </div>
                            {lineas.map((l) => {
                                const max = quedan(l);
                                const n = unidades[l.id_detalle] ?? 0;
                                return (
                                    <div
                                        key={l.id_detalle}
                                        className={cn(
                                            "flex items-center justify-between gap-3 rounded-2xl border px-4 py-2.5 text-sm",
                                            n > 0 ? "border-accent bg-accent/5" : "border-border bg-surface-2",
                                            max <= 0 && "opacity-50",
                                        )}
                                    >
                                        <div className="min-w-0">
                                            <div className="truncate font-semibold text-fg">{l.nombre}</div>
                                            <div className="text-xs text-fg-muted">
                                                {l.cantidad} × {eur(l.precio_unitario)}
                                                {l.devueltas > 0 ? ` · devueltas ${l.devueltas}` : ""}
                                            </div>
                                        </div>
                                        {max <= 0 ? (
                                            <span className="text-xs text-fg-muted">Devuelta</span>
                                        ) : esAlPeso(l) ? (
                                            <button
                                                type="button"
                                                disabled={guardando}
                                                onClick={() => poner(l, n > 0 ? 0 : max)}
                                                aria-pressed={n > 0}
                                                className={cn(
                                                    "h-9 rounded-xl border px-3 text-xs font-semibold",
                                                    n > 0
                                                        ? "border-accent bg-accent text-white"
                                                        : "border-border bg-surface text-fg",
                                                )}
                                            >
                                                {n > 0 ? `Devolver ${max}` : "No"}
                                            </button>
                                        ) : (
                                            <div className="flex items-center gap-2">
                                                <button
                                                    type="button"
                                                    title="Una menos"
                                                    disabled={guardando || n <= 0}
                                                    onClick={() => poner(l, n - 1)}
                                                    className="grid size-9 place-items-center rounded-xl border border-border bg-surface text-fg disabled:opacity-40"
                                                >
                                                    <Minus className="size-4" aria-hidden />
                                                </button>
                                                <span className="w-12 text-center font-bold text-fg">
                                                    {n} / {max}
                                                </span>
                                                <button
                                                    type="button"
                                                    title="Una más"
                                                    disabled={guardando || n >= max}
                                                    onClick={() => poner(l, n + 1)}
                                                    className="grid size-9 place-items-center rounded-xl border border-border bg-surface text-fg disabled:opacity-40"
                                                >
                                                    <Plus className="size-4" aria-hidden />
                                                </button>
                                            </div>
                                        )}
                                    </div>
                                );
                            })}

                            <div className="mt-3 text-xs font-semibold text-fg-muted">Cómo se devuelve el dinero</div>
                            <div className="grid grid-cols-3 gap-2">
                                {METODOS.map((m) => (
                                    <button
                                        key={m.valor}
                                        type="button"
                                        disabled={guardando}
                                        onClick={() => setMetodo(m.valor)}
                                        aria-pressed={metodo === m.valor}
                                        className={cn(
                                            "rounded-2xl border px-3 py-2 text-left transition",
                                            metodo === m.valor
                                                ? "border-accent bg-accent/10"
                                                : "border-border bg-surface hover:bg-surface-2",
                                        )}
                                    >
                                        <div className="text-sm font-semibold text-fg">{m.valor}</div>
                                        <div className="text-xs text-fg-muted">{m.detalle}</div>
                                    </button>
                                ))}
                            </div>

                            <label className="mt-3 block">
                                <span className="text-sm font-semibold text-fg">Motivo de la devolución</span>
                                <input
                                    type="text"
                                    value={motivo}
                                    onChange={(ev) => setMotivo(ev.target.value)}
                                    placeholder="Estaba frío, se cobró de más…"
                                    disabled={guardando}
                                    className="mt-1 h-10 w-full rounded-xl border border-border bg-surface px-3 text-sm text-fg outline-none focus:border-accent"
                                />
                            </label>
                        </div>
                    )}
                </div>

                {error ? (
                    <div className="mt-3 rounded-2xl border border-danger/30 bg-danger-soft px-4 py-2 text-sm text-danger">
                        {error}
                    </div>
                ) : null}

                <div className="mt-5 flex items-center justify-between gap-3">
                    <div className="text-sm text-fg-muted">
                        Se devuelven <strong className="text-fg">{eur(total)}</strong>
                    </div>
                    <div className="flex gap-2">
                        <button
                            type="button"
                            disabled={guardando}
                            onClick={onCerrar}
                            className="h-10 rounded-xl border border-border bg-surface px-4 text-sm font-semibold text-fg shadow-sm hover:bg-surface-2 active:scale-[0.97] disabled:opacity-60"
                        >
                            Cancelar
                        </button>
                        <button
                            type="button"
                            disabled={!puede}
                            onClick={conAviso(confirmar)}
                            className="h-10 rounded-xl border border-accent bg-accent px-5 text-sm font-bold text-white shadow-sm hover:bg-accent-hover active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-60"
                        >
                            {guardando ? "Devolviendo…" : "Devolver"}
                        </button>
                    </div>
                </div>
            </div>
        </ModalShell>
    );
}
