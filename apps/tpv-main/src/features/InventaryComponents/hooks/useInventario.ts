// src/features/InventaryComponents/hooks/useInventario.ts
import { useEffect, useMemo, useState } from "react";
import { fileUrlFromAppData } from "../utils/inventarioImages";
import {
  inventarioAPI,
  type CategoriaRow,
  type ProductoListRow,
  type ProductoResumen,
} from "../api/inventarioAPI";

export interface CategoriaDisplay extends CategoriaRow {
  urlImagen: string;
}

export interface ProductoDisplay extends ProductoListRow {
  urlImagen: string;
}

export function useInventario() {
  const [categorias, setCategorias] = useState<CategoriaDisplay[]>([]);
  const [categoriaSeleccionada, setCategoriaSeleccionada] = useState<CategoriaDisplay | null>(null);

  const [productos, setProductos] = useState<ProductoDisplay[]>([]);
  const [loadingProductos, setLoadingProductos] = useState(false);

  const [proximosCaducar, setProximosCaducar] = useState<ProductoResumen[]>([]);
  const [menosCantidad, setMenosCantidad] = useState<ProductoResumen[]>([]);

  const titulo = useMemo(() => {
    if (categoriaSeleccionada) return `INVENTARIO · ${categoriaSeleccionada.Nombre}`;
    return "INVENTARIO";
  }, [categoriaSeleccionada]);

  const cargarCategorias = async () => {
    const rows = await inventarioAPI.listCategorias();

    const procesadas = await Promise.all(
      (rows ?? [])
        .filter((c) => Number.isFinite(c.ID_Categoria) && c.ID_Categoria > 0)
        .map(async (cat) => {
          const ruta = (cat.Ruta_Imagen ?? "").trim();

          // ✅ si no hay ruta, no intentamos resolver fileUrl
          if (!ruta) return { ...cat, urlImagen: "" };

          const urlImagen =
            ruta.startsWith("http://") ||
            ruta.startsWith("https://") ||
            ruta.startsWith("asset://") ||
            ruta.startsWith("tauri://")
              ? ruta
              : await fileUrlFromAppData(ruta);

          return { ...cat, urlImagen };
        }),
    );

    setCategorias(procesadas);
  };

  const cargarProductos = async (idCat: number) => {
    setLoadingProductos(true);
    try {
      const rows = await inventarioAPI.listProductosByCategoria(Number(idCat));

      const procesados = await Promise.all(
        (rows ?? [])
          .filter((p) => Number.isFinite(p.ID_Producto) && p.ID_Producto > 0)
          .map(async (p) => {
            const ruta = (p.Ruta_Imagen ?? "").trim();

            let urlImagen = "";
            if (ruta) {
              urlImagen =
                ruta.startsWith("http://") ||
                ruta.startsWith("https://") ||
                ruta.startsWith("asset://") ||
                ruta.startsWith("tauri://")
                  ? ruta
                  : await fileUrlFromAppData(ruta);
            }

            return { ...p, urlImagen };
          }),
      );

      setProductos(procesados);
    } catch (e) {
      console.error("Fallo al cargar productos", e);
      setProductos([]);
    } finally {
      setLoadingProductos(false);
    }
  };

  const cargarResumenInventario = async () => {
    try {
      const r = await inventarioAPI.getResumen();
      setProximosCaducar(r.proximos ?? []);
      setMenosCantidad(r.menos ?? []);
    } catch (e) {
      console.error("Fallo al cargar resumen inventario:", e);
      setProximosCaducar([]);
      setMenosCantidad([]);
    }
  };

  useEffect(() => {
    (async () => {
      await cargarCategorias();
      await cargarResumenInventario();
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!categoriaSeleccionada) {
      cargarResumenInventario();
      return;
    }
    cargarProductos(Number(categoriaSeleccionada.ID_Categoria));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [categoriaSeleccionada?.ID_Categoria]);

  return {
    categorias,
    categoriaSeleccionada,
    productos,
    loadingProductos,
    proximosCaducar,
    menosCantidad,
    titulo,

    setCategoriaSeleccionada,
    setProductos,

    cargarCategorias,
    cargarProductos,
    cargarResumenInventario,
  };
}
