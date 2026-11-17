import { useCallback, useEffect, useLayoutEffect, useReducer, useRef, useState } from "react";
import { resolveImageUrl } from "./imageUrl";
import { avisarDelFallo } from "./conAviso";
import { useSyncSignal } from "../stores/useSyncSignal";
import { captureException } from "../observability/sentry";

type Imagen = { Ruta_Imagen: string | null };
type Categoria = Imagen & { ID_Categoria: string };
type ConImagen<T> = T & { urlImagen: string };
type Lista<T> = { datos: ConImagen<T>[]; cargando: boolean };
type Accion<T> = { tipo: "pedir" } | { tipo: "recibir"; datos: ConImagen<T>[] };
function reducir<T>(estado: Lista<T>, accion: Accion<T>): Lista<T> {
    return accion.tipo === "pedir" ? { ...estado, cargando: true } : { datos: accion.datos, cargando: false };
}
/** Una carta que no carga no puede parecer una carta vacía. El registro lo hace `invocar`, o `avisarDelFallo` si el fallo es de la pantalla. */
const avisarDeLaCarta = (e: unknown) => avisarDelFallo("No se pudo cargar la carta", e);
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
    // `silencioso`: un refresco de fondo cambia los datos cuando llegan, sin pasar por «Cargando».
    const cargarProductosDeCategoria = useCallback(async (cat: ConImagen<C> | null, silencioso = false) => {
        const n = ++generaciones.current.productos;
        if (!vigencia.current.activo) return;
        if (!cat) { productosDispatch({ tipo: "recibir", datos: [] }); return; }
        if (!silencioso) productosDispatch({ tipo: "pedir" });
        let datos: ConImagen<P>[] = [];
        try { datos = await imagenes(await api.productos(cat.ID_Categoria)); }
        finally {
            if (vigencia.current.activo && vigencia.current.categoria === cat.ID_Categoria && n === generaciones.current.productos)
                productosDispatch({ tipo: "recibir", datos });
        }
    }, [api]);
    const buscarProductosPorNombre = useCallback(async (texto: string, silencioso = false) => {
        const n = ++generaciones.current.busqueda;
        if (!vigencia.current.activo) return;
        const textoLimpio = texto.trim();
        if (textoLimpio && !silencioso) busquedaDispatch({ tipo: "pedir" });
        let datos: ConImagen<P>[] = [];
        try { if (textoLimpio) datos = await imagenes(await api.buscar(textoLimpio)); }
        finally {
            if (vigencia.current.activo && vigencia.current.q === textoLimpio && n === generaciones.current.busqueda)
                busquedaDispatch({ tipo: "recibir", datos });
        }
    }, [api]);
    useEffect(() => {
        vigencia.current.activo = activo;
        if (activo && autoCategorias) void cargarCategorias().catch(avisarDeLaCarta);
        const contadores = generaciones.current;
        return () => { ++contadores.categorias; ++contadores.productos; ++contadores.busqueda; vigencia.current.activo = false; };
    }, [activo, autoCategorias, cargarCategorias]);
    // Antes de pintar: con `useEffect` se llegaba a ver un fotograma de la categoría recién elegida
    // sin productos y sin `cargando`, es decir, «No hay productos» en una que sí los tiene.
    useLayoutEffect(() => {
        if (activo) void cargarProductosDeCategoria(categoriaSeleccionada).catch(avisarDeLaCarta);
        const contadores = generaciones.current;
        return () => { ++contadores.productos; };
    }, [activo, categoriaSeleccionada, cargarProductosDeCategoria]);
    useEffect(() => {
        const timer = window.setTimeout(() => { if (activo) void buscarProductosPorNombre(q).catch(avisarDeLaCarta); }, 180);
        const contadores = generaciones.current;
        return () => { window.clearTimeout(timer); ++contadores.busqueda; };
    }, [activo, q, buscarProductosPorNombre]);
    // INV-INC-02: lo que cambia otro equipo en la carta (un precio, una imagen, un producto nuevo)
    // llega por la réplica, y este catálogo no está en React Query: sin releerlo aquí, una mesa
    // abierta enseñaba el precio de antes mientras la línea se añadía con el nuevo. Se relee lo que
    // hay en pantalla, sin «Cargando» (es un refresco de fondo), y un fallo sólo se registra: el
    // siguiente cambio lo vuelve a intentar.
    const syncTick = useSyncSignal((s) => s.tick);
    const tickVisto = useRef(syncTick);
    const releerTrasCambioRemoto = useRef(() => {});
    releerTrasCambioRemoto.current = () => {
        if (!activo || !useSyncSignal.getState().comanda.touchedCatalog) return;
        const registrar = (e: unknown) => captureException(e, { fase: "releer_carta_remota" });
        cargarCategorias().catch(registrar);
        if (categoriaSeleccionada) cargarProductosDeCategoria(categoriaSeleccionada, true).catch(registrar);
        if (q) buscarProductosPorNombre(q, true).catch(registrar);
    };
    useEffect(() => {
        if (syncTick === tickVisto.current) return;
        tickVisto.current = syncTick;
        releerTrasCambioRemoto.current();
    }, [syncTick]);
    return { categorias, setCategorias, categoriaSeleccionada, setCategoriaSeleccionada, query, setQuery, q,
        productos: productosEstado.datos, loadingProductos: productosEstado.cargando, busqueda: busquedaEstado.datos, loadingBusqueda: busquedaEstado.cargando,
        cargarCategorias, cargarProductosDeCategoria, buscarProductosPorNombre };
}
