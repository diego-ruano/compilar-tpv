import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  Truck,
  Plus,
  ArrowLeft,
  Link2,
  Trash2,
  ImageOff,
  Pencil,
} from "lucide-react";
import { useToast } from "../../shared/toast";
import { SearchInput } from "../../shared/ui";
import { cn } from "../../shared/lib/cn";
import { resolveImageUrl, triggerImageUploadDrain } from "../../shared/lib/imageUrl";
import ImageWithFallback from "../../shared/ui/ImageWithFallback";

import Product from "../../features/InventaryComponents/Product";
import Modal from "../../features/proveedores/Modal";
import Campo from "../../features/proveedores/Campo";
import ProveedorCard from "../../features/proveedores/ProveedorCard";
import PedidosSection from "../../features/proveedores/PedidosSection";
import ProductDetailModal from "../../features/InventaryComponents/ProductDetailModal";
import { AddProductModal } from "../../features/InventaryComponents/ui/AddProductModal";

import {
  proveedoresGetProductosAll,
  type ProveedorRow,
  type ProductoRow,
  type Categoria,
} from "../../features/proveedores/proveedoresApis";
import {
  useProveedoresAll,
  useProveedoresCategorias,
  useProveedoresProductos,
  useSaveProveedor,
  useDeleteProveedor,
  useSetVinculos,
  useCreateProducto,
} from "../../features/proveedores/proveedoresQueries";

type ProveedorUI = ProveedorRow & { urlImagen: string };
type ProductoUI = ProductoRow & { urlImagen: string };

type Vista = "list" | "detail";

const convertirABase64 = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.readAsDataURL(file);
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = (error) => reject(error);
  });

