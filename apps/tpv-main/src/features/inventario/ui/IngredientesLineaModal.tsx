// Lo que se pide distinto en una línea de la comanda: los ingredientes del producto salen marcados
// (desmarcar uno es «SIN»), cada uno con su «extra», y debajo el resto del catálogo, por
// categorías, para pedir algo que el producto no lleva. No cambia el precio. Lo usan las mesas y la
// venta rápida; la nota libre sigue aparte.

import React, { useEffect, useMemo, useState } from "react";
import { Check, ChevronDown, Plus, X } from "lucide-react";

import type { CambioIngredienteInput } from "@tpv/contracts";
import SearchInput from "../../../shared/ui/SearchInput";
import { conAviso } from "../../../shared/lib/conAviso";
import { contiene, textoABuscar } from "../../../shared/lib/busqueda";
import { agruparPorCategoria, cambiosParaGuardar, leerCambios, type CambioIngrediente } from "../ingredientes";
import { useCatalogoIngredientes, useIngredientesDeProducto } from "../inventarioQueries";

function Interruptor({
    activo,
    onClick,
    etiqueta,
    children,
    tono,
}: {
    activo: boolean;
    onClick: () => void;
    etiqueta: string;
    children: React.ReactNode;
    tono: "accent" | "warning" | "danger";
}) {
    const activoCls =
        tono === "danger"
            ? "border-danger/40 bg-danger-soft text-danger"
            : tono === "warning"
                ? "border-amber-300 bg-warning-soft text-warning"
                : "border-accent bg-accent/10 text-fg";
    return (
        <button
            type="button"
            onClick={onClick}
            aria-pressed={activo}
            aria-label={etiqueta}
            className={[
                "inline-flex min-h-10 cursor-pointer items-center gap-1.5 rounded-xl border px-3 py-2 text-sm font-semibold transition",
                activo ? activoCls : "border-border bg-surface text-fg-muted hover:bg-surface-2",
            ].join(" ")}
        >
            {children}
        </button>
    );
}

