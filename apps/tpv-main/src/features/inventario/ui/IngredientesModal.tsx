// La lista de ingredientes del negocio, agrupada por categorías (Pan, Salsas, Quesos…). Sin
// cantidades ni stock: sólo los nombres que luego se marcan en cada producto y se quitan o se
// piden de más en una comanda. Se abre desde la cabecera de Inventario.

import { useMemo, useState } from "react";
import { Check, ChevronDown, Pencil, Plus, Trash2, X } from "lucide-react";

import Modal from "./Modal";
import SearchInput from "../../../shared/ui/SearchInput";
import { conAviso } from "../../../shared/lib/conAviso";
import { contiene, textoABuscar } from "../../../shared/lib/busqueda";
import { usePermisos } from "../../../shared/lib/usePermisos";
import { agruparPorCategoria } from "../ingredientes";
import {
    useBorrarCategoriaIngrediente,
    useBorrarIngrediente,
    useCatalogoIngredientes,
    useGuardarCategoriaIngrediente,
    useGuardarIngrediente,
} from "../inventarioQueries";

const campo =
    "h-10 w-full min-w-0 rounded-xl border border-border bg-surface px-3 text-sm outline-none focus:ring-2 focus:ring-ring";
const botonIcono =
    "grid size-9 shrink-0 cursor-pointer place-items-center rounded-lg border border-border text-fg-muted transition hover:bg-surface-2 hover:text-fg disabled:cursor-not-allowed disabled:opacity-50";

/** Un nombre que se puede cambiar en el sitio: lápiz → campo con ✓ y ✕. */
function NombreEditable({
    nombre,
    puedeEditar,
    onGuardar,
    className,
}: {
    nombre: string;
    puedeEditar: boolean;
    onGuardar: (nuevo: string) => Promise<void>;
    className?: string;
}) {
    const [editando, setEditando] = useState(false);
    const [valor, setValor] = useState(nombre);

    if (!editando) {
        return (
            <div className="flex min-w-0 flex-1 items-center gap-2">
                <span className={`truncate ${className ?? ""}`}>{nombre}</span>
                {puedeEditar ? (
                    <button
                        type="button"
                        className={botonIcono}
                        title="Cambiar el nombre"
                        aria-label={`Cambiar el nombre de ${nombre}`}
                        onClick={(e) => {
                            e.stopPropagation();
                            setValor(nombre);
                            setEditando(true);
                        }}
                    >
                        <Pencil className="size-4" aria-hidden />
                    </button>
                ) : null}
            </div>
        );
    }

    const guardar = conAviso(async () => {
        const limpio = valor.trim();
        if (!limpio || limpio === nombre) {
            setEditando(false);
            return;
        }
        await onGuardar(limpio);
        setEditando(false);
    }, "No se pudo cambiar el nombre");

    return (
        <form
            className="flex min-w-0 flex-1 items-center gap-2"
            onClick={(e) => e.stopPropagation()}
            onSubmit={(e) => {
                e.preventDefault();
                guardar();
            }}
        >
            <input
                autoFocus
                value={valor}
                onChange={(e) => setValor(e.target.value)}
                onKeyDown={(e) => {
                    if (e.key === "Escape") setEditando(false);
                }}
                className={campo}
                aria-label="Nombre"
            />
            <button type="submit" className={botonIcono} title="Guardar" aria-label="Guardar">
                <Check className="size-4" aria-hidden />
            </button>
            <button
                type="button"
                className={botonIcono}
                title="Cancelar"
                aria-label="Cancelar"
                onClick={() => setEditando(false)}
            >
                <X className="size-4" aria-hidden />
            </button>
        </form>
    );
}

/** Borrar en dos pasos: la papelera pide confirmación en el sitio. */
function BotonBorrar({
    aviso,
    puedeEditar,
    onBorrar,
}: {
    aviso: string;
    puedeEditar: boolean;
    onBorrar: () => Promise<void>;
}) {
    const [confirmando, setConfirmando] = useState(false);
    if (!puedeEditar) return null;
    if (!confirmando) {
        return (
            <button
                type="button"
                className={`${botonIcono} hover:border-danger/30 hover:bg-danger-soft hover:text-danger`}
                title="Borrar"
                aria-label="Borrar"
                onClick={(e) => {
                    e.stopPropagation();
                    setConfirmando(true);
                }}
            >
                <Trash2 className="size-4" aria-hidden />
            </button>
        );
    }
    return (
        <div className="flex shrink-0 items-center gap-2" onClick={(e) => e.stopPropagation()}>
            <span className="hidden text-xs text-fg-muted sm:inline">{aviso}</span>
            <button
                type="button"
                className="h-9 cursor-pointer rounded-lg bg-danger px-3 text-xs font-semibold text-white transition hover:opacity-90"
                onClick={conAviso(async () => {
                    await onBorrar();
                    setConfirmando(false);
                }, "No se pudo borrar")}
            >
                Borrar
            </button>
            <button
                type="button"
                className="h-9 cursor-pointer rounded-lg border border-border px-3 text-xs font-semibold transition hover:bg-surface-2"
                onClick={() => setConfirmando(false)}
            >
                No
            </button>
        </div>
    );
}

