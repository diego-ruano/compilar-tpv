import { useEffect, useMemo, useRef, useState } from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { appDataDir, join } from "@tauri-apps/api/path";
import { useToast } from "../components/toast";
import { ReactComponent as LapizSVG } from "../assets/svg/LapizSVG.svg";

import Product from "../components/InventaryComponents/Product";
import Modal from "../components/proveedores/Modal";
import Campo from "../components/proveedores/Campo";
import ProveedorCard from "../components/proveedores/ProveedorCard";
import ProductDetailModal from "../components/InventaryComponents/ProductDetailModal";
import { AddProductModal } from "../components/InventaryComponents/ui/AddProductModal";

import {
  proveedoresGetAll,
  proveedoresSave,
  proveedoresDelete,
  proveedoresGetProductos,
  proveedoresGetCategorias,
  proveedoresGetProductosAll,
  proveedoresSetVinculos,
  proveedoresCreateProducto,
  type ProveedorRow,
  type ProductoRow,
  type Categoria,
} from "../components/proveedores/proveedoresApis";

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

function safeExtFromName(name: string) {
  const dot = name.lastIndexOf(".");
  if (dot === -1) return "png";
  const ext = name
    .slice(dot + 1)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
  return ext || "png";
}

export default function Proveedores() {
  const [openAddProduct, setOpenAddProduct] = useState(false);
  const [productIdToEdit, setProductIdToEdit] = useState<number | null>(null);

  const [openProductDetail, setOpenProductDetail] = useState(false);
  const [productDetailId, setProductDetailId] = useState<number | null>(null);

  const [vista, setVista] = useState<Vista>("list");
  const [busqueda, setBusqueda] = useState("");

  const [loading, setLoading] = useState(false);
  const [proveedores, setProveedores] = useState<ProveedorUI[]>([]);
  const [proveedorActivo, setProveedorActivo] = useState<ProveedorUI | null>(null);
  const toast = useToast();

  const [confirmAccion, setConfirmAccion] = useState<
    | { tipo: "proveedor"; proveedor: ProveedorUI }
    | { tipo: "producto"; idProducto: number; nombreProducto?: string; cerrarDetalle?: boolean }
    | null
  >(null);
  const [confirmando, setConfirmando] = useState(false);

  const [productosProveedor, setProductosProveedor] = useState<ProductoUI[]>([]);
  const [categorias, setCategorias] = useState<Categoria[]>([]);

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
  const [seleccionProductoIds, setSeleccionProductoIds] = useState<Set<number>>(new Set());
  const [categoriaActivaId, setCategoriaActivaId] = useState<number | null>(null);

  const [pNombre, setPNombre] = useState("");
  const [pPrecio, setPPrecio] = useState("");
  const [pStockActual, setPStockActual] = useState("");
  const [pStockMin, setPStockMin] = useState("");
  const [pUnidad, setPUnidad] = useState("");
  const [pCategoriaId, setPCategoriaId] = useState<number | "">("");

  async function proveedorRutaToUrl(ruta: string | null) {
    if (!ruta) return "";
    const base = await appDataDir();
    return convertFileSrc(await join(base, ruta));
  }

  async function mapProveedoresUI(rows: ProveedorRow[]): Promise<ProveedorUI[]> {
    const out: ProveedorUI[] = [];
    for (const r of rows) {
      out.push({
        ...r,
        urlImagen: await proveedorRutaToUrl(r.Ruta_Imagen),
      });
    }
    return out;
  }

  async function mapProductosUI(rows: ProductoRow[]): Promise<ProductoUI[]> {
    const baseDir = await appDataDir();

    return await Promise.all(
      (rows ?? []).map(async (p) => ({
        ...p,
        urlImagen: p.Ruta_Imagen ? convertFileSrc(await join(baseDir, p.Ruta_Imagen)) : "",
      })),
    );
  }

  async function recargarProveedoresManteniendoSeleccion() {
    try {
      const rows = await proveedoresGetAll();
      const ui = await mapProveedoresUI(rows);
      setProveedores(ui);

      if (proveedorActivo) {
        const id = Number(proveedorActivo.ID_Proveedor);
        const updated = ui.find((x) => Number(x.ID_Proveedor) === id);
        if (updated) setProveedorActivo(updated);
      }
    } catch (e) {
      console.error("Error recargando proveedores", e);
    }
  }

  async function recargarProductosProveedor() {
    if (!proveedorActivo) return;

    setLoading(true);
    try {
      const idProv = Number(proveedorActivo.ID_Proveedor);
      const rows = await proveedoresGetProductos({ idProveedor: idProv });
      const ui = await mapProductosUI(rows);
      setProductosProveedor(ui);
    } catch (e) {
      console.error("Error recargando productos del proveedor", e);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    const loadProveedores = async () => {
      setLoading(true);
      try {
        const rows = await proveedoresGetAll();
        const ui = await mapProveedoresUI(rows);
        setProveedores(ui);
      } catch (e) {
        console.error("Error cargando proveedores", e);
        setProveedores([]);
      } finally {
        setLoading(false);
      }
    };

    loadProveedores();
  }, []);

  useEffect(() => {
    const loadCategorias = async () => {
      try {
        const rows = await proveedoresGetCategorias();
        setCategorias(rows);
      } catch (e) {
        console.warn("No se pudieron cargar categorías", e);
        setCategorias([]);
      }
    };

    loadCategorias();
  }, []);

  useEffect(() => {
    const loadProductosProveedor = async () => {
      if (vista !== "detail" || !proveedorActivo) return;
      await recargarProductosProveedor();
    };

    loadProductosProveedor();
  }, [vista, proveedorActivo]);

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
      list = list.filter((p) => Number(p.ID_Categoria) === Number(categoriaActivaId));
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

    setLoading(true);
    try {
      let nombreImagen: string | null = null;
      let rutaImagen: string | null = null;

      if (fotoNuevaFile) {
        const uuid = crypto.randomUUID();
        const ext = safeExtFromName(fotoNuevaFile.name);
        nombreImagen = `prov_${uuid}.${ext}`;

        const subcarpeta = "proveedores";
        rutaImagen = `images/${subcarpeta}/${nombreImagen}`;

        const base64String = await convertirABase64(fotoNuevaFile);
        const base64Data = base64String.split(",")[1];

        await invoke("save_image", {
          subfolder: subcarpeta,
          filename: nombreImagen,
          base64Data,
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

      const ok = await proveedoresSave({
        idProveedor: modalProveedorModo === "editar" ? Number(proveedorActivo?.ID_Proveedor ?? 0) : null,
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

      setModalProveedorOpen(false);
      await recargarProveedoresManteniendoSeleccion();
    } catch (e: any) {
      console.error("Error guardando proveedor", e);
      toast.error("Error", "No se pudo guardar. Revisa si el Email o el CIF ya existen.");
    } finally {
      setLoading(false);
    }
  }

  function eliminarProveedor() {
    if (!proveedorActivo) return;
    setConfirmAccion({ tipo: "proveedor", proveedor: proveedorActivo });
  }

  function eliminarProductoDelProveedor(idProducto: number, cerrarDetalle = false) {
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
        setLoading(true);
        try {
          const id = Number(confirmAccion.proveedor.ID_Proveedor);
          const deleted = await proveedoresDelete({ idProveedor: id });
          if (!deleted) {
            toast.error("Error", "No se pudo eliminar el proveedor.");
            return;
          }

          await recargarProveedoresManteniendoSeleccion();
          volverALista();
          setConfirmAccion(null);
        } catch (e) {
          console.error("Error eliminando proveedor", e);
          toast.error("Error", "No se pudo eliminar el proveedor.");
        } finally {
          setLoading(false);
        }
      }

      if (confirmAccion.tipo === "producto") {
        setLoading(true);
        try {
          const idProv = Number(proveedorActivo.ID_Proveedor);

          const next = productosProveedor
            .filter((x) => x.ID_Producto !== confirmAccion.idProducto)
            .map((x) => Number(x.ID_Producto));

          const ok = await proveedoresSetVinculos({
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
        } finally {
          setLoading(false);
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
      const idProv = Number(proveedorActivo.ID_Proveedor);
      const rows = await proveedoresGetProductosAll();
      const ui = await mapProductosUI(rows);

      setProductosDisponibles(ui);

      const pre = new Set<number>();
      for (const p of ui) {
        if (Number(p.ID_Proveedor) === idProv) pre.add(p.ID_Producto);
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

  function toggleSeleccion(idProducto: number) {
    setSeleccionProductoIds((prev) => {
      const next = new Set(prev);
      if (next.has(idProducto)) next.delete(idProducto);
      else next.add(idProducto);
      return next;
    });
  }

  async function guardarVinculos() {
    if (!proveedorActivo) return;

    const idProv = Number(proveedorActivo.ID_Proveedor);
    const idsSeleccionados = Array.from(seleccionProductoIds);

    setLoading(true);
    try {
      const ok = await proveedoresSetVinculos({
        idProveedor: idProv,
        productoIds: idsSeleccionados.map(Number),
      });
      if (!ok) {
        toast.error("Error", "No se pudieron guardar los vínculos.");
        return;
      }

      await recargarProductosProveedor();
      setModalVincularOpen(false);
    } catch (e) {
      console.error("Error guardando vínculos", e);
      toast.error("Error", "No se pudieron guardar los vínculos.");
    } finally {
      setLoading(false);
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

    const idProv = Number(proveedorActivo.ID_Proveedor);
    const idCat = Number(pCategoriaId);
    const precio = toNumOrNull(pPrecio);
    const stockA = toNumOrNull(pStockActual);
    const stockM = toNumOrNull(pStockMin);
    const unidad = pUnidad.trim();

    setLoading(true);
    try {
      const idNuevo = await proveedoresCreateProducto({
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
    } finally {
      setLoading(false);
    }
  }

  const titulo = useMemo(() => {
    if (vista === "list") return "PROVEEDORES";
    return `PROVEEDOR · ${proveedorActivo?.Nombre_Empresa ?? ""}`;
  }, [vista, proveedorActivo]);

  const categoriaActivaNombre = useMemo(() => {
    if (categoriaActivaId === null) return "Todas";
    const c = categorias.find((x) => Number(x.ID_Categoria) === Number(categoriaActivaId));
    return c?.Nombre ?? "Categoría";
  }, [categoriaActivaId, categorias]);

  return (
    <div className="w-full min-h-full bg-gris flex flex-col p-10 pt-5 gap-4 items-center">
      <div className="flex flex-col gap-4 bg-blanco w-full p-4 rounded-xl shadow-xs justify-center items-center">
        <div className="w-full relative flex items-center justify-center">
          {vista === "detail" && (
            <button
              type="button"
              onClick={volverALista}
              className="absolute left-0 flex cursor-pointer items-center gap-2 text-negro font-semibold hover:opacity-80 transition"
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
                className="w-5 h-5"
              >
                <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
              </svg>
              <span>Volver</span>
            </button>
          )}

          <h2 className="text-2xl font-bold text-center">{titulo}</h2>

          {vista === "list" ? (
            <button
              type="button"
              onClick={abrirNuevoProveedorModal}
              className="absolute right-0 group flex gap-2 w-fit items-center cursor-pointer border-2 border-verde rounded-xl px-3 py-1 text-verde transition-all duration-300 ease-out hover:bg-verde hover:text-white hover:shadow-md"
            >
              <LapizSVG
                width={18}
                height={18}
                className="transition-transform duration-300 group-hover:-translate-y-1 group-hover:rotate-6"
              />
              <p className="font-medium">Añadir Nuevo Proveedor</p>
            </button>
          ) : (
            <button
              type="button"
              onClick={() => setBusqueda("")}
              className="absolute right-0 border-2 border-negro rounded-xl px-3 py-1 hover:bg-negro hover:text-white transition"
            >
              Limpiar búsqueda
            </button>
          )}
        </div>

        <div className="w-full max-w-[820px]">
          <div className="w-full flex items-center gap-3 border-2 border-negro/20 rounded-xl px-4 py-2 bg-white">
            <span className="text-negro/70 select-none">🔎</span>
            <input
              value={busqueda}
              onChange={(e) => setBusqueda(e.target.value)}
              placeholder={vista === "list" ? "Buscar proveedor..." : "Buscar producto vinculado..."}
              className="w-full outline-none bg-transparent text-negro"
            />
            {loading && <span className="text-negro/60 text-sm">Cargando...</span>}
          </div>
        </div>
      </div>

      {vista === "list" && (
        <div className="w-full bg-blanco rounded-xl p-4 shadow-xs">
          {loading ? (
            <p className="text-negro/70">Cargando proveedores...</p>
          ) : proveedoresFiltrados.length === 0 ? (
            <p className="text-negro/70">No hay proveedores con ese filtro.</p>
          ) : (
            <div className="grid w-full gap-4 grid-cols-[repeat(auto-fill,minmax(200px,max-content))] self-center justify-between">
              {proveedoresFiltrados.map((p) => (
                <ProveedorCard key={p.ID_Proveedor} proveedor={p} onClick={() => abrirDetalleProveedor(p)} />
              ))}
            </div>
          )}
        </div>
      )}

      {vista === "detail" && proveedorActivo && (
        <>
          <div className="w-full bg-blanco rounded-xl p-4 shadow-xs flex gap-6">
            <div className="w-[280px] h-[280px] border-2 border-negro rounded-xl bg-gris flex items-center justify-center overflow-hidden">
              {proveedorActivo.urlImagen ? (
                <img
                  src={proveedorActivo.urlImagen}
                  alt={proveedorActivo.Nombre_Empresa}
                  className="w-full h-full object-cover"
                  draggable={false}
                />
              ) : (
                <div className="text-negro/50 font-bold text-xl text-center px-4">
                  {proveedorActivo.Nombre_Empresa}
                </div>
              )}
            </div>

            <div className="flex-1 flex flex-col gap-3 text-negro">
              <h3 className="text-2xl font-bold">{proveedorActivo.Nombre_Empresa}</h3>

              <div className="text-sm flex flex-col gap-1">
                <p>
                  <span className="font-semibold">Contacto:</span> {proveedorActivo.Contacto ?? "—"}
                </p>
                <p>
                  <span className="font-semibold">Teléfono:</span> {proveedorActivo.Telefono ?? "—"}
                </p>
                <p>
                  <span className="font-semibold">Email:</span> {proveedorActivo.Email ?? "—"}
                </p>
                <p>
                  <span className="font-semibold">CIF:</span> {proveedorActivo.CIF ?? "—"}
                </p>
                <p>
                  <span className="font-semibold">Otros:</span> {proveedorActivo.Informacion_adicional ?? "—"}
                </p>
              </div>

              <div className="mt-2 grid grid-cols-2 gap-3 max-w-[560px]">
                <button
                  className="border-2 border-verde text-verde rounded-xl py-2 hover:bg-verde hover:text-white transition font-semibold"
                  onClick={abrirEditarProveedorModal}
                >
                  Editar perfil
                </button>

                <button
                  className="border-2 border-verde text-verde rounded-xl py-2 hover:bg-verde hover:text-white transition font-semibold"
                  onClick={abrirVincularProductos}
                >
                  Vincular productos
                </button>

                <button
                  className="border-2 border-rojo text-rojo rounded-xl py-2 hover:bg-rojo hover:text-blanco transition font-semibold col-span-2"
                  onClick={eliminarProveedor}
                >
                  Eliminar proveedor
                </button>
              </div>
            </div>
          </div>

          <div className="w-full bg-blanco rounded-xl p-4 shadow-xs">
            <div className="flex items-center justify-between mb-4">
              <h4 className="text-xl font-bold text-negro">Productos vinculados</h4>

              <button
                type="button"
                onClick={abrirVincularProductos}
                className="border-2 border-verde rounded-xl px-3 py-1 text-verde cursor-pointer transition-all duration-300 ease-in-out hover:bg-verde hover:text-white"
              >
                Gestionar vínculos
              </button>
            </div>

            {productosProveedorFiltrados.length === 0 ? (
              <p className="text-negro/70">No hay productos vinculados.</p>
            ) : (
              <div className="grid w-full gap-4 grid-cols-[repeat(auto-fill,minmax(200px,max-content))]">
                {productosProveedorFiltrados.map((p) => (
                  <div key={p.ID_Producto} className="w-[200px]">
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
                      className="mt-2 w-full border-2 border-rojo text-rojo rounded-xl py-2 hover:bg-rojo hover:text-blanco transition font-semibold"
                    >
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
        <div className="mb-4 flex gap-4 items-start">
          <div className="w-[140px] h-[140px] rounded-xl border-2 border-negro bg-gris overflow-hidden flex items-center justify-center shrink-0">
            {fotoNuevaPreview ? (
              <img src={fotoNuevaPreview} className="w-full h-full object-cover" draggable={false} />
            ) : proveedorActivo?.urlImagen && modalProveedorModo === "editar" && !fotoEliminar ? (
              <img src={proveedorActivo.urlImagen} className="w-full h-full object-cover" draggable={false} />
            ) : (
              <span className="text-negro/50 font-semibold text-sm">Sin foto</span>
            )}
          </div>

          <div className="flex-1">
            <label className="font-semibold text-negro">Foto del proveedor</label>

            <div className="mt-1 border-2 border-negro rounded-xl px-4 py-3 bg-white flex items-center justify-between gap-3">
              <div className="text-sm text-negro/70">
                {fotoEliminar
                  ? "Se eliminará la foto"
                  : fotoNuevaFile
                    ? "Nueva foto seleccionada"
                    : modalProveedorModo === "editar" && proveedorActivo?.Ruta_Imagen
                      ? "Foto actual"
                      : "No hay foto aún"}
              </div>

              <div className="flex gap-2">
                <label className="cursor-pointer border-2 border-verde text-verde rounded-xl px-3 py-1 hover:bg-verde hover:text-white transition font-semibold">
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
                      className="border-2 border-rojo text-rojo rounded-xl px-3 py-1 hover:bg-rojo hover:text-white transition font-semibold"
                    >
                      Eliminar
                    </button>
                  );
                })()}
              </div>
            </div>

            {fotoEliminar && (
              <p className="mt-2 text-xs text-rojo/80">
                Se eliminará la foto al guardar. Si quieres otra, sube una nueva.
              </p>
            )}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4">
          <Campo label="Nombre empresa *" value={fNombre} onChange={setFNombre} placeholder="Ej: Coca-Cola" />
          <Campo label="Contacto" value={fContacto} onChange={setFContacto} placeholder="Ej: Juan Pérez" />

          <Campo label="Teléfono" value={fTelefono} onChange={setFTelefono} placeholder="Ej: 600123123" />
          <Campo label="Email" value={fEmail} onChange={setFEmail} placeholder="Ej: correo@empresa.com" type="email" />

          <Campo label="CIF" value={fCif} onChange={setFCif} placeholder="Ej: B12345678" />

          <div className="col-span-2">
            <label className="font-semibold text-negro">Otros datos</label>
            <textarea
              value={fOtros}
              onChange={(e) => setFOtros(e.target.value)}
              placeholder="Notas, condiciones, observaciones…"
              className="mt-1 w-full border border-negro rounded-lg px-3 py-2 text-negro outline-none bg-white min-h-[110px] resize-none"
            />
          </div>
        </div>

        <div className="mt-6 flex gap-3 justify-end">
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
            className="border-2 border-negro rounded-xl px-4 py-2 hover:bg-negro hover:text-white transition font-semibold"
          >
            Cancelar
          </button>

          <button
            type="button"
            onClick={guardarProveedor}
            disabled={loading}
            className={`border-2 rounded-xl px-4 py-2 font-semibold transition ${loading
                ? "border-gray-300 text-gray-400 cursor-not-allowed"
                : "border-verde text-verde hover:bg-verde hover:text-white"
              }`}
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
        <div className="flex items-center justify-between gap-3 mb-4">
          <div className="flex-1">
            <div className="w-full flex items-center gap-3 border-2 border-negro/20 rounded-xl px-4 py-2 bg-white">
              <span className="text-negro/70 select-none">🔎</span>
              <input
                value={busquedaProductos}
                onChange={(e) => setBusquedaProductos(e.target.value)}
                placeholder={`Buscar producto en "${categoriaActivaNombre}"...`}
                className="w-full outline-none bg-transparent text-negro"
              />
            </div>
          </div>

          <button
            type="button"
            onClick={abrirCrearProductoEnModal}
            className="border-2 border-verde rounded-xl px-3 py-2 text-verde cursor-pointer transition-all duration-300 ease-in-out hover:bg-verde hover:text-white font-semibold"
          >
            + Crear producto
          </button>
        </div>

        <div className="text-sm text-negro/70 mb-3">
          Selecciona una categoría y marca los productos que quieras vincular. (Los desmarcados se desvinculan)
        </div>

        {loadingVincular ? (
          <p className="text-negro/70">Cargando...</p>
        ) : (
          <div className="flex gap-4">
            <div className="w-[280px] shrink-0">
              <div className="border border-negro/10 rounded-xl overflow-hidden bg-white">
                <div className="px-3 py-2 border-b border-negro/10 font-semibold text-negro">Categorías</div>

                <div className="max-h-[55vh] overflow-auto">
                  <button
                    type="button"
                    onClick={() => setCategoriaActivaId(null)}
                    className={`w-full text-left px-3 py-2 border-b border-negro/10 transition ${categoriaActivaId === null ? "bg-verde/10 border-l-4 border-l-verde" : "hover:bg-gris/40"
                      }`}
                  >
                    <div className="font-semibold text-negro">Todas</div>
                    <div className="text-xs text-negro/60">{productosDisponibles.length} productos</div>
                  </button>

                  {categorias.length === 0 ? (
                    <div className="p-3 text-sm text-negro/60">No hay categorías creadas.</div>
                  ) : (
                    categorias.map((c) => {
                      const count = productosDisponibles.filter(
                        (p) => Number(p.ID_Categoria) === Number(c.ID_Categoria),
                      ).length;
                      const active = Number(categoriaActivaId) === Number(c.ID_Categoria);

                      return (
                        <button
                          key={c.ID_Categoria}
                          type="button"
                          onClick={() => setCategoriaActivaId(Number(c.ID_Categoria))}
                          className={`w-full text-left px-3 py-2 border-b border-negro/10 transition ${active ? "bg-verde/10 border-l-4 border-l-verde" : "hover:bg-gris/40"
                            }`}
                        >
                          <div className="font-semibold text-negro truncate">{c.Nombre}</div>
                          <div className="text-xs text-negro/60">{count} productos</div>
                        </button>
                      );
                    })
                  )}
                </div>
              </div>
            </div>

            <div className="flex-1 min-w-0">
              {productosDisponiblesFiltrados.length === 0 ? (
                <div className="text-negro/70">
                  {categorias.length > 0 && categoriaActivaId !== null
                    ? "No hay productos en esta categoría con ese filtro."
                    : "No hay productos para mostrar."}
                </div>
              ) : (
                <div className="max-h-[55vh] overflow-auto pr-1">
                  <div className="grid w-full gap-3 grid-cols-[repeat(auto-fill,minmax(240px,1fr))]">
                    {productosDisponiblesFiltrados.map((p) => {
                      const checked = seleccionProductoIds.has(p.ID_Producto);
                      return (
                        <button
                          key={p.ID_Producto}
                          type="button"
                          onClick={() => toggleSeleccion(p.ID_Producto)}
                          className={`text-left border rounded-xl p-3 transition ${checked ? "border-verde bg-verde/5" : "border-negro/10 hover:border-negro/30"
                            }`}
                        >
                          <div className="flex items-center gap-3">
                            <div className="w-[54px] h-[54px] bg-gris rounded-lg overflow-hidden border border-negro/10 flex items-center justify-center shrink-0">
                              {p.urlImagen ? (
                                <img src={p.urlImagen} alt={p.Nombre} className="w-full h-full object-cover" draggable={false} />
                              ) : (
                                <span className="text-negro/40 text-xs font-semibold">IMG</span>
                              )}
                            </div>

                            <div className="flex-1 min-w-0">
                              <div className="flex items-center justify-between gap-2">
                                <p className="font-semibold text-negro truncate">{p.Nombre}</p>
                                <input type="checkbox" checked={checked} readOnly className="w-4 h-4 accent-verde" />
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

        <div className="mt-5 flex items-center justify-end gap-3">
          <button
            type="button"
            onClick={() => setModalVincularOpen(false)}
            className="border-2 border-negro rounded-xl px-4 py-2 hover:bg-negro hover:text-white transition font-semibold"
          >
            Cancelar
          </button>

          <button
            type="button"
            onClick={guardarVinculos}
            disabled={loading}
            className={`border-2 rounded-xl px-4 py-2 font-semibold transition ${loading
                ? "border-gray-300 text-gray-400 cursor-not-allowed"
                : "border-verde text-verde hover:bg-verde hover:text-white"
              }`}
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
        <div className="grid grid-cols-2 gap-4">
          <Campo label="Nombre *" value={pNombre} onChange={setPNombre} placeholder="Ej: Coca-Cola 33cl" />
          <Campo label="Precio venta" value={pPrecio} onChange={setPPrecio} placeholder="Ej: 1.80" />

          <div>
            <label className="font-semibold text-negro">Categoría *</label>
            <select
              value={pCategoriaId}
              onChange={(e) => setPCategoriaId(e.target.value ? Number(e.target.value) : "")}
              className="mt-1 w-full border border-negro rounded-lg px-3 py-2 text-negro outline-none bg-white"
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

        <div className="mt-6 flex items-center justify-end gap-3">
          <button
            type="button"
            onClick={() => setModalCrearProductoOpen(false)}
            className="border-2 border-negro rounded-xl px-4 py-2 hover:bg-negro hover:text-white transition font-semibold"
          >
            Cancelar
          </button>

          <button
            type="button"
            onClick={crearProductoYSeleccionar}
            disabled={loading}
            className={`border-2 rounded-xl px-4 py-2 font-semibold transition ${loading
                ? "border-gray-300 text-gray-400 cursor-not-allowed"
                : "border-verde text-verde hover:bg-verde hover:text-white"
              }`}
          >
            {loading ? "Creando..." : "Crear producto"}
          </button>
        </div>

        <p className="mt-3 text-sm text-negro/60">Este producto se crea ya vinculado al proveedor actual.</p>
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
        <div className="text-negro/80">
          {confirmAccion?.tipo === "proveedor" ? (
            <p>
              ¿Seguro que quieres eliminar el proveedor{" "}
              <span className="font-semibold text-negro">"{confirmAccion.proveedor.Nombre_Empresa}"</span>?
            </p>
          ) : (
            <p>
              ¿Quitar este producto del proveedor?{" "}
              <span className="text-negro/70">(No se borra el producto)</span>
              {confirmAccion?.nombreProducto ? (
                <>
                  <br />
                  <span className="font-semibold text-negro">"{confirmAccion.nombreProducto}"</span>
                </>
              ) : null}
            </p>
          )}
        </div>

        <div className="mt-6 flex gap-3 justify-end">
          <button
            type="button"
            disabled={confirmando}
            onClick={() => setConfirmAccion(null)}
            className="border-2 border-negro rounded-xl px-4 py-2 hover:bg-negro hover:text-white transition font-semibold disabled:opacity-60"
          >
            Cancelar
          </button>

          <button
            type="button"
            disabled={confirmando}
            onClick={confirmarAccionModal}
            className="border-2 border-rojo text-rojo rounded-xl px-4 py-2 hover:bg-rojo hover:text-blanco transition font-semibold disabled:opacity-60"
          >
            {confirmando ? "Confirmando..." : "Confirmar"}
          </button>
        </div>
      </Modal>
    </div>
  );
}