// src/features/inventario/hooks/useInventario.ts
//
// Carga de datos vía TanStack Query (ver ../inventarioQueries.ts). El estado de selección
// (categoriaSeleccionada) sigue siendo local; las listas se derivan de las queries cacheadas.
// La superficie pública del hook se conserva idéntica para no tocar el consumidor.
import { useEffect, useMemo, useState } from "react";
import type { CategoriaInvDto, ProductoListDto } from "@tpv/contracts";
import {
  useCategorias,
  useProductosByCategoria,
  useResumenInventario,
} from "../inventarioQueries";

export interface CategoriaDisplay extends CategoriaInvDto {
  urlImagen: string;
}

export interface ProductoDisplay extends ProductoListDto {
  urlImagen: string;
}

export function useInventario() {
  const [categoriaSeleccionada, setCategoriaSeleccionada] = useState<CategoriaDisplay | null>(null);

  const categoriasQuery = useCategorias();
  const resumenQuery = useResumenInventario();
  const productosQuery = useProductosByCategoria(
    categoriaSeleccionada ? categoriaSeleccionada.ID_Categoria : null,
  );

  const categorias = useMemo(() => categoriasQuery.data ?? [], [categoriasQuery.data]);
  const productos = useMemo(() => productosQuery.data ?? [], [productosQuery.data]);

  const proximosCaducar = useMemo(
    () => resumenQuery.data?.proximosCaducar ?? [],
    [resumenQuery.data],
  );
  const menosCantidad = useMemo(
    () => resumenQuery.data?.menosCantidad ?? [],
    [resumenQuery.data],
  );

  const loadingProductos = productosQuery.isFetching;

  const titulo = useMemo(() => {
    if (categoriaSeleccionada) return `INVENTARIO · ${categoriaSeleccionada.Nombre}`;
    return "INVENTARIO";
  }, [categoriaSeleccionada]);

  // Re-sincroniza la categoría seleccionada con la lista cacheada (p.ej. tras editar/recargar).
  // Si otro equipo la ha borrado, se deja de enseñar: seguir con la copia vieja dejaba editarla, y
  // guardar la volvía a crear (el guardado actualiza por id, o la da de alta si no está).
  useEffect(() => {
    if (!categoriaSeleccionada || categoriasQuery.data === undefined) return;
    const actualizada = categorias.find(
      (c) => c.ID_Categoria === categoriaSeleccionada.ID_Categoria,
    );
    if (!actualizada) {
      setCategoriaSeleccionada(null);
    } else if (actualizada !== categoriaSeleccionada) {
      setCategoriaSeleccionada(actualizada);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [categorias]);

  // Wrappers de recarga (conservan la firma usada por el consumidor).
  const cargarCategorias = async () => {
    await categoriasQuery.refetch();
  };

  const cargarProductos = async (_idCat: string) => {
    await productosQuery.refetch();
  };

  const cargarResumenInventario = async () => {
    await resumenQuery.refetch();
  };

  return {
    categorias,
    categoriaSeleccionada,
    productos,
    loadingProductos,
    proximosCaducar,
    menosCantidad,
    titulo,

    setCategoriaSeleccionada,

    cargarCategorias,
    cargarProductos,
    cargarResumenInventario,
  };
}