export default function IngredientesModal({ open, onClose }: { open: boolean; onClose: () => void }) {
    const { puede } = usePermisos();
    const puedeEditar = puede("catalogo.editar");

    const catalogo = useCatalogoIngredientes();
    const guardarCategoria = useGuardarCategoriaIngrediente();
    const borrarCategoria = useBorrarCategoriaIngrediente();
    const guardarIngrediente = useGuardarIngrediente();
    const borrarIngrediente = useBorrarIngrediente();

    const [nuevaCategoria, setNuevaCategoria] = useState("");
    const [nuevoIngrediente, setNuevoIngrediente] = useState<Record<string, string>>({});
    const [abiertas, setAbiertas] = useState<Set<string>>(new Set());
    const [busqueda, setBusqueda] = useState("");

    const grupos = useMemo(() => agruparPorCategoria(catalogo.data), [catalogo.data]);
    const buscado = textoABuscar(busqueda);

    // Con algo buscado se ven sólo las categorías que coinciden o que tienen un ingrediente que
    // coincide, abiertas, y de éstas sólo lo que coincide (salvo si coincide la categoría entera).
    const visibles = useMemo(() => {
        if (!buscado) return grupos;
        return grupos.flatMap((g) => {
            if (contiene(buscado, g.categoria.Nombre)) return [g];
            const ingredientes = g.ingredientes.filter((i) => contiene(buscado, i.Nombre));
            return ingredientes.length ? [{ ...g, ingredientes }] : [];
        });
    }, [grupos, buscado]);

    const alternar = (id: string) =>
        setAbiertas((prev) => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });

    const crearCategoria = conAviso(async () => {
        const nombre = nuevaCategoria.trim();
        if (!nombre) return;
        const id = await guardarCategoria.mutateAsync({ nombre });
        setNuevaCategoria("");
        setAbiertas((prev) => new Set(prev).add(id));
    }, "No se pudo crear la categoría");

    const crearIngrediente = (idCategoria: string) =>
        conAviso(async () => {
            const nombre = (nuevoIngrediente[idCategoria] ?? "").trim();
            if (!nombre) return;
            await guardarIngrediente.mutateAsync({ id_categoria_ingrediente: idCategoria, nombre });
            setNuevoIngrediente((prev) => ({ ...prev, [idCategoria]: "" }));
        }, "No se pudo añadir el ingrediente");

    return (
        <Modal open={open} onClose={onClose} title="Ingredientes" maxWidthClass="max-w-[760px]">
            <div className="flex flex-col gap-4">
                <p className="text-sm text-fg-muted">
                    Agrupa los ingredientes por categorías y márcalos luego en cada producto. Al pedir,
                    se pueden quitar o pedir de más. No cambian el precio ni el stock.
                </p>

                {puedeEditar ? (
                    <form
                        className="flex gap-2"
                        onSubmit={(e) => {
                            e.preventDefault();
                            crearCategoria();
                        }}
                    >
                        <input
                            value={nuevaCategoria}
                            onChange={(e) => setNuevaCategoria(e.target.value)}
                            placeholder="Nueva categoría (p. ej. Pan, Salsas, Quesos)"
                            className={campo}
                            aria-label="Nombre de la nueva categoría"
                        />
                        <button
                            type="submit"
                            disabled={!nuevaCategoria.trim() || guardarCategoria.isPending}
                            className="inline-flex h-10 shrink-0 cursor-pointer items-center gap-1.5 rounded-xl bg-accent px-3 text-sm font-semibold text-accent-fg transition hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
                        >
                            <Plus className="size-4" aria-hidden />
                            <span className="hidden xs:inline">Añadir categoría</span>
                        </button>
                    </form>
                ) : null}

                {grupos.length > 0 ? (
                    <SearchInput value={busqueda} onValueChange={setBusqueda} placeholder="Buscar ingrediente…" />
                ) : null}

                {catalogo.isLoading ? (
                    <p className="text-sm text-fg-muted">Cargando…</p>
                ) : catalogo.isError ? (
                    <p className="text-sm text-danger">No se pudieron cargar los ingredientes.</p>
                ) : grupos.length === 0 ? (
                    <p className="rounded-2xl border border-dashed border-border p-4 text-center text-sm text-fg-muted">
                        Todavía no hay ingredientes. Empieza creando una categoría.
                    </p>
                ) : visibles.length === 0 ? (
                    <p className="text-sm text-fg-muted">Nada coincide con la búsqueda.</p>
                ) : (
                    <div className="flex flex-col gap-2">
                        {visibles.map(({ categoria, ingredientes }) => {
                            const id = categoria.ID_Categoria_Ingrediente;
                            const abierta = Boolean(buscado) || abiertas.has(id);
                            return (
                                <div key={id} className="rounded-2xl border border-border bg-surface-2">
                                    <div
                                        role="button"
                                        tabIndex={0}
                                        onClick={() => alternar(id)}
                                        onKeyDown={(e) => {
                                            if (e.target !== e.currentTarget) return;
                                            if (e.key === "Enter" || e.key === " ") {
                                                e.preventDefault();
                                                alternar(id);
                                            }
                                        }}
                                        className="flex cursor-pointer items-center gap-2 p-3"
                                        aria-expanded={abierta}
                                    >
                                        <ChevronDown
                                            className={`size-4 shrink-0 text-fg-muted transition ${abierta ? "" : "-rotate-90"}`}
                                            aria-hidden
                                        />
                                        <NombreEditable
                                            nombre={categoria.Nombre}
                                            className="font-bold"
                                            puedeEditar={puedeEditar}
                                            onGuardar={async (nombre) => {
                                                await guardarCategoria.mutateAsync({
                                                    id_categoria_ingrediente: id,
                                                    nombre,
                                                });
                                            }}
                                        />
                                        <span className="shrink-0 text-xs font-semibold text-fg-muted">
                                            {ingredientes.length}
                                        </span>
                                        <BotonBorrar
                                            aviso={
                                                ingredientes.length
                                                    ? "Se borra con sus ingredientes"
                                                    : "¿Borrar la categoría?"
                                            }
                                            puedeEditar={puedeEditar}
                                            onBorrar={() => borrarCategoria.mutateAsync(id)}
                                        />
                                    </div>

                                    {abierta ? (
                                        <div className="flex flex-col gap-2 border-t border-border p-3">
                                            {ingredientes.length === 0 ? (
                                                <p className="text-sm text-fg-muted">Sin ingredientes todavía.</p>
                                            ) : (
                                                ingredientes.map((i) => (
                                                    <div
                                                        key={i.ID_Ingrediente}
                                                        className="flex items-center gap-2 rounded-xl border border-border bg-surface px-3 py-2"
                                                    >
                                                        <NombreEditable
                                                            nombre={i.Nombre}
                                                            className="text-sm font-semibold"
                                                            puedeEditar={puedeEditar}
                                                            onGuardar={async (nombre) => {
                                                                await guardarIngrediente.mutateAsync({
                                                                    id_ingrediente: i.ID_Ingrediente,
                                                                    id_categoria_ingrediente: id,
                                                                    nombre,
                                                                });
                                                            }}
                                                        />
                                                        <BotonBorrar
                                                            aviso="Se quita de los productos"
                                                            puedeEditar={puedeEditar}
                                                            onBorrar={() => borrarIngrediente.mutateAsync(i.ID_Ingrediente)}
                                                        />
                                                    </div>
                                                ))
                                            )}

                                            {puedeEditar ? (
                                                <form
                                                    className="flex gap-2"
                                                    onSubmit={(e) => {
                                                        e.preventDefault();
                                                        crearIngrediente(id)();
                                                    }}
                                                >
                                                    <input
                                                        value={nuevoIngrediente[id] ?? ""}
                                                        onChange={(e) =>
                                                            setNuevoIngrediente((prev) => ({
                                                                ...prev,
                                                                [id]: e.target.value,
                                                            }))
                                                        }
                                                        placeholder={`Nuevo ingrediente en ${categoria.Nombre}`}
                                                        className={campo}
                                                        aria-label={`Nuevo ingrediente en ${categoria.Nombre}`}
                                                    />
                                                    <button
                                                        type="submit"
                                                        disabled={!(nuevoIngrediente[id] ?? "").trim()}
                                                        className={botonIcono}
                                                        title="Añadir ingrediente"
                                                        aria-label="Añadir ingrediente"
                                                    >
                                                        <Plus className="size-4" aria-hidden />
                                                    </button>
                                                </form>
                                            ) : null}
                                        </div>
                                    ) : null}
                                </div>
                            );
                        })}
                    </div>
                )}
            </div>
        </Modal>
    );
}
