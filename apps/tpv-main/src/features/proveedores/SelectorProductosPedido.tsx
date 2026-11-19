// src/features/proveedores/SelectorProductosPedido.tsx
//
// Elegir del catálogo lo que se pide: las categorías del inventario y sus productos, para no tener
// que escribir el nombre de cada línea. Lo elegido entra como líneas del pedido, que se siguen
// pudiendo cambiar o escribir a mano.
import { useMemo, useState } from "react";
import { Check, ListPlus } from "lucide-react";
import { toAppError } from "@tpv/client";
import type { ProductoProveedorDto } from "@tpv/contracts";

import Modal from "./Modal";
import { useProductosParaPedir, useProveedoresCategorias } from "./proveedoresQueries";
import { cn } from "../../shared/lib/cn";
import { contiene, textoABuscar } from "../../shared/lib/busqueda";
import { SearchInput } from "../../shared/ui";

/** Cómo se compara un nombre con los de las líneas que ya tiene el pedido. */
export function claveDeNombre(nombre: string): string {
  return textoABuscar(nombre) ?? "";
}

export default function SelectorProductosPedido({
  open,
  onClose,
  yaEnElPedido,
  onAnadir,
}: {
  open: boolean;
  onClose: () => void;
  /** Los nombres de las líneas que ya están (por `claveDeNombre`): se ven, pero no se repiten. */
  yaEnElPedido: ReadonlySet<string>;
  onAnadir: (productos: ProductoProveedorDto[]) => void;
}) {
  const categoriasQuery = useProveedoresCategorias();
  const productosQuery = useProductosParaPedir(open);

  const [categoria, setCategoria] = useState<string | null>(null);
  const [busqueda, setBusqueda] = useState("");
  const [elegidos, setElegidos] = useState<ReadonlySet<string>>(new Set());

  const productos = useMemo(() => productosQuery.data ?? [], [productosQuery.data]);
  const categorias = categoriasQuery.data ?? [];

  const visibles = useMemo(() => {
    const buscado = textoABuscar(busqueda);
    return productos.filter(
      (p) => (categoria === null || p.id_categoria === categoria) && (buscado === null || contiene(buscado, p.nombre)),
    );
  }, [productos, categoria, busqueda]);

  function cerrar() {
    setElegidos(new Set());
    setBusqueda("");
    setCategoria(null);
    onClose();
  }

  function alternar(id: string) {
    setElegidos((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function anadir() {
    onAnadir(productos.filter((p) => elegidos.has(p.id_producto)));
    cerrar();
  }

  const error = productosQuery.error ?? categoriasQuery.error;
  const chip = (activa: boolean) =>
    cn(
      "shrink-0 cursor-pointer whitespace-nowrap rounded-xl border px-3 py-1.5 text-sm font-semibold transition",
      activa ? "border-accent bg-accent text-accent-fg" : "border-border bg-surface text-fg-muted hover:bg-surface-2",
    );

  return (
    <Modal open={open} onClose={cerrar} title="Elegir productos" zIndex={80} widthClass="max-w-[720px]">
      <div className="flex flex-col gap-3">
        <SearchInput value={busqueda} onValueChange={setBusqueda} placeholder="Buscar producto..." />

        <div className="flex gap-1.5 overflow-x-auto pb-1 [scrollbar-gutter:stable]">
          <button type="button" className={chip(categoria === null)} onClick={() => setCategoria(null)}>
            Todas
          </button>
          {categorias.map((c) => (
            <button
              key={c.id_categoria}
              type="button"
              className={chip(categoria === c.id_categoria)}
              onClick={() => setCategoria(c.id_categoria)}
            >
              {c.nombre}
            </button>
          ))}
        </div>

        {error ? (
          <p role="alert" className="rounded-xl border border-danger/30 bg-danger-soft px-3 py-2 text-sm text-danger">
            No se pudieron cargar los productos: {toAppError(error).message}
          </p>
        ) : productosQuery.isPending ? null : visibles.length === 0 ? (
          <p className="py-6 text-center text-sm text-fg-muted">No hay productos con ese filtro.</p>
        ) : (
          <div className="grid max-h-[45dvh] grid-cols-1 gap-2 overflow-y-auto pr-1 sm:grid-cols-2">
            {visibles.map((p) => {
              const yaEsta = yaEnElPedido.has(claveDeNombre(p.nombre));
              const elegido = elegidos.has(p.id_producto);
              return (
                <button
                  key={p.id_producto}
                  type="button"
                  disabled={yaEsta}
                  aria-pressed={elegido}
                  onClick={() => alternar(p.id_producto)}
                  className={cn(
                    "flex min-w-0 items-center gap-2.5 rounded-xl border px-3 py-2 text-left transition",
                    elegido ? "border-accent bg-accent-soft" : "border-border bg-surface hover:bg-surface-2",
                    yaEsta ? "cursor-not-allowed opacity-60" : "cursor-pointer",
                  )}
                >
                  <span
                    className={cn(
                      "grid size-5 shrink-0 place-items-center rounded-md border",
                      elegido ? "border-accent bg-accent text-accent-fg" : "border-border-strong bg-surface",
                    )}
                  >
                    {elegido ? <Check className="size-3.5" aria-hidden /> : null}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-semibold text-fg">{p.nombre}</span>
                    <span className="block truncate text-xs text-fg-muted">
                      {yaEsta
                        ? "Ya está en el pedido"
                        : [p.unidad_medida, p.cantidad_pedido_esperada != null ? `Se suele pedir ${p.cantidad_pedido_esperada}` : null]
                            .filter(Boolean)
                            .join(" · ") || " "}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        )}

        <div className="grid grid-cols-2 gap-2 sm:flex sm:justify-end">
          <button
            type="button"
            onClick={cerrar}
            className="cursor-pointer rounded-xl border border-border bg-surface px-4 py-2 font-semibold text-fg transition hover:bg-surface-2"
          >
            Cancelar
          </button>
          <button
            type="button"
            onClick={anadir}
            disabled={elegidos.size === 0}
            className="inline-flex cursor-pointer items-center justify-center gap-1.5 rounded-xl bg-accent px-4 py-2 font-semibold text-accent-fg shadow-sm transition hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
          >
            <ListPlus className="size-4" aria-hidden />
            {elegidos.size === 0 ? "Añadir" : `Añadir ${elegidos.size}`}
          </button>
        </div>
      </div>
    </Modal>
  );
}