/** Se monta sólo mientras está abierta: hasta entonces no pide nada. */
export default function IngredientesLineaModal({
    productoId,
    productoNombre,
    cambiosGuardados,
    onCancel,
    onSave,
}: {
    productoId: string | null;
    productoNombre: string;
    /** El JSON de `Cambios_Ingredientes` de la línea. */
    cambiosGuardados: string | null;
    onCancel: () => void;
    onSave: (cambios: CambioIngredienteInput[]) => Promise<void>;
}) {
    const catalogo = useCatalogoIngredientes();
    const delProducto = useIngredientesDeProducto(productoId);

    const [quitados, setQuitados] = useState<Set<string>>(new Set());
    const [extras, setExtras] = useState<Set<string>>(new Set());
    const [busqueda, setBusqueda] = useState("");
    const [verOtros, setVerOtros] = useState(false);
    const [guardando, setGuardando] = useState(false);

    // Lo guardado en la línea, también con el nombre que tenía al pedirlo (por si el ingrediente
    // se renombró o se borró después).
    const guardados = useMemo(() => leerCambios(cambiosGuardados), [cambiosGuardados]);

    useEffect(() => {
        setQuitados(new Set(guardados.filter((c) => c.tipo === "SIN").map((c) => c.id)));
        setExtras(new Set(guardados.filter((c) => c.tipo === "EXTRA").map((c) => c.id)));
        setBusqueda("");
        setVerOtros(false);
        setGuardando(false);
    }, [guardados]);

    const nombres = useMemo(() => {
        const m = new Map<string, string>();
        for (const c of guardados) m.set(c.id, c.nombre);
        for (const i of catalogo.data?.ingredientes ?? []) m.set(i.ID_Ingrediente, i.Nombre);
        return m;
    }, [catalogo.data, guardados]);

    const idsDelProducto = useMemo(() => new Set(delProducto.data ?? []), [delProducto.data]);
    const grupos = useMemo(() => agruparPorCategoria(catalogo.data), [catalogo.data]);

    // Los del producto, en el orden del catálogo (por categoría y nombre). Un «sin» guardado de uno
    // que el producto ya no lleva se sigue enseñando, para poder quitarlo.
    const lineaBase = useMemo(() => {
        const ids = grupos.flatMap((g) => g.ingredientes.map((i) => i.ID_Ingrediente)).filter((id) => idsDelProducto.has(id));
        for (const c of guardados) if (c.tipo === "SIN" && !ids.includes(c.id)) ids.push(c.id);
        return ids;
    }, [grupos, idsDelProducto, guardados]);

    const buscado = textoABuscar(busqueda);
    const otros = useMemo(
        () =>
            grupos
                .map((g) => ({
                    ...g,
                    ingredientes: g.ingredientes.filter(
                        (i) =>
                            !idsDelProducto.has(i.ID_Ingrediente) &&
                            (!buscado || contiene(buscado, i.Nombre, g.categoria.Nombre)),
                    ),
                }))
                .filter((g) => g.ingredientes.length > 0),
        [grupos, idsDelProducto, buscado],
    );
    // Los «extra» de algo que el producto no lleva, a la vista aunque la lista esté plegada (también
    // uno guardado que ya no está en el catálogo), para poder quitarlos.
    const extrasDeFuera = [...extras].filter((id) => !idsDelProducto.has(id));

    const alternar = (set: Set<string>, id: string) => {
        const next = new Set(set);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
    };

    const quitar = (id: string) => {
        setQuitados((prev) => alternar(prev, id));
        setExtras((prev) => {
            const next = new Set(prev);
            next.delete(id);
            return next;
        });
    };

    const cambios: CambioIngrediente[] = [
        ...[...quitados].map((id) => ({ id, nombre: nombres.get(id) ?? "", tipo: "SIN" as const })),
        ...[...extras].map((id) => ({ id, nombre: nombres.get(id) ?? "", tipo: "EXTRA" as const })),
    ].filter((c) => c.nombre);

    const guardar = conAviso(async () => {
        setGuardando(true);
        try {
            await onSave(cambiosParaGuardar(cambios));
        } finally {
            setGuardando(false);
        }
    }, "No se pudieron guardar los ingredientes");

    const cargando = catalogo.isLoading || delProducto.isLoading;
    const fallo = catalogo.isError || delProducto.isError;

    return (
        <div className="fixed inset-0 z-[10000] grid place-items-center bg-black/50 p-2 sm:p-4">
            <div className="flex max-h-[calc(100dvh-1rem)] w-full max-w-[620px] flex-col overflow-hidden rounded-2xl border border-border bg-surface shadow-xl">
                <div className="flex items-center justify-between gap-3 border-b border-border p-3 sm:p-4">
                    <div className="min-w-0">
                        <p className="text-sm font-semibold text-fg-subtle">Ingredientes</p>
                        <p className="truncate text-lg font-extrabold text-fg">{productoNombre}</p>
                    </div>
                    <button
                        type="button"
                        onClick={onCancel}
                        title="Cerrar"
                        aria-label="Cerrar"
                        className="grid size-10 cursor-pointer place-items-center rounded-xl border border-border bg-surface text-fg-muted transition hover:bg-surface-2 hover:text-fg"
                    >
                        <X className="size-4" aria-hidden />
                    </button>
                </div>

                <div className="flex min-h-0 flex-col gap-4 overflow-y-auto p-3 sm:p-4">
                    {cargando ? (
                        <p className="text-sm text-fg-muted">Cargando…</p>
                    ) : fallo ? (
                        <p className="text-sm text-danger">No se pudieron cargar los ingredientes.</p>
                    ) : (
                        <>
                            <section>
                                <p className="mb-2 text-xs font-bold uppercase tracking-wide text-fg-muted">
                                    Lleva
                                </p>
                                {lineaBase.length === 0 ? (
                                    <p className="text-sm text-fg-muted">
                                        Este producto no tiene ingredientes asignados. Se asignan en su ficha de
                                        Inventario.
                                    </p>
                                ) : (
                                    <div className="flex flex-col gap-2">
                                        {lineaBase.map((id) => {
                                            const lleva = !quitados.has(id);
                                            const nombre = nombres.get(id) ?? "";
                                            return (
                                                <div
                                                    key={id}
                                                    className="flex items-center justify-between gap-2 rounded-xl border border-border bg-surface-2 p-2"
                                                >
                                                    <Interruptor
                                                        activo={!lleva}
                                                        tono="danger"
                                                        etiqueta={lleva ? `Quitar ${nombre}` : `Volver a poner ${nombre}`}
                                                        onClick={() => quitar(id)}
                                                    >
                                                        <span
                                                            className={[
                                                                "grid size-4 place-items-center rounded border",
                                                                lleva ? "border-accent bg-accent text-white" : "border-danger/40",
                                                            ].join(" ")}
                                                        >
                                                            {lleva ? <Check className="size-3" aria-hidden /> : null}
                                                        </span>
                                                        <span className={lleva ? "text-fg" : "line-through"}>{nombre}</span>
                                                        {!lleva ? <span className="text-xs font-bold">SIN</span> : null}
                                                    </Interruptor>
                                                    {lleva ? (
                                                        <Interruptor
                                                            activo={extras.has(id)}
                                                            tono="warning"
                                                            etiqueta={`Extra de ${nombre}`}
                                                            onClick={() => setExtras((prev) => alternar(prev, id))}
                                                        >
                                                            <Plus className="size-4" aria-hidden />
                                                            Extra
                                                        </Interruptor>
                                                    ) : null}
                                                </div>
                                            );
                                        })}
                                    </div>
                                )}
                            </section>

                            <section>
                                <button
                                    type="button"
                                    onClick={() => setVerOtros((v) => !v)}
                                    className="flex w-full cursor-pointer items-center justify-between rounded-xl border border-border px-3 py-2 text-sm font-bold transition hover:bg-surface-2"
                                    aria-expanded={verOtros}
                                >
                                    <span>Añadir otro ingrediente</span>
                                    <ChevronDown
                                        className={`size-4 text-fg-muted transition ${verOtros ? "" : "-rotate-90"}`}
                                        aria-hidden
                                    />
                                </button>

                                {extrasDeFuera.length > 0 ? (
                                    <div className="mt-2 flex flex-wrap gap-2">
                                        {extrasDeFuera.map((id) => (
                                                <Interruptor
                                                    key={id}
                                                    activo
                                                    tono="warning"
                                                    etiqueta={`Quitar el extra de ${nombres.get(id) ?? ""}`}
                                                    onClick={() => setExtras((prev) => alternar(prev, id))}
                                                >
                                                    EXTRA {nombres.get(id)}
                                                    <X className="size-3.5" aria-hidden />
                                                </Interruptor>
                                            ))}
                                    </div>
                                ) : null}

                                {verOtros ? (
                                    <div className="mt-3 flex flex-col gap-3">
                                        <SearchInput
                                            value={busqueda}
                                            onValueChange={setBusqueda}
                                            placeholder="Buscar ingrediente…"
                                        />
                                        {otros.length === 0 ? (
                                            <p className="text-sm text-fg-muted">
                                                {buscado ? "Nada coincide con la búsqueda." : "No hay más ingredientes."}
                                            </p>
                                        ) : (
                                            otros.map(({ categoria, ingredientes }) => (
                                                <div key={categoria.ID_Categoria_Ingrediente}>
                                                    <p className="mb-2 text-xs font-bold uppercase tracking-wide text-fg-muted">
                                                        {categoria.Nombre}
                                                    </p>
                                                    <div className="flex flex-wrap gap-2">
                                                        {ingredientes.map((i) => (
                                                            <Interruptor
                                                                key={i.ID_Ingrediente}
                                                                activo={extras.has(i.ID_Ingrediente)}
                                                                tono="warning"
                                                                etiqueta={`Extra de ${i.Nombre}`}
                                                                onClick={() => setExtras((prev) => alternar(prev, i.ID_Ingrediente))}
                                                            >
                                                                <Plus className="size-4" aria-hidden />
                                                                {i.Nombre}
                                                            </Interruptor>
                                                        ))}
                                                    </div>
                                                </div>
                                            ))
                                        )}
                                    </div>
                                ) : null}
                            </section>
                        </>
                    )}
                </div>

                <div className="grid grid-cols-2 gap-2 border-t border-border p-3 sm:flex sm:items-center sm:justify-end sm:p-4">
                    <button
                        type="button"
                        onClick={onCancel}
                        className="rounded-xl border border-border bg-surface px-4 py-2 text-sm font-semibold hover:bg-surface-2"
                    >
                        Cancelar
                    </button>
                    <button
                        type="button"
                        disabled={guardando || cargando || fallo}
                        onClick={guardar}
                        className="rounded-xl bg-accent px-4 py-2 text-sm font-semibold text-white hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
                    >
                        Guardar
                    </button>
                </div>
            </div>
        </div>
    );
}
