import { guardarImagen } from "../../../shared/lib/guardarImagen";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useToast } from "../../../shared/toast";
import Modal from "../ui/Modal";
import { cn } from "../utils";
import { CampoDinero, useImporte } from "../../../shared/ui/CampoDinero";
import {
  useCategorias,
  useCreateLote,
  useProveedoresMini,
  useUpsertProducto,
} from "../../InventaryComponents/inventarioQueries";
import { triggerImageUploadDrain } from "../../../shared/lib/imageUrl";
import { conAviso } from "../../../shared/lib/conAviso";




/** Una cantidad escrita a mano; vacío o ilegible = sin informar. */
function numeroOpcional(value: string): number | undefined {
  const raw = String(value ?? "").trim().replace(",", ".");
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

function textoOpcional(value: string): string | undefined {
  return String(value ?? "").trim() || undefined;
}

function fechaHoraOpcional(value: string): string | undefined {
  const t = String(value ?? "").trim();
  return t ? `${t} 00:00:00` : undefined;
}

function buildInitialLoteCode(productId: string): string {
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
  categoriaPreseleccionadaId: string | null;
}) {
  const toast = useToast();

  // Datos de referencia del formulario, cacheados (sólo se cargan con el modal abierto).
  const categoriasQuery = useCategorias();
  const proveedoresQuery = useProveedoresMini();

  const upsertProducto = useUpsertProducto();
  const createLote = useCreateLote();

  const categorias = categoriasQuery.data ?? [];
  const proveedores = proveedoresQuery.data ?? [];

  const [idCategoria, setIdCategoria] = useState<string>("");
  const [idProveedor, setIdProveedor] = useState<string>("");

  const [nombre, setNombre] = useState("");
  const precio = useImporte();
  const ponerPrecio = precio.poner;
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
    ponerPrecio(null);
    setStockActual("");
    setStockMinimo("");
    setUnidadMedida("");
    setCantidadPedidoEsperada("");
    setUltimaEntrada("");
    setCaducidadProxima("");
    setIdProveedor("");

    if (categoriaPreseleccionadaId) setIdCategoria(categoriaPreseleccionadaId);
    else setIdCategoria("");
  }, [open, categoriaPreseleccionadaId, ponerPrecio]);

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();

    // La imagen es obligatoria (ahora se sube a R2 también desde Handy).
    if (!nombre.trim() || idCategoria === "" || !image) {
      toast.info("Validación", "Nombre, categoría e imagen son obligatorios.");
      return;
    }
    if (!precio.legible) {
      toast.info("Validación", "El precio de venta no se entiende como importe.");
      return;
    }

    setLoading(true);

    try {
      let nombreArchivo = "";
      let rutaParaBD = "";

      // La imagen se procesa (redimensionado conservando el formato) en Rust y se sube a R2 (Main y Handy).
      if (image) {
          const guardada = await guardarImagen(image, "productos");
          nombreArchivo = guardada.nombre;
          rutaParaBD = guardada.ruta;
      }

      const nuevoProductoId = await upsertProducto.mutateAsync({
        id_categoria: idCategoria,
        id_proveedor: idProveedor || undefined,
        nombre: nombre.trim(),
        precio_venta: precio.valor ?? undefined,
        stock_minimo: numeroOpcional(stockMinimo),
        unidad_medida: textoOpcional(unidadMedida),
        nombre_imagen: nombreArchivo,
        ruta_imagen: rutaParaBD,
        cantidad_pedido_esperada: numeroOpcional(cantidadPedidoEsperada),
        ids_alergenos: [],
      });

      if (!nuevoProductoId) {
        throw new Error("No se pudo obtener el ID del producto creado.");
      }

      if (image) triggerImageUploadDrain();

      const stockInicial = numeroOpcional(stockActual) ?? 0;

      if (stockInicial > 0) {
        await createLote.mutateAsync({
          id_producto: nuevoProductoId,
          codigo_lote: buildInitialLoteCode(nuevoProductoId),
          caducidad: textoOpcional(caducidadProxima),
          stock_disponible: stockInicial,
          fecha_entrada: fechaHoraOpcional(ultimaEntrada),
          id_proveedor: idProveedor || undefined,
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
        onSubmit={conAviso(handleSubmit)}
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
            onChange={(e) => setIdCategoria(e.target.value || "")}
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
            onChange={(e) => setIdProveedor(e.target.value || "")}
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

        <CampoDinero
          {...precio.campo}
          placeholder="Precio venta"
          aria-label="Precio venta"
          className="w-full border border-negro/20 rounded-xl px-3 py-2 sm:py-2.5 text-sm sm:text-base"
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
            accept="image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp"
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