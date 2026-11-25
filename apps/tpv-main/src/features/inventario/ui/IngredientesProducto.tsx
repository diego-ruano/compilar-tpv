// Los ingredientes que lleva un producto, en su ficha: casillas agrupadas por categoría, plegado
// como los alérgenos. Con muchos ingredientes, el buscador filtra sin perder lo marcado. El catálogo
// sólo se pide al desplegarlo.

import { useMemo, useState } from "react";
import { Check } from "lucide-react";

import SearchInput from "../../../shared/ui/SearchInput";
import { contiene, textoABuscar } from "../../../shared/lib/busqueda";
import { agruparPorCategoria } from "../ingredientes";
import { useCatalogoIngredientes } from "../inventarioQueries";

type Props = {
    seleccionados: Set<string>;
    onChange: (next: Set<string>) => void;
    disabled?: boolean;
};

export default function IngredientesProducto(props: Props) {
    const [abierto, setAbierto] = useState(false);
    const marcados = props.seleccionados.size;
    return (
        <div>
            <button
                type="button"
                onClick={() => setAbierto((v) => !v)}
                disabled={props.disabled}
                className="flex w-full items-center justify-between rounded-2xl border border-border px-4 py-3 font-bold transition hover:bg-surface-2"
                aria-expanded={abierto}
            >
                <span>Ingredientes</span>
                <span className="text-sm font-semibold text-fg-muted">
                    {marcados ? `${marcados} seleccionados` : "—"}
                </span>
            </button>
            {abierto ? <PanelIngredientes {...props} /> : null}
        </div>
    );
}

function PanelIngredientes({ seleccionados, onChange, disabled }: Props) {
    const catalogo = useCatalogoIngredientes();
    const [busqueda, setBusqueda] = useState("");

    const grupos = useMemo(() => agruparPorCategoria(catalogo.data), [catalogo.data]);
    const buscado = textoABuscar(busqueda);
    const visibles = useMemo(
        () =>
            grupos
                .map((g) => ({
                    ...g,
                    ingredientes: buscado
                        ? g.ingredientes.filter((i) => contiene(buscado, i.Nombre, g.categoria.Nombre))
                        : g.ingredientes,
                }))
                .filter((g) => g.ingredientes.length > 0),
        [grupos, buscado],
    );

    const alternar = (id: string) => {
        const next = new Set(seleccionados);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        onChange(next);
    };

    return (
        <div className="mt-3 flex flex-col gap-3 rounded-2xl border border-border bg-surface-2 p-4">
            {catalogo.isLoading ? (
                <p className="text-sm text-fg-muted">Cargando…</p>
            ) : catalogo.isError ? (
                <p className="text-sm text-danger">No se pudieron cargar los ingredientes.</p>
            ) : grupos.length === 0 ? (
                <p className="text-sm text-fg-muted">No hay ingredientes. Créalos en Inventario → Ingredientes.</p>
            ) : (
                <>
                    <SearchInput value={busqueda} onValueChange={setBusqueda} placeholder="Buscar ingrediente…" />
                    {visibles.length === 0 ? (
                        <p className="text-sm text-fg-muted">Nada coincide con la búsqueda.</p>
                    ) : (
                        <div className="flex max-h-[360px] flex-col gap-3 overflow-y-auto pr-1">
                            {visibles.map(({ categoria, ingredientes }) => (
                                <div key={categoria.ID_Categoria_Ingrediente}>
                                    <p className="mb-2 text-xs font-bold uppercase tracking-wide text-fg-muted">
                                        {categoria.Nombre}
                                    </p>
                                    <div className="flex flex-wrap gap-2">
                                        {ingredientes.map((i) => {
                                            const marcado = seleccionados.has(i.ID_Ingrediente);
                                            return (
                                                <button
                                                    key={i.ID_Ingrediente}
                                                    type="button"
                                                    disabled={disabled}
                                                    onClick={() => alternar(i.ID_Ingrediente)}
                                                    aria-pressed={marcado}
                                                    className={[
                                                        "inline-flex cursor-pointer items-center gap-1.5 rounded-xl border px-3 py-2 text-sm font-semibold transition",
                                                        marcado
                                                            ? "border-accent bg-accent/10 text-fg"
                                                            : "border-border bg-surface text-fg-muted hover:bg-surface-2",
                                                    ].join(" ")}
                                                >
                                                    <span
                                                        className={[
                                                            "grid size-4 place-items-center rounded border",
                                                            marcado ? "border-accent bg-accent text-white" : "border-border",
                                                        ].join(" ")}
                                                    >
                                                        {marcado ? <Check className="size-3" aria-hidden /> : null}
                                                    </span>
                                                    {i.Nombre}
                                                </button>
                                            );
                                        })}
                                    </div>
                                </div>
                            ))}
                        </div>
                    )}
                </>
            )}
        </div>
    );
}
