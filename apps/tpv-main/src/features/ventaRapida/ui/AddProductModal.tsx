import React, { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useToast } from "../../../shared/toast";
import Modal from "../ui/Modal";
import { cn } from "../utils";
import {
  type ProveedorMiniRow,
} from "../../InventaryComponents/api/inventarioAPI";
import {
  useCategorias,
  useCreateLote,
  useProveedoresMini,
  useUpsertProducto,
} from "../../InventaryComponents/inventarioQueries";
import { useMode } from "../../../shared/stores/useMode";

type CategoriaMini = { ID_Categoria: number; Nombre: string };
type ProveedorMini = {
  ID_Proveedor: number;
  Nombre_Empresa: string;
  Email: string | null;
};

const convertirABase64 = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.readAsDataURL(file);
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = (error) => reject(error);
  });

function parseNullableNumber(value: string): number | null {
  const raw = String(value ?? "").trim().replace(",", ".");
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function trimOrNull(value: string): string | null {
  const t = String(value ?? "").trim();
  return t ? t : null;
}

function toSqlDateTimeOrNull(value: string): string | null {
  const t = String(value ?? "").trim();
  return t ? `${t} 00:00:00` : null;
}

function buildInitialLoteCode(productId: number): string {
  const stamp = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
  return `INI-${productId}-${stamp}`;
}

export default function AddProductModal({
  open,
  onClose,
  onSaved,
  categoriaPreseleccionadaId,
}: {
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
  categoriaPreseleccionadaId: number | null;
}) {
  const toast = useToast();

  // Datos de referencia del formulario, cacheados (sólo se cargan con el modal abierto).
  const categoriasQuery = useCategorias();
  const proveedoresQuery = useProveedoresMini();

  const upsertProducto = useUpsertProducto();
  const createLote = useCreateLote();
  const deviceMode = useMode((s) => s.mode);

  const categorias: CategoriaMini[] = useMemo(
    () =>
      (categoriasQuery.data ?? []).map((c) => ({
        ID_Categoria: Number(c.ID_Categoria),
        Nombre: String(c.Nombre ?? ""),
      })),
    [categoriasQuery.data],
  );
  const proveedores: ProveedorMini[] = useMemo(
    () =>
      (proveedoresQuery.data ?? []).map((p: ProveedorMiniRow) => ({
        ID_Proveedor: Number(p.ID_Proveedor),
        Nombre_Empresa: String(p.Nombre_Empresa ?? ""),
        Email: p.Email ?? null,
      })),
    [proveedoresQuery.data],
  );

  const [idCategoria, setIdCategoria] = useState<number | "">("");
  const [idProveedor, setIdProveedor] = useState<number | "">("");

  const [nombre, setNombre] = useState("");
  const [precioVenta, setPrecioVenta] = useState("");
  const [stockActual, setStockActual] = useState("");
  const [stockMinimo, setStockMinimo] = useState("");
  const [unidadMedida, setUnidadMedida] = useState("");

  const [cantidadPedidoEsperada, setCantidadPedidoEsperada] = useState("");
  const [ultimaEntrada, setUltimaEntrada] = useState("");
  const [caducidadProxima, setCaducidadProxima] = useState("");

  const [image, setImage] = useState<File | null>(null);
  const [loading, setLoading] = useState(false);

  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const pickFile = () => fileInputRef.current?.click();

  const handleFile = (file: File | null) => {
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      toast.info("Validación", "Solo se permiten imágenes.");
      return;
    }
    setImage(file);
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    if (loading) return;
    const file = e.dataTransfer.files?.[0] ?? null;
    handleFile(file);
  };

  const previewUrl = useMemo(() => {
    if (!image) return "";
    return URL.createObjectURL(image);
  }, [image]);

  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  useEffect(() => {
    if (!open) return;

    setLoading(false);
    setImage(null);
    setNombre("");
    setPrecioVenta("");
    setStockActual("");
    setStockMinimo("");
    setUnidadMedida("");
    setCantidadPedidoEsperada("");
    setUltimaEntrada("");
    setCaducidadProxima("");
    setIdProveedor("");

    if (categoriaPreseleccionadaId) setIdCategoria(categoriaPreseleccionadaId);
    else setIdCategoria("");
  }, [open, categoriaPreseleccionadaId]);

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();

    // En Handy la imagen NO es obligatoria: no hay bucket y `save_image` solo escribiría
    // en el AppData local del Handy (no se sincroniza). En la Main sigue siendo obligatoria.
    const requiereImagen = deviceMode !== "handy";
    if (!nombre.trim() || idCategoria === "" || (requiereImagen && !image)) {
      toast.info(
        "Validación",
        requiereImagen
          ? "Nombre, categoría e imagen son obligatorios."
          : "Nombre y categoría son obligatorios.",
      );
      return;
    }

    setLoading(true);

    try {
      let nombreArchivo = "";
      let rutaParaBD = "";

      // En Handy subimos el producto sin imagen (cadena vacía → placeholder).
      if (image && deviceMode !== "handy") {
        const uuid = crypto.randomUUID();
        const extension = image.name.split(".").pop() || "png";
        nombreArchivo = `${uuid}.${extension}`;
        const subcarpeta = "productos";
        rutaParaBD = `images/${subcarpeta}/${nombreArchivo}`;

        const base64String = await convertirABase64(image);
        const base64Data = base64String.split(",")[1];

        await invoke("save_image", {
          args: {
            subfolder: subcarpeta,
            filename: nombreArchivo,
            base64_data: base64Data,
          },
        });
      }

      const nuevoProductoId = await upsertProducto.mutateAsync({
        id_categoria: Number(idCategoria),
        id_proveedor: idProveedor === "" ? null : Number(idProveedor),
        nombre: nombre.trim(),
        precio_venta: parseNullableNumber(precioVenta),
        stock_minimo: parseNullableNumber(stockMinimo),
        unidad_medida: trimOrNull(unidadMedida),
        nombre_imagen: nombreArchivo,
        ruta_imagen: rutaParaBD,
        cantidad_pedido_esperada: parseNullableNumber(cantidadPedidoEsperada),
        ids_alergenos: [],
      });

      if (!nuevoProductoId || nuevoProductoId <= 0) {
        throw new Error("No se pudo obtener el ID del producto creado.");
      }

      const stockInicial = parseNullableNumber(stockActual) ?? 0;

      if (stockInicial > 0) {
        await createLote.mutateAsync({
          id_producto: nuevoProductoId,
          codigo_lote: buildInitialLoteCode(nuevoProductoId),
          caducidad: trimOrNull(caducidadProxima),
          cantidad_inicial: stockInicial,
          stock_disponible: stockInicial,
          fecha_entrada: toSqlDateTimeOrNull(ultimaEntrada),
          id_proveedor: idProveedor === "" ? null : Number(idProveedor),
          notas: "Lote inicial creado desde venta rápida",
        });
      }

      onSaved();
      onClose();
    } catch (err) {
      console.error("Error guardando producto:", err);
      toast.error("Error", "Error al guardar el producto");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="Añadir producto" maxWidthClass="max-w-[980px]">
      <form
        onSubmit={handleSubmit}
        className="
          grid grid-cols-1 md:grid-cols-2
          gap-2 sm:gap-3
        "
      >
        <div className="md:col-span-2">
          <label className="font-semibold">Nombre *</label>
          <input
            type="text"
            value={nombre}
            onChange={(e) => setNombre(e.target.value)}
            className="
              border border-negro/20 rounded-xl w-full
              px-3 py-2 sm:py-2.5
              text-sm sm:text-base
            "
            required
            disabled={loading}
          />
        </div>

        <div>
          <label className="font-semibold">Categoría *</label>
          <select
            value={idCategoria}
            onChange={(e) => setIdCategoria(e.target.value ? Number(e.target.value) : "")}
            className="
              border border-negro/20 rounded-xl w-full
              px-3 py-2 sm:py-2.5
              text-sm sm:text-base
            "
            required
            disabled={loading}
          >
            <option value="">Selecciona</option>
            {categorias.map((c) => (
              <option key={c.ID_Categoria} value={c.ID_Categoria}>
                {c.Nombre}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="font-semibold">Proveedor</label>
          <select
            value={idProveedor}
            onChange={(e) => setIdProveedor(e.target.value ? Number(e.target.value) : "")}
            className="
              border border-negro/20 rounded-xl w-full
              px-3 py-2 sm:py-2.5
              text-sm sm:text-base
            "
            disabled={loading}
          >
            <option value="">—</option>
            {proveedores.map((p) => (
              <option key={p.ID_Proveedor} value={p.ID_Proveedor}>
                {p.Nombre_Empresa}
              </option>
            ))}
          </select>
        </div>

        <input
          type="number"
          step="0.01"
          placeholder="Precio venta"
          value={precioVenta}
          onChange={(e) => setPrecioVenta(e.target.value)}
          className="border border-negro/20 rounded-xl px-3 py-2 sm:py-2.5 text-sm sm:text-base"
          disabled={loading}
        />

        <input
          type="text"
          placeholder="Unidad (kg, ud, l...)"
          value={unidadMedida}
          onChange={(e) => setUnidadMedida(e.target.value)}
          className="border border-negro/20 rounded-xl px-3 py-2 sm:py-2.5 text-sm sm:text-base"
          disabled={loading}
        />

        <input
          type="number"
          step="0.01"
          placeholder="Stock actual"
          value={stockActual}
          onChange={(e) => setStockActual(e.target.value)}
          className="border border-negro/20 rounded-xl px-3 py-2 sm:py-2.5 text-sm sm:text-base"
          disabled={loading}
        />

        <input
          type="number"
          step="0.01"
          placeholder="Stock mínimo"
          value={stockMinimo}
          onChange={(e) => setStockMinimo(e.target.value)}
          className="border border-negro/20 rounded-xl px-3 py-2 sm:py-2.5 text-sm sm:text-base"
          disabled={loading}
        />

        <input
          type="number"
          step="0.01"
          placeholder="Cantidad pedido esperada"
          value={cantidadPedidoEsperada}
          onChange={(e) => setCantidadPedidoEsperada(e.target.value)}
          className="border border-negro/20 rounded-xl px-3 py-2 sm:py-2.5 text-sm sm:text-base"
          disabled={loading}
        />

        <div>
          <label className="text-xs sm:text-sm font-semibold">Última entrada</label>
          <input
            type="date"
            value={ultimaEntrada}
            onChange={(e) => setUltimaEntrada(e.target.value)}
            className="
              border border-negro/20 rounded-xl w-full
              px-3 py-2 sm:py-2.5
              text-sm sm:text-base
            "
            disabled={loading}
          />
        </div>

        <div>
          <label className="text-xs sm:text-sm font-semibold">Caducidad próxima</label>
          <input
            type="date"
            value={caducidadProxima}
            onChange={(e) => setCaducidadProxima(e.target.value)}
            className="
              border border-negro/20 rounded-xl w-full
              px-3 py-2 sm:py-2.5
              text-sm sm:text-base
            "
            disabled={loading}
          />
        </div>

        <div className="md:col-span-2 flex flex-col gap-2">
          <label className="font-semibold text-negro">
            Imagen <span className="text-rojo">*</span>
          </label>

          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => handleFile(e.target.files?.[0] ?? null)}
            disabled={loading}
          />

          <div
            onClick={() => !loading && pickFile()}
            onDragOver={(e) => e.preventDefault()}
            onDrop={handleDrop}
            className="
              cursor-pointer rounded-2xl border-2 border-dashed transition
              p-3 sm:p-4
              border-verde/60 hover:border-verde
            "
          >
            {!image ? (
              <div className="flex flex-col sm:flex-row items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 sm:w-11 sm:h-11 rounded-2xl border border-negro/10 bg-gris flex items-center justify-center">
                    <svg
                      className="w-6 h-6 text-negro/70"
                      xmlns="http://www.w3.org/2000/svg"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                      strokeWidth={2}
                    >
                      <path strokeLinecap="round" strokeLinejoin="round" d="M12 16v-8m0 0l-3 3m3-3l3 3" />
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        d="M20 16.5a4.5 4.5 0 00-1.3-3.2A4.5 4.5 0 0015.5 12H15a6 6 0 10-12 0h-.5A4.5 4.5 0 002 16.5 4.5 4.5 0 006.5 21h11A4.5 4.5 0 0020 16.5z"
                      />
                    </svg>
                  </div>
                  <div>
                    <p className="font-bold text-negro text-sm sm:text-base">Sube una imagen</p>
                    <p className="text-xs sm:text-sm text-negro/60">Click o arrastra y suelta (PNG/JPG).</p>
                  </div>
                </div>

                <div className="w-full sm:w-auto text-center px-4 py-2 rounded-xl bg-verde text-white font-bold text-sm sm:text-base">
                  Elegir archivo
                </div>
              </div>
            ) : (
              <div className="flex flex-col sm:flex-row gap-3 sm:gap-4 items-center">
                <div className="w-full sm:w-[220px] aspect-[4/3] rounded-2xl overflow-hidden border border-negro/10 bg-gris">
                  <img src={previewUrl} alt="preview" className="w-full h-full object-cover" />
                </div>

                <div className="flex-1 w-full min-w-0">
                  <p className="font-bold text-negro break-words text-sm sm:text-base">{image.name}</p>
                  <p className="text-xs sm:text-sm text-negro/60">{(image.size / 1024 / 1024).toFixed(2)} MB</p>

                  <div className="grid grid-cols-2 gap-2 mt-3">
                    <button
                      type="button"
                      onClick={pickFile}
                      disabled={loading}
                      className="border border-negro/20 rounded-xl py-2 font-semibold hover:bg-gris transition text-sm sm:text-base"
                    >
                      Cambiar
                    </button>
                    <button
                      type="button"
                      onClick={() => setImage(null)}
                      disabled={loading}
                      className="border border-rojo text-rojo rounded-xl py-2 font-semibold hover:bg-rojo hover:text-white transition text-sm sm:text-base"
                    >
                      Quitar
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>

          {!image && <p className="text-xs text-negro/60">La imagen es obligatoria para crear un producto.</p>}
        </div>

        <div className="md:col-span-2 grid grid-cols-1 sm:grid-cols-2 gap-2 mt-2">
          <button
            type="button"
            onClick={onClose}
            disabled={loading}
            className="w-full px-4 py-2.5 rounded-xl border border-negro/20 hover:bg-gris transition font-semibold text-sm sm:text-base"
          >
            Cancelar
          </button>

          <button
            type="submit"
            disabled={loading}
            className={cn(
              "w-full px-4 py-2.5 rounded-xl font-extrabold transition text-sm sm:text-base",
              loading ? "bg-gray-400 cursor-not-allowed text-white" : "bg-verde text-white hover:opacity-90",
            )}
          >
            {loading ? "Guardando..." : "Guardar producto"}
          </button>
        </div>
      </form>
    </Modal>
  );
}