function toNumOrNull(v: string): number | null {
  const t = v.trim();
  if (!t) return null;
  const n = Number(t.replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

export default function Proveedores() {
  const [openAddProduct, setOpenAddProduct] = useState(false);
  const [productIdToEdit, setProductIdToEdit] = useState<string | null>(null);

  const [openProductDetail, setOpenProductDetail] = useState(false);
  const [productDetailId, setProductDetailId] = useState<string | null>(null);

  const [vista, setVista] = useState<Vista>("list");
  const [busqueda, setBusqueda] = useState("");

  const [loadingLocal, setLoadingLocal] = useState(false);
  const [proveedores, setProveedores] = useState<ProveedorUI[]>([]);
  const [proveedorActivo, setProveedorActivo] = useState<ProveedorUI | null>(null);
  const toast = useToast();

  // ---- TanStack Query: lecturas cacheadas + mutaciones (invalidan la feature) ----
  const proveedoresQuery = useProveedoresAll();
  const categoriasQuery = useProveedoresCategorias();
  const productosProveedorQuery = useProveedoresProductos(proveedorActivo?.ID_Proveedor ?? null);

  const saveProveedor = useSaveProveedor();
  const deleteProveedor = useDeleteProveedor();
  const setVinculos = useSetVinculos();
  const createProducto = useCreateProducto();

  // 'loading' derivado: fetch de listas + mutaciones en curso + trabajo local (subida de imagen, etc.)
  const loading =
    loadingLocal ||
    proveedoresQuery.isFetching ||
    productosProveedorQuery.isFetching ||
    saveProveedor.isPending ||
    deleteProveedor.isPending ||
    setVinculos.isPending ||
    createProducto.isPending;

  const [confirmAccion, setConfirmAccion] = useState<
    | { tipo: "proveedor"; proveedor: ProveedorUI }
    | { tipo: "producto"; idProducto: string; nombreProducto?: string; cerrarDetalle?: boolean }
    | null
  >(null);
  const [confirmando, setConfirmando] = useState(false);

  const [productosProveedor, setProductosProveedor] = useState<ProductoUI[]>([]);

  // Categorías: derivadas directamente de la query (no requieren mapeo async de imágenes).
  const categorias: Categoria[] = categoriasQuery.data ?? [];

  const [modalProveedorOpen, setModalProveedorOpen] = useState(false);
  const [modalProveedorModo, setModalProveedorModo] = useState<"nuevo" | "editar">("nuevo");

  const [fNombre, setFNombre] = useState("");
  const [fContacto, setFContacto] = useState("");
  const [fTelefono, setFTelefono] = useState("");
  const [fEmail, setFEmail] = useState("");
  const [fCif, setFCif] = useState("");
  const [fOtros, setFOtros] = useState("");

  const fotoInputRef = useRef<HTMLInputElement | null>(null);
  const [fotoNuevaPreview, setFotoNuevaPreview] = useState<string | null>(null);
  const [fotoNuevaFile, setFotoNuevaFile] = useState<File | null>(null);
  const [fotoEliminar, setFotoEliminar] = useState(false);

  function resetFotoInput() {
    if (fotoInputRef.current) fotoInputRef.current.value = "";
  }

  const [modalVincularOpen, setModalVincularOpen] = useState(false);
  const [modalCrearProductoOpen, setModalCrearProductoOpen] = useState(false);
  const [loadingVincular, setLoadingVincular] = useState(false);

  const [busquedaProductos, setBusquedaProductos] = useState("");
  const [productosDisponibles, setProductosDisponibles] = useState<ProductoUI[]>([]);
  const [seleccionProductoIds, setSeleccionProductoIds] = useState<Set<string>>(new Set());
  const [categoriaActivaId, setCategoriaActivaId] = useState<string | null>(null);

  const [pNombre, setPNombre] = useState("");
  const [pPrecio, setPPrecio] = useState("");
  const [pStockActual, setPStockActual] = useState("");
  const [pStockMin, setPStockMin] = useState("");
  const [pUnidad, setPUnidad] = useState("");
  const [pCategoriaId, setPCategoriaId] = useState<string>("");

  async function mapProveedoresUI(rows: ProveedorRow[]): Promise<ProveedorUI[]> {
    const out: ProveedorUI[] = [];
    for (const r of rows) {
      out.push({
        ...r,
        urlImagen: await resolveImageUrl(r.Ruta_Imagen),
      });
    }
    return out;
  }

  async function mapProductosUI(rows: ProductoRow[]): Promise<ProductoUI[]> {
    return await Promise.all(
      (rows ?? []).map(async (p) => ({
        ...p,
        urlImagen: await resolveImageUrl(p.Ruta_Imagen),
      })),
    );
  }

  // Recarga manteniendo la selección: la query cachea, así que sólo hay que refrescarla.
  // El efecto de mapeo de abajo re-deriva la lista UI y re-sincroniza el proveedor activo.
  function recargarProveedoresManteniendoSeleccion() {
    return proveedoresQuery.refetch();
  }

  // Refresca los productos del proveedor activo (query cacheada por id).
  function recargarProductosProveedor() {
    if (!proveedorActivo) return Promise.resolve();
    return productosProveedorQuery.refetch();
  }

  // Mapea las filas de la query de proveedores a UI (resuelve URLs de imagen, async)
  // y re-sincroniza el proveedor activo cuando cambia la lista.
  useEffect(() => {
    let cancelado = false;
    const rows = proveedoresQuery.data;
    if (!rows) {
      if (proveedoresQuery.isError) setProveedores([]);
      return;
    }
    void (async () => {
      const ui = await mapProveedoresUI(rows);
      if (cancelado) return;
      setProveedores(ui);

      if (proveedorActivo) {
        const id = proveedorActivo.ID_Proveedor;
        const updated = ui.find((x) => x.ID_Proveedor === id);
        if (updated) setProveedorActivo(updated);
      }
    })();
    return () => {
      cancelado = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [proveedoresQuery.data, proveedoresQuery.isError]);

  // Toast de error si falla la carga de proveedores (preserva el aviso al usuario).
  useEffect(() => {
    if (proveedoresQuery.isError) {
      console.error("Error cargando proveedores", proveedoresQuery.error);
    }
  }, [proveedoresQuery.isError, proveedoresQuery.error]);

  // Mapea las filas de la query de productos del proveedor activo a UI (async).
  useEffect(() => {
    let cancelado = false;
    if (vista !== "detail" || !proveedorActivo) {
      setProductosProveedor([]);
      return;
    }
    const rows = productosProveedorQuery.data;
    if (!rows) {
      if (productosProveedorQuery.isError) setProductosProveedor([]);
      return;
    }
    void (async () => {
      const ui = await mapProductosUI(rows);
      if (!cancelado) setProductosProveedor(ui);
    })();
    return () => {
      cancelado = true;
    };
     
  }, [vista, proveedorActivo, productosProveedorQuery.data, productosProveedorQuery.isError]);

  const proveedoresFiltrados = useMemo(() => {
    const s = busqueda.trim().toLowerCase();
    if (!s) return proveedores;
    return proveedores.filter((p) => {
      const n = (p.Nombre_Empresa || "").toLowerCase();
      const e = (p.Email || "").toLowerCase();
      const t = (p.Telefono || "").toLowerCase();
      const c = (p.CIF || "").toLowerCase();
      const o = (p.Informacion_adicional || "").toLowerCase();
      return n.includes(s) || e.includes(s) || t.includes(s) || c.includes(s) || o.includes(s);
    });
  }, [proveedores, busqueda]);

  const productosProveedorFiltrados = useMemo(() => {
    if (vista !== "detail") return [];
    const s = busqueda.trim().toLowerCase();
    if (!s) return productosProveedor;
    return productosProveedor.filter((p) => p.Nombre.toLowerCase().includes(s));
  }, [vista, productosProveedor, busqueda]);

  const productosDisponiblesFiltrados = useMemo(() => {
    let list = productosDisponibles;
    if (categorias.length > 0 && categoriaActivaId !== null) {
      list = list.filter((p) => p.ID_Categoria === categoriaActivaId);
    }
    const s = busquedaProductos.trim().toLowerCase();
    if (!s) return list;
    return list.filter((p) => p.Nombre.toLowerCase().includes(s));
  }, [productosDisponibles, busquedaProductos, categoriaActivaId, categorias.length]);

  function volverALista() {
    setVista("list");
    setProveedorActivo(null);
    setProductosProveedor([]);
    setBusqueda("");
  }

  function abrirDetalleProveedor(p: ProveedorUI) {
    setProveedorActivo(p);
    setVista("detail");
    setBusqueda("");
  }

  function abrirNuevoProveedorModal() {
    setModalProveedorModo("nuevo");
    setFNombre("");
    setFContacto("");
    setFTelefono("");
    setFEmail("");
    setFCif("");
    setFOtros("");

    setFotoNuevaPreview(null);
    setFotoNuevaFile(null);
    setFotoEliminar(false);
    resetFotoInput();

    setModalProveedorOpen(true);
  }

  function abrirEditarProveedorModal() {
    if (!proveedorActivo) return;

    setModalProveedorModo("editar");
    setFNombre(proveedorActivo.Nombre_Empresa ?? "");
    setFContacto(proveedorActivo.Contacto ?? "");
    setFTelefono(proveedorActivo.Telefono ?? "");
    setFEmail(proveedorActivo.Email ?? "");
    setFCif(proveedorActivo.CIF ?? "");
    setFOtros(proveedorActivo.Informacion_adicional ?? "");

    setFotoNuevaPreview(null);
    setFotoNuevaFile(null);
    setFotoEliminar(false);
    resetFotoInput();

    setModalProveedorOpen(true);
  }

  async function guardarProveedor() {
    const nombre = fNombre.trim();
    if (!nombre) {
      toast.info("Validación", "El nombre de empresa es obligatorio.");
      return;
    }

    const contacto = fContacto.trim();
    const telefono = fTelefono.trim();
    const email = fEmail.trim();
    const cif = fCif.trim();
    const otros = fOtros.trim();

    setLoadingLocal(true);
    try {
      let nombreImagen: string | null = null;
      let rutaImagen: string | null = null;
      // Ruta de la imagen anterior, para limpiarla del bucket tras reemplazo/eliminación.
      const rutaAnterior =
        modalProveedorModo === "editar" ? (proveedorActivo?.Ruta_Imagen ?? null) : null;

      // La imagen se procesa (resize + JPEG) en Rust y se sube a R2 (Main y Handy).
      if (fotoNuevaFile) {
        const uuid = crypto.randomUUID();
        nombreImagen = `prov_${uuid}.jpg`;

        const subcarpeta = "proveedores";
        rutaImagen = `images/${subcarpeta}/${nombreImagen}`;

        const base64String = await convertirABase64(fotoNuevaFile);
        const base64Data = base64String.split(",")[1];

        await invoke("save_image", {
          args: {
            subfolder: subcarpeta,
            filename: nombreImagen,
            base64_data: base64Data,
          },
        });
      }

      if (modalProveedorModo === "editar" && proveedorActivo) {
        if (fotoEliminar) {
          nombreImagen = null;
          rutaImagen = null;
        } else if (!fotoNuevaFile) {
          nombreImagen = proveedorActivo.Nombre_Imagen ?? null;
          rutaImagen = proveedorActivo.Ruta_Imagen ?? null;
        }
      }

      const ok = await saveProveedor.mutateAsync({
        idProveedor: modalProveedorModo === "editar" ? (proveedorActivo?.ID_Proveedor ?? null) : null,
        nombreEmpresa: nombre,
        contacto: contacto || null,
        telefono: telefono || null,
        email: email || null,
        cif: cif || null,
        informacionAdicional: otros || null,
        nombreImagen,
        rutaImagen,
      });

      if (!ok) {
        toast.error("Error", "No se pudo guardar. Revisa si el Email o el CIF ya existen.");
        return;
      }

      // Subir la imagen nueva a R2 y limpiar la anterior (reemplazo o eliminación).
      if (fotoNuevaFile) triggerImageUploadDrain();
      if (rutaAnterior && rutaAnterior !== rutaImagen) {
        void invoke("images_delete", { args: { rel_path: rutaAnterior } }).catch(() => {});
      }

      // La invalidación en onSuccess recachea la lista; el efecto re-deriva y re-sincroniza el activo.
      setModalProveedorOpen(false);
    } catch (e: any) {
      console.error("Error guardando proveedor", e);
      toast.error("Error", "No se pudo guardar. Revisa si el Email o el CIF ya existen.");
    } finally {
      setLoadingLocal(false);
    }
  }

  function eliminarProveedor() {
    if (!proveedorActivo) return;
    setConfirmAccion({ tipo: "proveedor", proveedor: proveedorActivo });
  }

  function eliminarProductoDelProveedor(idProducto: string, cerrarDetalle = false) {
    if (!proveedorActivo) return;
    const prod = productosProveedor.find((x) => x.ID_Producto === idProducto);

    setConfirmAccion({
      tipo: "producto",
      idProducto,
      nombreProducto: prod?.Nombre,
      cerrarDetalle,
    });
  }

  async function confirmarAccionModal() {
    if (!proveedorActivo || !confirmAccion) return;

    setConfirmando(true);
    try {
      if (confirmAccion.tipo === "proveedor") {
        try {
          const id = confirmAccion.proveedor.ID_Proveedor;
          const deleted = await deleteProveedor.mutateAsync({ idProveedor: id });
          if (!deleted) {
            toast.error("Error", "No se pudo eliminar el proveedor.");
            return;
          }

          // La invalidación recachea la lista; refrescamos antes de navegar.
          await recargarProveedoresManteniendoSeleccion();
          volverALista();
          setConfirmAccion(null);
        } catch (e) {
          console.error("Error eliminando proveedor", e);
          toast.error("Error", "No se pudo eliminar el proveedor.");
        }
      }

      if (confirmAccion.tipo === "producto") {
        try {
          const idProv = proveedorActivo.ID_Proveedor;

          const next = productosProveedor
            .filter((x) => x.ID_Producto !== confirmAccion.idProducto)
            .map((x) => x.ID_Producto);

          const ok = await setVinculos.mutateAsync({
            idProveedor: idProv,
            productoIds: next,
          });

          if (!ok) {
            toast.error("Error", "No se pudo desvincular el producto.");
            return;
          }

          setProductosProveedor((prev) => prev.filter((x) => x.ID_Producto !== confirmAccion.idProducto));

          if (confirmAccion.cerrarDetalle) {
            setOpenProductDetail(false);
            setProductDetailId(null);
          }

          setConfirmAccion(null);
        } catch (e) {
          console.error("Error desvinculando producto", e);
          toast.error("Error", "No se pudo desvincular el producto.");
        }
      }
    } finally {
      setConfirmando(false);
    }
  }

  async function abrirVincularProductos() {
    if (!proveedorActivo) return;

    setModalVincularOpen(true);
    setBusquedaProductos("");
    setSeleccionProductoIds(new Set());
    setCategoriaActivaId(null);
    setLoadingVincular(true);

    try {
      const idProv = proveedorActivo.ID_Proveedor;
      const rows = await proveedoresGetProductosAll();
      const ui = await mapProductosUI(rows);

      setProductosDisponibles(ui);

      const pre = new Set<string>();
      for (const p of ui) {
        if (p.ID_Proveedor === idProv) pre.add(p.ID_Producto);
      }
      setSeleccionProductoIds(pre);
    } catch (e) {
      console.error("Error cargando productos disponibles", e);
      setProductosDisponibles([]);
      setSeleccionProductoIds(new Set());
    } finally {
      setLoadingVincular(false);
    }
  }

  function toggleSeleccion(idProducto: string) {
    setSeleccionProductoIds((prev) => {
      const next = new Set(prev);
      if (next.has(idProducto)) next.delete(idProducto);
      else next.add(idProducto);
      return next;
    });
  }

  async function guardarVinculos() {
    if (!proveedorActivo) return;

    const idProv = proveedorActivo.ID_Proveedor;
    const idsSeleccionados = Array.from(seleccionProductoIds);

    try {
      const ok = await setVinculos.mutateAsync({
        idProveedor: idProv,
        productoIds: idsSeleccionados,
      });
      if (!ok) {
        toast.error("Error", "No se pudieron guardar los vínculos.");
        return;
      }

      // La invalidación recachea; refrescamos los productos del proveedor antes de cerrar.
      await recargarProductosProveedor();
      setModalVincularOpen(false);
    } catch (e) {
      console.error("Error guardando vínculos", e);
      toast.error("Error", "No se pudieron guardar los vínculos.");
    }
  }

  function abrirCrearProductoEnModal() {
    setPNombre("");
    setPPrecio("");
    setPStockActual("");
    setPStockMin("");
    setPUnidad("");
    setPCategoriaId(categorias[0]?.ID_Categoria ?? "");
    setModalCrearProductoOpen(true);
  }

  async function crearProductoYSeleccionar() {
    if (!proveedorActivo) return;

    const nombre = pNombre.trim();
    if (!nombre) {
      toast.info("Validación", "El nombre del producto es obligatorio.");
      return;
    }
    if (pCategoriaId === "") {
      toast.info("Validación", "Selecciona una categoría (ID_Categoria es obligatorio).");
      return;
    }

    const idProv = proveedorActivo.ID_Proveedor;
    const idCat = pCategoriaId;
    const precio = toNumOrNull(pPrecio);
    const stockA = toNumOrNull(pStockActual);
    const stockM = toNumOrNull(pStockMin);
    const unidad = pUnidad.trim();

    try {
      const idNuevo = await createProducto.mutateAsync({
        idCategoria: idCat,
        idProveedor: idProv,
        nombre,
        precioVenta: precio,
        stockActual: stockA,
        stockMinimo: stockM,
        unidadMedida: unidad || null,
      });

      if (!idNuevo) {
        toast.error("Error", "No se pudo crear el producto.");
        return;
      }

      await abrirVincularProductos();
      setModalCrearProductoOpen(false);
    } catch (e) {
      console.error("Error creando producto", e);
      toast.error("Error", "No se pudo crear el producto.");
    }
  }

  const categoriaActivaNombre = useMemo(() => {
    if (categoriaActivaId === null) return "Todas";
    const c = categorias.find((x) => x.ID_Categoria === categoriaActivaId);
    return c?.Nombre ?? "Categoría";
  }, [categoriaActivaId, categorias]);

  return (
    <div className="flex h-full min-h-0 w-full flex-col items-center gap-3 overflow-y-auto overscroll-contain bg-bg p-2 pt-3 [scrollbar-gutter:stable] sm:gap-4 sm:p-4 lg:p-6 lg:pt-5">
      <div className="flex w-full min-w-0 shrink-0 flex-col gap-4 rounded-2xl border border-border bg-surface p-3 shadow-sm sm:p-4">
        {vista === "list" ? (
          <div className="flex flex-col items-stretch gap-3 xs:grid xs:grid-cols-[minmax(0,1fr)_auto] xs:items-center sm:flex sm:flex-row">
            <div className="flex min-w-0 items-center gap-3">
              <div className="grid size-11 shrink-0 place-items-center rounded-2xl bg-accent-soft text-accent">
                <Truck className="size-6" aria-hidden />
              </div>
              <div className="min-w-0">
                <h2 className="text-xl font-bold text-fg sm:text-2xl">Proveedores</h2>
                <p className="text-sm text-fg-muted">
                  {proveedoresFiltrados.length}{" "}
                  {proveedoresFiltrados.length === 1 ? "proveedor" : "proveedores"}
                </p>
              </div>
            </div>

            <div className="order-3 flex min-w-0 justify-center xs:col-span-2 sm:order-none sm:col-span-1 sm:flex-1">
              <SearchInput
                value={busqueda}
                onValueChange={setBusqueda}
                placeholder="Buscar proveedor..."
                className="w-full sm:max-w-xs"
              />
            </div>

            <button
              type="button"
              onClick={abrirNuevoProveedorModal}
              className="inline-flex w-full min-w-0 cursor-pointer items-center justify-center gap-1.5 whitespace-normal break-words rounded-xl bg-accent px-3 py-2 text-center text-sm font-semibold leading-tight text-accent-fg shadow-sm transition hover:bg-accent-hover active:scale-[0.98] xs:w-auto xs:shrink-0"
            >
              <Plus className="size-4" aria-hidden />
              <span>Nuevo proveedor</span>
            </button>
          </div>
        ) : (
          <>
            <div className="flex flex-wrap items-center justify-between gap-2 sm:gap-3">
              <button
                type="button"
                onClick={volverALista}
                className="inline-flex min-w-0 shrink cursor-pointer items-center gap-2 rounded-xl border border-border bg-surface px-3 py-2 text-sm font-semibold text-fg transition hover:bg-surface-2"
              >
                <ArrowLeft className="size-4 shrink-0" aria-hidden />
                <span className="truncate">{proveedorActivo?.Nombre_Empresa ?? "Volver"}</span>
              </button>

              <button
                type="button"
                onClick={() => setBusqueda("")}
                className="inline-flex min-w-0 shrink cursor-pointer items-center justify-center whitespace-normal break-words rounded-xl border border-border bg-surface px-3 py-2 text-center text-sm font-semibold leading-tight text-fg-muted transition hover:bg-surface-2 hover:text-fg"
              >
                Limpiar búsqueda
              </button>
            </div>

            <SearchInput
              value={busqueda}
              onValueChange={setBusqueda}
              placeholder="Buscar producto vinculado..."
            />
          </>
        )}
      </div>

      {vista === "list" && (
        <>
          <div className="w-full">
            {loading ? (
              <p className="text-fg-muted">Cargando proveedores...</p>
            ) : proveedoresFiltrados.length === 0 ? (
              <div className="flex flex-col items-center justify-center gap-2 rounded-2xl border border-border bg-surface p-10 text-center shadow-sm">
                <div className="grid size-12 place-items-center rounded-2xl bg-surface-2 text-fg-subtle">
                  <Truck className="size-6" aria-hidden />
                </div>
                <p className="text-sm font-medium text-fg">Sin proveedores</p>
                <p className="text-xs text-fg-muted">No hay proveedores con ese filtro.</p>
              </div>
            ) : (
              <div className="max-h-88 overflow-y-auto overscroll-contain [scrollbar-gutter:stable]">
                <div className="grid w-full grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-[repeat(auto-fill,minmax(240px,1fr))]">
                  {proveedoresFiltrados.map((p) => (
                    <ProveedorCard key={p.ID_Proveedor} proveedor={p} onClick={() => abrirDetalleProveedor(p)} />
                  ))}
                </div>
              </div>
            )}
          </div>

          <PedidosSection proveedores={proveedores} />
        </>
      )}

      {vista === "detail" && proveedorActivo && (
        <>
          <div className="flex w-full min-w-0 flex-col gap-4 rounded-2xl border border-border bg-surface p-3 shadow-sm sm:p-4 lg:flex-row lg:gap-6">
            <div className="flex h-[200px] w-full items-center justify-center overflow-hidden rounded-xl border border-border bg-surface-2 sm:h-[240px] lg:h-[280px] lg:w-[280px] lg:shrink-0">
              <ImageWithFallback
                src={proveedorActivo.urlImagen}
                alt={proveedorActivo.Nombre_Empresa}
                className="h-full w-full object-cover"
                fallback={
                  <div className="flex h-full w-full flex-col items-center justify-center gap-1 px-4 text-center text-fg-subtle">
                    <ImageOff className="size-8" aria-hidden />
                    <span className="text-sm font-bold">{proveedorActivo.Nombre_Empresa}</span>
                  </div>
                }
              />
            </div>

            <div className="flex flex-1 flex-col gap-3 text-fg">
              <h3 className="text-2xl font-bold text-fg">{proveedorActivo.Nombre_Empresa}</h3>

              <div className="flex flex-col gap-1 text-sm text-fg-muted">
                <p>
                  <span className="font-semibold text-fg">Contacto:</span>{" "}
                  {proveedorActivo.Contacto ?? "—"}
                </p>
                <p>
                  <span className="font-semibold text-fg">Teléfono:</span>{" "}
                  {proveedorActivo.Telefono ?? "—"}
                </p>
                <p>
                  <span className="font-semibold text-fg">Email:</span>{" "}
                  {proveedorActivo.Email ?? "—"}
                </p>
                <p>
                  <span className="font-semibold text-fg">CIF:</span> {proveedorActivo.CIF ?? "—"}
                </p>
                <p>
                  <span className="font-semibold text-fg">Otros:</span>{" "}
                  {proveedorActivo.Informacion_adicional ?? "—"}
                </p>
              </div>

              <div className="mt-2 grid w-full max-w-[560px] grid-cols-1 gap-2 xs:grid-cols-2 sm:gap-3">
                <button
                  className="inline-flex items-center justify-center gap-2 rounded-xl bg-accent py-2 font-semibold text-accent-fg shadow-sm transition hover:bg-accent-hover active:scale-[0.98] cursor-pointer"
                  onClick={abrirEditarProveedorModal}
                >
                  <Pencil className="size-4" aria-hidden />
                  Editar perfil
                </button>

                <button
                  className="inline-flex items-center justify-center gap-2 rounded-xl border border-border bg-surface py-2 font-semibold text-fg transition hover:bg-surface-2 cursor-pointer"
                  onClick={abrirVincularProductos}
                >
                  <Link2 className="size-4" aria-hidden />
                  Vincular productos
                </button>

                <button
                  className="inline-flex items-center justify-center gap-2 rounded-xl border border-danger/30 bg-danger-soft py-2 font-semibold text-danger transition hover:opacity-90 cursor-pointer xs:col-span-2"
                  onClick={eliminarProveedor}
                >
                  <Trash2 className="size-4" aria-hidden />
                  Eliminar proveedor
                </button>
              </div>
            </div>
          </div>

          <div className="w-full rounded-2xl border border-border bg-surface p-4 shadow-sm">
            <div className="mb-4 flex flex-col items-stretch gap-3 xs:flex-row xs:items-center xs:justify-between">
              <h4 className="text-xl font-bold text-fg">Productos vinculados</h4>

              <button
                type="button"
                onClick={abrirVincularProductos}
                className="inline-flex min-w-0 shrink-0 cursor-pointer items-center justify-center gap-1.5 whitespace-normal break-words rounded-xl border border-border bg-surface px-3 py-2 text-center text-sm font-semibold leading-tight text-fg transition hover:bg-surface-2"
              >
                <Link2 className="size-4" aria-hidden />
                Gestionar vínculos
              </button>
            </div>

            {productosProveedorFiltrados.length === 0 ? (
              <p className="text-fg-muted">No hay productos vinculados.</p>
            ) : (
              <div className="grid w-full grid-cols-1 gap-4 xs:grid-cols-[repeat(auto-fill,minmax(200px,1fr))]">
                {productosProveedorFiltrados.map((p) => (
                  <div key={p.ID_Producto} className="w-full">
                    <Product
                      img={p.urlImagen}
                      name={p.Nombre}
                      onSelect={() => {
                        setProductDetailId(p.ID_Producto);
                        setOpenProductDetail(true);
                      }}
                    />

                    <button
                      type="button"
                      onClick={() => eliminarProductoDelProveedor(p.ID_Producto)}
                      className="mt-2 inline-flex w-full items-center justify-center gap-1.5 rounded-xl border border-danger/30 bg-danger-soft py-2 font-semibold text-danger transition hover:opacity-90 cursor-pointer"
                    >
                      <Trash2 className="size-4" aria-hidden />
                      Quitar del proveedor
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}

      <Modal
        open={modalProveedorOpen}
        onClose={() => setModalProveedorOpen(false)}
        title={modalProveedorModo === "nuevo" ? "Crear proveedor" : "Editar proveedor"}
        zIndex={60}
        widthClass="max-w-[780px]"
      >
        <div className="mb-4 flex flex-col items-stretch gap-3 sm:flex-row sm:items-start sm:gap-4">
          <div className="flex h-[140px] w-full shrink-0 items-center justify-center overflow-hidden rounded-xl border border-border bg-surface-2 sm:w-[140px]">
            {fotoNuevaPreview ? (
              <img src={fotoNuevaPreview} className="h-full w-full object-cover" draggable={false} />
            ) : proveedorActivo?.urlImagen && modalProveedorModo === "editar" && !fotoEliminar ? (
              <img src={proveedorActivo.urlImagen} className="h-full w-full object-cover" draggable={false} />
            ) : (
              <span className="text-sm font-semibold text-fg-subtle">Sin foto</span>
            )}
          </div>

          <div className="flex-1">
            <label className="text-sm font-semibold text-fg">Foto del proveedor</label>

            <div className="mt-1 flex flex-col items-stretch gap-3 rounded-xl border border-border bg-surface-2 px-3 py-3 xs:flex-row xs:items-center xs:justify-between sm:px-4">
              <div className="text-sm text-fg-muted">
                {fotoEliminar
                  ? "Se eliminará la foto"
                  : fotoNuevaFile
                    ? "Nueva foto seleccionada"
                    : modalProveedorModo === "editar" && proveedorActivo?.Ruta_Imagen
                      ? "Foto actual"
                      : "No hay foto aún"}
              </div>

              <div className="grid grid-cols-1 gap-2 xs:grid-cols-2 sm:flex">
                <label className="min-w-0 cursor-pointer whitespace-normal break-words rounded-xl bg-accent px-3 py-1.5 text-center text-sm font-semibold leading-tight text-accent-fg shadow-sm transition hover:bg-accent-hover">
                  {fotoNuevaFile || (modalProveedorModo === "editar" && proveedorActivo?.Ruta_Imagen && !fotoEliminar)
                    ? "Cambiar"
                    : "Subir"}
                  <input
                    ref={fotoInputRef}
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={async (e) => {
                      const file = e.target.files?.[0];
                      if (!file) return;

                      const previewUrl = URL.createObjectURL(file);
                      setFotoNuevaPreview(previewUrl);
                      setFotoNuevaFile(file);
                      setFotoEliminar(false);
                    }}
                  />
                </label>

                {(() => {
                  const hayFotoActiva =
                    !!fotoNuevaFile || (modalProveedorModo === "editar" && !!proveedorActivo?.Ruta_Imagen && !fotoEliminar);

                  if (!hayFotoActiva) return null;

                  return (
                    <button
                      type="button"
                      onClick={() => {
                        setFotoEliminar(true);

                        setFotoNuevaFile(null);
                        if (fotoNuevaPreview) URL.revokeObjectURL(fotoNuevaPreview);
                        setFotoNuevaPreview(null);

                        resetFotoInput();
                      }}
                      className="min-w-0 cursor-pointer whitespace-normal break-words rounded-xl border border-danger/30 bg-danger-soft px-3 py-1.5 text-center text-sm font-semibold leading-tight text-danger transition hover:opacity-90"
                    >
                      Eliminar
                    </button>
                  );
                })()}
              </div>
            </div>

            {fotoEliminar && (
              <p className="mt-2 text-xs text-danger">
                Se eliminará la foto al guardar. Si quieres otra, sube una nueva.
              </p>
            )}
          </div>
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 sm:gap-4">
          <Campo label="Nombre empresa *" value={fNombre} onChange={setFNombre} placeholder="Ej: Coca-Cola" />
          <Campo label="Contacto" value={fContacto} onChange={setFContacto} placeholder="Ej: Juan Pérez" />

          <Campo label="Teléfono" value={fTelefono} onChange={setFTelefono} placeholder="Ej: 600123123" />
          <Campo label="Email" value={fEmail} onChange={setFEmail} placeholder="Ej: correo@empresa.com" type="email" />

          <Campo label="CIF" value={fCif} onChange={setFCif} placeholder="Ej: B12345678" />

          <div className="sm:col-span-2">
            <label className="text-sm font-semibold text-fg">Otros datos</label>
            <textarea
              value={fOtros}
              onChange={(e) => setFOtros(e.target.value)}
              placeholder="Notas, condiciones, observaciones…"
              className="mt-1 min-h-[110px] w-full resize-none rounded-xl border border-border bg-surface-2 px-3 py-2 text-fg outline-none transition placeholder:text-fg-subtle focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-ring"
            />
          </div>
        </div>

        <div className="mt-6 grid grid-cols-2 gap-2 sm:flex sm:justify-end sm:gap-3">
          <button
            type="button"
            onClick={() => {
              if (fotoNuevaPreview) URL.revokeObjectURL(fotoNuevaPreview);
              setFotoNuevaPreview(null);
              setFotoNuevaFile(null);
              setFotoEliminar(false);
              resetFotoInput();
              setModalProveedorOpen(false);
            }}
            className="cursor-pointer rounded-xl border border-border bg-surface px-4 py-2 font-semibold text-fg transition hover:bg-surface-2"
          >
            Cancelar
          </button>

          <button
            type="button"
            onClick={guardarProveedor}
            disabled={loading}
            className={cn(
              "rounded-xl px-4 py-2 font-semibold transition",
              loading
                ? "cursor-not-allowed bg-surface-2 text-fg-subtle"
                : "bg-accent text-accent-fg shadow-sm hover:bg-accent-hover active:scale-[0.98] cursor-pointer",
            )}
          >
            {loading ? "Guardando..." : "Guardar"}
          </button>
        </div>
      </Modal>

      <Modal
        open={modalVincularOpen}
        onClose={() => setModalVincularOpen(false)}
        title={`Vincular productos · ${proveedorActivo?.Nombre_Empresa ?? ""}`}
        zIndex={70}
        widthClass="max-w-[1100px]"
      >
        <div className="mb-4 flex flex-col items-stretch gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0 flex-1">
            <SearchInput
              value={busquedaProductos}
              onValueChange={setBusquedaProductos}
              placeholder={`Buscar producto en "${categoriaActivaNombre}"...`}
            />
          </div>

          <button
            type="button"
            onClick={abrirCrearProductoEnModal}
            className="inline-flex min-w-0 shrink-0 cursor-pointer items-center justify-center gap-1.5 whitespace-normal break-words rounded-xl bg-accent px-3 py-2 text-center text-sm font-semibold leading-tight text-accent-fg shadow-sm transition hover:bg-accent-hover active:scale-[0.98]"
          >
            <Plus className="size-4" aria-hidden />
            Crear producto
          </button>
        </div>

        <div className="mb-3 text-sm text-fg-muted">
          Selecciona una categoría y marca los productos que quieras vincular. (Los desmarcados se desvinculan)
        </div>

        {loadingVincular ? (
          <p className="text-fg-muted">Cargando...</p>
        ) : (
          <div className="flex flex-col gap-3 md:flex-row md:gap-4">
            <div className="w-full shrink-0 md:w-[280px]">
              <div className="overflow-hidden rounded-2xl border border-border bg-surface">
                <div className="border-b border-border px-3 py-2 font-semibold text-fg">Categorías</div>

                <div className="max-h-[220px] overflow-auto md:max-h-[55vh]">
                  <button
                    type="button"
                    onClick={() => setCategoriaActivaId(null)}
                    className={cn(
                      "w-full cursor-pointer border-b border-border px-3 py-2 text-left transition",
                      categoriaActivaId === null
                        ? "border-l-4 border-l-accent bg-accent-soft"
                        : "hover:bg-surface-2",
                    )}
                  >
                    <div className="font-semibold text-fg">Todas</div>
                    <div className="text-xs text-fg-muted">{productosDisponibles.length} productos</div>
                  </button>

                  {categorias.length === 0 ? (
                    <div className="p-3 text-sm text-fg-muted">No hay categorías creadas.</div>
                  ) : (
                    categorias.map((c) => {
                      const count = productosDisponibles.filter(
                        (p) => p.ID_Categoria === c.ID_Categoria,
                      ).length;
                      const active = categoriaActivaId === c.ID_Categoria;

                      return (
                        <button
                          key={c.ID_Categoria}
                          type="button"
                          onClick={() => setCategoriaActivaId(c.ID_Categoria)}
                          className={cn(
                            "w-full cursor-pointer border-b border-border px-3 py-2 text-left transition",
                            active
                              ? "border-l-4 border-l-accent bg-accent-soft"
                              : "hover:bg-surface-2",
                          )}
                        >
                          <div className="truncate font-semibold text-fg">{c.Nombre}</div>
                          <div className="text-xs text-fg-muted">{count} productos</div>
                        </button>
                      );
                    })
                  )}
                </div>
              </div>
            </div>

            <div className="min-w-0 flex-1">
              {productosDisponiblesFiltrados.length === 0 ? (
                <div className="text-fg-muted">
                  {categorias.length > 0 && categoriaActivaId !== null
                    ? "No hay productos en esta categoría con ese filtro."
                    : "No hay productos para mostrar."}
                </div>
              ) : (
                <div className="max-h-[55vh] overflow-auto pr-1">
                  <div className="grid w-full grid-cols-1 gap-3 sm:grid-cols-[repeat(auto-fill,minmax(240px,1fr))]">
                    {productosDisponiblesFiltrados.map((p) => {
                      const checked = seleccionProductoIds.has(p.ID_Producto);
                      return (
                        <button
                          key={p.ID_Producto}
                          type="button"
                          onClick={() => toggleSeleccion(p.ID_Producto)}
                          className={cn(
                            "cursor-pointer rounded-xl border p-3 text-left transition",
                            checked
                              ? "border-accent bg-accent-soft"
                              : "border-border hover:border-border-strong hover:bg-surface-2",
                          )}
                        >
                          <div className="flex items-center gap-3">
                            <div className="flex h-[54px] w-[54px] shrink-0 items-center justify-center overflow-hidden rounded-lg border border-border bg-surface-2">
                              {p.urlImagen ? (
                                <img src={p.urlImagen} alt={p.Nombre} className="h-full w-full object-cover" draggable={false} />
                              ) : (
                                <ImageOff className="size-5 text-fg-subtle" aria-hidden />
                              )}
                            </div>

                            <div className="flex-1 min-w-0">
                              <div className="flex items-center justify-between gap-2">
                                <p className="truncate font-semibold text-fg">{p.Nombre}</p>
                                <input type="checkbox" checked={checked} readOnly className="size-4 accent-accent" />
                              </div>
                            </div>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        <div className="mt-5 grid grid-cols-2 gap-2 sm:flex sm:items-center sm:justify-end sm:gap-3">
          <button
            type="button"
            onClick={() => setModalVincularOpen(false)}
            className="cursor-pointer rounded-xl border border-border bg-surface px-4 py-2 font-semibold text-fg transition hover:bg-surface-2"
          >
            Cancelar
          </button>

          <button
            type="button"
            onClick={guardarVinculos}
            disabled={loading}
            className={cn(
              "rounded-xl px-4 py-2 font-semibold transition",
              loading
                ? "cursor-not-allowed bg-surface-2 text-fg-subtle"
                : "bg-accent text-accent-fg shadow-sm hover:bg-accent-hover active:scale-[0.98] cursor-pointer",
            )}
          >
            {loading ? "Guardando..." : "Guardar vínculos"}
          </button>
        </div>
      </Modal>

      <Modal
        open={modalCrearProductoOpen}
        onClose={() => setModalCrearProductoOpen(false)}
        title="Crear producto"
        zIndex={80}
        widthClass="max-w-[760px]"
      >
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 sm:gap-4">
          <Campo label="Nombre *" value={pNombre} onChange={setPNombre} placeholder="Ej: Coca-Cola 33cl" />
          <Campo label="Precio venta" value={pPrecio} onChange={setPPrecio} placeholder="Ej: 1.80" />

          <div>
            <label className="text-sm font-semibold text-fg">Categoría *</label>
            <select
              value={pCategoriaId}
              onChange={(e) => setPCategoriaId(e.target.value || "")}
              className="mt-1 h-10 w-full rounded-xl border border-border bg-surface-2 px-3 text-fg outline-none transition focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-ring"
            >
              {categorias.length === 0 ? (
                <option value="">No hay categorías</option>
              ) : (
                <>
                  <option value="">Selecciona…</option>
                  {categorias.map((c) => (
                    <option key={c.ID_Categoria} value={c.ID_Categoria}>
                      {c.Nombre}
                    </option>
                  ))}
                </>
              )}
            </select>
          </div>

          <Campo label="Unidad medida" value={pUnidad} onChange={setPUnidad} placeholder="Ej: ud / kg / l" />
          <Campo label="Stock actual" value={pStockActual} onChange={setPStockActual} placeholder="Ej: 20" />
          <Campo label="Stock mínimo" value={pStockMin} onChange={setPStockMin} placeholder="Ej: 5" />
        </div>

        <div className="mt-6 grid grid-cols-2 gap-2 sm:flex sm:items-center sm:justify-end sm:gap-3">
          <button
            type="button"
            onClick={() => setModalCrearProductoOpen(false)}
            className="cursor-pointer rounded-xl border border-border bg-surface px-4 py-2 font-semibold text-fg transition hover:bg-surface-2"
          >
            Cancelar
          </button>

          <button
            type="button"
            onClick={crearProductoYSeleccionar}
            disabled={loading}
            className={cn(
              "rounded-xl px-4 py-2 font-semibold transition",
              loading
                ? "cursor-not-allowed bg-surface-2 text-fg-subtle"
                : "bg-accent text-accent-fg shadow-sm hover:bg-accent-hover active:scale-[0.98] cursor-pointer",
            )}
          >
            {loading ? "Creando..." : "Crear producto"}
          </button>
        </div>

        <p className="mt-3 text-sm text-fg-muted">Este producto se crea ya vinculado al proveedor actual.</p>
      </Modal>

      <ProductDetailModal
        open={openProductDetail}
        onClose={() => setOpenProductDetail(false)}
        productId={productDetailId}
        onEdit={(id) => {
          setOpenProductDetail(false);
          setProductIdToEdit(id);
          setOpenAddProduct(true);
        }}
        onDeleted={(id) => {
          eliminarProductoDelProveedor(id, true);
        }}
      />

      <AddProductModal
        open={openAddProduct}
        onClose={() => {
          setOpenAddProduct(false);
          setProductIdToEdit(null);
        }}
        categoriaPreseleccionadaId={null}
        productIdToEdit={productIdToEdit}
        onSaved={async () => {
          await recargarProductosProveedor();
        }}
      />

      <Modal
        open={!!confirmAccion}
        onClose={() => {
          if (confirmando) return;
          setConfirmAccion(null);
        }}
        title={confirmAccion?.tipo === "proveedor" ? "Eliminar proveedor" : "Quitar producto del proveedor"}
        zIndex={95}
        widthClass="max-w-[520px]"
      >
        <div className="text-fg-muted">
          {confirmAccion?.tipo === "proveedor" ? (
            <p>
              ¿Seguro que quieres eliminar el proveedor{" "}
              <span className="font-semibold text-fg">"{confirmAccion.proveedor.Nombre_Empresa}"</span>?
            </p>
          ) : (
            <p>
              ¿Quitar este producto del proveedor?{" "}
              <span className="text-fg-muted">(No se borra el producto)</span>
              {confirmAccion?.nombreProducto ? (
                <>
                  <br />
                  <span className="font-semibold text-fg">"{confirmAccion.nombreProducto}"</span>
                </>
              ) : null}
            </p>
          )}
        </div>

        <div className="mt-6 flex justify-end gap-3">
          <button
            type="button"
            disabled={confirmando}
            onClick={() => setConfirmAccion(null)}
            className="cursor-pointer rounded-xl border border-border bg-surface px-4 py-2 font-semibold text-fg transition hover:bg-surface-2 disabled:opacity-60"
          >
            Cancelar
          </button>

          <button
            type="button"
            disabled={confirmando}
            onClick={confirmarAccionModal}
            className="inline-flex cursor-pointer items-center gap-1.5 rounded-xl border border-danger/30 bg-danger-soft px-4 py-2 font-semibold text-danger transition hover:opacity-90 disabled:opacity-60"
          >
            <Trash2 className="size-4" aria-hidden />
            {confirmando ? "Confirmando..." : "Confirmar"}
          </button>
        </div>
      </Modal>
    </div>
  );
}
