import { useCallback, useEffect, useLayoutEffect, useReducer, useRef, useState } from "react";
import { resolveImageUrl } from "./imageUrl";

type Imagen = { Ruta_Imagen: string | null };
type Categoria = Imagen & { ID_Categoria: string };
type ConImagen<T> = T & { urlImagen: string };
type Lista<T> = { datos: ConImagen<T>[]; cargando: boolean };
type Accion<T> = { tipo: "pedir" } | { tipo: "recibir"; datos: ConImagen<T>[] };
function reducir<T>(estado: Lista<T>, accion: Accion<T>): Lista<T> {
    return accion.tipo === "pedir" ? { ...estado, cargando: true } : { datos: accion.datos, cargando: false };
}
async function imagenes<T extends Imagen>(filas: T[]): Promise<ConImagen<T>[]> {
    return Promise.all(filas.map(async f => ({ ...f, urlImagen: await resolveImageUrl(f.Ruta_Imagen) })));
}

/** RI-47/RI-81: catálogo compartido con lecturas independientes y respuestas obsoletas descartadas. */
export function useCatalogoServicio<C extends Categoria, P extends Imagen>(activo: boolean, api: {
    categorias: () => Promise<C[]>; productos: (id: string) => Promise<P[]>; buscar: (q: string) => Promise<P[]>;
}, autoCategorias = true) {
    const [categorias, setCategorias] = useState<ConImagen<C>[]>([]);
    const [categoriaSeleccionada, setCategoriaSeleccionada] = useState<ConImagen<C> | null>(null);
    const [query, setQuery] = useState("");
    const q = query.trim();
    const [productosEstado, productosDispatch] = useReducer(reducir<P>, { datos: [], cargando: false });
    const [busquedaEstado, busquedaDispatch] = useReducer(reducir<P>, { datos: [], cargando: false });
    const vigencia = useRef({ activo, categoria: categoriaSeleccionada?.ID_Categoria, q });
    vigencia.current = { activo, categoria: categoriaSeleccionada?.ID_Categoria, q };
    const generaciones = useRef({ categorias: 0, productos: 0, busqueda: 0 });
    const cargarCategorias = useCallback(async () => {
        const n = ++generaciones.current.categorias;
        const datos = await imagenes(await api.categorias());
        if (vigencia.current.activo && n === generaciones.current.categorias) setCategorias(datos);
    }, [api]);
    const cargarProductosDeCategoria = useCallback(async (cat: ConImagen<C> | null) => {
        const n = ++generaciones.current.productos;
        if (!vigencia.current.activo) return;
        if (!cat) { productosDispatch({ tipo: "recibir", datos: [] }); return; }
        productosDispatch({ tipo: "pedir" });
        let datos: ConImagen<P>[] = [];
        try { datos = await imagenes(await api.productos(cat.ID_Categoria)); }
        finally {
            if (vigencia.current.activo && vigencia.current.categoria === cat.ID_Categoria && n === generaciones.current.productos)
                productosDispatch({ tipo: "recibir", datos });
        }
    }, [api]);
    const buscarProductosPorNombre = useCallback(async (texto: string) => {
        const n = ++generaciones.current.busqueda;
        if (!vigencia.current.activo) return;
        const textoLimpio = texto.trim();
        if (textoLimpio) busquedaDispatch({ tipo: "pedir" });
        let datos: ConImagen<P>[] = [];
        try { if (textoLimpio) datos = await imagenes(await api.buscar(textoLimpio)); }
        finally {
            if (vigencia.current.activo && vigencia.current.q === textoLimpio && n === generaciones.current.busqueda)
                busquedaDispatch({ tipo: "recibir", datos });
        }
    }, [api]);
    useEffect(() => {
        vigencia.current.activo = activo;
        if (activo && autoCategorias) void cargarCategorias().catch(console.error);
        const contadores = generaciones.current;
        return () => { ++contadores.categorias; ++contadores.productos; ++contadores.busqueda; vigencia.current.activo = false; };
    }, [activo, autoCategorias, cargarCategorias]);
    // Antes de pintar: con `useEffect` se llegaba a ver un fotograma de la categoría recién elegida
    // sin productos y sin `cargando`, es decir, «No hay productos» en una que sí los tiene.
    useLayoutEffect(() => {
        if (activo) void cargarProductosDeCategoria(categoriaSeleccionada).catch(console.error);
        const contadores = generaciones.current;
        return () => { ++contadores.productos; };
    }, [activo, categoriaSeleccionada, cargarProductosDeCategoria]);
    useEffect(() => {
        const timer = window.setTimeout(() => { if (activo) void buscarProductosPorNombre(q).catch(console.error); }, 180);
        const contadores = generaciones.current;
        return () => { window.clearTimeout(timer); ++contadores.busqueda; };
    }, [activo, q, buscarProductosPorNombre]);
    return { categorias, setCategorias, categoriaSeleccionada, setCategoriaSeleccionada, query, setQuery, q,
        productos: productosEstado.datos, loadingProductos: productosEstado.cargando, busqueda: busquedaEstado.datos, loadingBusqueda: busquedaEstado.cargando,
        cargarCategorias, cargarProductosDeCategoria, buscarProductosPorNombre };
}
