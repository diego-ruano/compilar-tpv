import React, { useEffect, useMemo, useRef, useState } from "react";
import Modal from "../ui/Modal";
import { useToast } from "../../../shared/toast";
import { invoke } from "@tauri-apps/api/core";

import { convertirABase64 } from "../utils/inventarioFormat";
import { resolveImageUrl, triggerImageUploadDrain } from "../../../shared/lib/imageUrl";

import {
    inventarioAPI,
    type AlergenoRow,
    type ProveedorMiniRow,
} from "../api/inventarioAPI";
import {
    useAlergenos,
    useCategorias,
    useCreateLote,
    useProveedoresMini,
    useUpsertProducto,
} from "../inventarioQueries";

type CategoriaMini = { ID_Categoria: string; Nombre: string };

const UNIDADES_MEDIDA = ["UD", "KG", "GR", "MG", "L", "CL", "ML"] as const;

function toNum(v: any, fallback = 0) {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
}

const toImageUrlMaybe = resolveImageUrl;

export function AddProductModal({
    open,
    onClose,
    onSaved,
    categoriaPreseleccionadaId,
    productIdToEdit,
}: {
    open: boolean;
    onClose: () => void;
    onSaved: () => void;
    categoriaPreseleccionadaId: string | null;
    productIdToEdit: string | null;
}) {
    const isEdit = !!productIdToEdit;

    // Datos de referencia del formulario, cacheados (sólo se cargan con el modal abierto).
    const categoriasQuery = useCategorias();
    const proveedoresQuery = useProveedoresMini();
    const alergenosQuery = useAlergenos();

    const upsertProducto = useUpsertProducto();
    const createLote = useCreateLote();

    const categorias: CategoriaMini[] = useMemo(
        () =>
            (categoriasQuery.data ?? []).map((c) => ({
                ID_Categoria: String(c.ID_Categoria ?? ""),
                Nombre: c.Nombre,
            })),
        [categoriasQuery.data],
    );
    const proveedores: ProveedorMiniRow[] = proveedoresQuery.data ?? [];
    const alergenos: AlergenoRow[] = alergenosQuery.data ?? [];

    const [idCategoria, setIdCategoria] = useState<string>("");
    const [idProveedor, setIdProveedor] = useState<string>("");

    const [nombre, setNombre] = useState("");
    const [precioVenta, setPrecioVenta] = useState("");
    const [stockMinimo, setStockMinimo] = useState("");
    const [unidadMedida, setUnidadMedida] = useState("");

    const [cantidadPedidoEsperada, setCantidadPedidoEsperada] = useState("");
    // VR-04: stock suelto fuera de lote (vacío = el producto no lo usa; puede ser negativo).
    const [stockSuelto, setStockSuelto] = useState("");
    // Tipo de IVA propio. Vacío = hereda el del negocio, que es lo normal: en hostelería el
    // consumo en el local va todo al tipo reducido. Se rellena solo en lo que tributa distinto.
    const [ivaPercent, setIvaPercent] = useState("");

    const [image, setImage] = useState<File | null>(null);
    const [existingImageName, setExistingImageName] = useState<string | null>(null);
    const [existingImagePath, setExistingImagePath] = useState<string | null>(null);
    const [existingImageUrl, setExistingImageUrl] = useState<string>("");

    const [crearLoteInicial, setCrearLoteInicial] = useState(true);
    const [codigoLoteInicial, setCodigoLoteInicial] = useState("");
    const [caducidadLoteInicial, setCaducidadLoteInicial] = useState("");
    const [cantidadInicialLote, setCantidadInicialLote] = useState("");

    const [alergenosOpen, setAlergenosOpen] = useState(false);
    const [selectedAlergenos, setSelectedAlergenos] = useState<Set<string>>(new Set());
    const [alergenoImgUrl, setAlergenoImgUrl] = useState<Record<string, string>>({});

    const [loading, setLoading] = useState(false);
    const toast = useToast();

    const fileInputRef = useRef<HTMLInputElement | null>(null);
    const pickFile = () => fileInputRef.current?.click();

    const handleFile = (file: File | null) => {
        if (!file) return;
        if (!file.type.startsWith("image/")) {
            toast.info("Imagen", "Solo se permiten imágenes.");
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

    // Resuelve las URLs de imagen de alérgenos a partir de la lista cacheada.
    useEffect(() => {
        if (!open) return;

        let cancelled = false;

        (async () => {
            const urlMap: Record<string, string> = {};
            await Promise.all(
                (alergenos ?? []).map(async (a) => {
                    const id = toNum((a as any).ID_Alergeno, 0);
                    const url = await toImageUrlMaybe((a as any).Ruta_Imagen);
                    if (id > 0 && url) urlMap[id] = url;
                }),
            );
            if (cancelled) return;
            setAlergenoImgUrl(urlMap);
        })();

        return () => {
            cancelled = true;
        };
    }, [open, alergenos]);

    useEffect(() => {
        if (!open) return;

        let cancelled = false;

        setLoading(false);
        setImage(null);

        (async () => {
            if (!productIdToEdit) {
                setNombre("");
                setPrecioVenta("");
                setStockMinimo("");
                setUnidadMedida("");
                setCantidadPedidoEsperada("");

                setExistingImageName(null);
                setExistingImagePath(null);
                setExistingImageUrl("");

                setSelectedAlergenos(new Set());
                setAlergenosOpen(false);

                setCrearLoteInicial(true);
                setCodigoLoteInicial("");
                setCaducidadLoteInicial("");
                setCantidadInicialLote("");

                if (categoriaPreseleccionadaId) setIdCategoria(categoriaPreseleccionadaId);
                else setIdCategoria("");

                setIdProveedor("");
                return;
            }

            // Prefill on-demand del producto a editar (no se cachea: depende del id puntual).
            const detalle = await inventarioAPI.getProductoDetalle(productIdToEdit ?? "");
            if (cancelled) return;

            setIdCategoria(detalle.ID_Categoria);
            setIdProveedor(detalle.ID_Proveedor ?? "");
            setNombre(detalle.Nombre ?? "");
            setPrecioVenta(
                detalle.Precio_Venta != null ? String(detalle.Precio_Venta) : "",
            );
            setStockMinimo(
                detalle.Stock_Minimo != null ? String(detalle.Stock_Minimo) : "",
            );
            setUnidadMedida(detalle.Unidad_Medida ?? "");
            setCantidadPedidoEsperada(
                detalle.Cantidad_Pedido_Esperada != null
                    ? String(detalle.Cantidad_Pedido_Esperada)
                    : "",
            );
            setStockSuelto(
                detalle.Stock_Suelto != null ? String(detalle.Stock_Suelto) : "",
            );
            setIvaPercent(
                detalle.IVA_Percent != null ? String(detalle.IVA_Percent) : "",
            );

            setExistingImageName(detalle.Nombre_Imagen ?? null);
            setExistingImagePath(detalle.Ruta_Imagen ?? null);

            if (detalle.Ruta_Imagen) {
                setExistingImageUrl(await toImageUrlMaybe(detalle.Ruta_Imagen));
            } else {
                setExistingImageUrl("");
            }

            setImage(null);

            setSelectedAlergenos(
                new Set(
                    (detalle.alergs ?? [])
                        .map((a) => String((a as any).ID_Alergeno ?? "").trim())
                        .filter((x) => x.length > 0),
                ),
            );

            // Editando, el lote se añade sólo si se pide: el interruptor arranca apagado
            // para que guardar un cambio de nombre no exija rellenar un lote.
            setCrearLoteInicial(false);
            setCodigoLoteInicial("");
            setCaducidadLoteInicial("");
            setCantidadInicialLote("");

            setAlergenosOpen(false);
        })().catch((e) => {
            console.error("Error cargando modal producto:", e);
            toast.error("Error", "No se pudieron cargar los datos del producto.");
        });

        return () => {
            cancelled = true;
        };
    }, [open, categoriaPreseleccionadaId, productIdToEdit, toast]);

    const toggleAlergeno = (id: string, checked: boolean) => {
        setSelectedAlergenos((prev) => {
            const next = new Set(prev);
            if (checked) next.add(id);
            else next.delete(id);
            return next;
        });
    };

    const loteInicialOk = useMemo(() => {
        if (!crearLoteInicial) return true;
        if (!codigoLoteInicial.trim()) return false;
        const ci = Number(cantidadInicialLote.replace(",", "."));
        return Number.isFinite(ci) && ci >= 0;
    }, [crearLoteInicial, codigoLoteInicial, cantidadInicialLote]);

    const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
        e.preventDefault();

        if (!nombre.trim() || idCategoria === "") {
            toast.info("Validación", "Nombre y categoría son obligatorios.");
            return;
        }

        if (!loteInicialOk) {
            toast.info("Validación", "Revisa el lote (código y cantidad).");
            return;
        }

        setLoading(true);

        try {
            let nombreArchivo = existingImageName;
            let rutaParaBD = existingImagePath;
            // Ruta de la imagen anterior, para limpiarla del bucket tras un reemplazo.
            const rutaAnterior = isEdit ? existingImagePath : null;

            // La imagen se procesa (resize + JPEG) en Rust y se sube a R2 (bucket por tenant).
            // Funciona igual en Main y Handy: la subida la drena `images_drain_pending`.
            if (image) {
                const uuid = crypto.randomUUID();
                // Siempre .jpg: `save_image` recomprime a JPEG.
                nombreArchivo = `${uuid}.jpg`;

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

            const alergIds = Array.from(selectedAlergenos.values())
                .map((v) => String(v ?? "").trim())
                .filter((n) => n.length > 0);

            const finalProductId =
                (await upsertProducto.mutateAsync({
                    id_producto: isEdit ? (productIdToEdit ?? undefined) : undefined,
                    id_categoria: idCategoria,
                    // ID_Proveedor es un UUID string (no numérico): conservarlo como
                    // string. Convertirlo con Number() daba NaN para cualquier UUID y
                    // volvía a dejar el proveedor en null (el bug que H-01 pretendía cerrar).
                    id_proveedor: idProveedor !== "" ? idProveedor : null,
                    nombre: nombre.trim(),
                    precio_venta:
                        precioVenta.trim() === ""
                            ? null
                            : Number(precioVenta.replace(",", ".")),
                    stock_minimo:
                        stockMinimo.trim() === ""
                            ? null
                            : Number(stockMinimo.replace(",", ".")),
                    unidad_medida: unidadMedida.trim() ? unidadMedida.trim() : null,
                    nombre_imagen: nombreArchivo ?? null,
                    ruta_imagen: rutaParaBD ?? null,
                    cantidad_pedido_esperada:
                        cantidadPedidoEsperada.trim() === ""
                            ? null
                            : Number(cantidadPedidoEsperada.replace(",", ".")),
                    iva_percent:
                        ivaPercent.trim() === ""
                            ? null
                            : Number(ivaPercent.replace(",", ".")),
                    stock_suelto:
                        stockSuelto.trim() === ""
                            ? null
                            : Number(stockSuelto.replace(",", ".")),
                    ids_alergenos: alergIds,
                })) ?? (isEdit ? (productIdToEdit ?? null) : null);

            if (!finalProductId) {
                throw new Error("No se pudo obtener el ID del producto.");
            }

            // Si se subió una imagen nueva, drenar la cola hacia R2 y limpiar la anterior.
            if (image) {
                triggerImageUploadDrain();
                if (rutaAnterior && rutaAnterior !== rutaParaBD) {
                    void invoke("images_delete", {
                        args: { rel_path: rutaAnterior },
                    }).catch(() => {});
                }
            }

            if (crearLoteInicial) {
                const ci = Number(cantidadInicialLote.replace(",", "."));

                await createLote.mutateAsync({
                    id_producto: finalProductId,
                    codigo_lote: codigoLoteInicial.trim(),
                    caducidad: caducidadLoteInicial.trim() ? caducidadLoteInicial : null,
                    stock_disponible: ci,
                    coste_unitario: null,
                    fecha_entrada: null,
                    id_proveedor: null,
                    notas: null,
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
        <Modal
            open={open}
            onClose={onClose}
            title={isEdit ? "Editar producto" : "Añadir producto"}
            maxWidthClass="max-w-[980px]"
        >
            <div className="pr-1">
                <form onSubmit={handleSubmit} className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    <div className="md:col-span-2">
                        <label htmlFor="producto-nombre" className="block font-semibold">
                            Nombre *
                        </label>
                        <input
                            id="producto-nombre"
                            type="text"
                            value={nombre}
                            onChange={(e) => setNombre(e.target.value)}
                            className="border border-border rounded-xl px-3 py-2 w-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            required
                            disabled={loading}
                        />
                    </div>

                    <div>
                        <label htmlFor="producto-categoria" className="block font-semibold">
                            Categoría *
                        </label>
                        <select
                            id="producto-categoria"
                            value={idCategoria}
                            onChange={(e) =>
                                setIdCategoria(e.target.value || "")
                            }
                            className="border border-border rounded-xl px-3 py-2 w-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
                        <label htmlFor="producto-proveedor" className="block font-semibold">
                            Proveedor
                        </label>
                        <select
                            id="producto-proveedor"
                            value={idProveedor}
                            onChange={(e) =>
                                setIdProveedor(e.target.value || "")
                            }
                            className="border border-border rounded-xl px-3 py-2 w-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
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

                    <div>
                        <label htmlFor="producto-precio-venta" className="block font-semibold">
                            Precio venta
                        </label>
                        <input
                            id="producto-precio-venta"
                            type="number"
                            step="0.01"
                            value={precioVenta}
                            onChange={(e) => setPrecioVenta(e.target.value)}
                            className="border border-border rounded-xl px-3 py-2 w-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            disabled={loading}
                        />
                    </div>

                    <div>
                        <label htmlFor="producto-unidad-medida" className="block font-semibold">
                            Unidad de medida
                        </label>
                        <select
                            id="producto-unidad-medida"
                            value={unidadMedida}
                            onChange={(e) => setUnidadMedida(e.target.value)}
                            className="border border-border rounded-xl px-3 py-2 w-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            disabled={loading}
                        >
                            <option value="">Selecciona</option>

                            {unidadMedida.trim() !== "" &&
                                !(UNIDADES_MEDIDA as readonly string[]).includes(unidadMedida) && (
                                    <option value={unidadMedida}>Actual: {unidadMedida}</option>
                                )}

                            {UNIDADES_MEDIDA.map((u) => (
                                <option key={u} value={u}>
                                    {u}
                                </option>
                            ))}
                        </select>
                    </div>

                    <div>
                        <label htmlFor="producto-stock-minimo" className="block font-semibold">
                            Stock mínimo
                        </label>
                        <input
                            id="producto-stock-minimo"
                            type="number"
                            step="0.01"
                            value={stockMinimo}
                            onChange={(e) => setStockMinimo(e.target.value)}
                            className="border border-border rounded-xl px-3 py-2 w-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            disabled={loading}
                        />
                    </div>

                    <div>
                        <label
                            htmlFor="producto-cantidad-pedido"
                            className="block font-semibold"
                        >
                            Cantidad pedido esperada
                        </label>
                        <input
                            id="producto-cantidad-pedido"
                            type="number"
                            step="0.01"
                            value={cantidadPedidoEsperada}
                            onChange={(e) => setCantidadPedidoEsperada(e.target.value)}
                            className="border border-border rounded-xl px-3 py-2 w-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            disabled={loading}
                        />
                    </div>

                    <div>
                        <label
                            htmlFor="producto-stock-suelto"
                            className="block font-semibold"
                        >
                            Stock suelto (fuera de lote)
                        </label>
                        <input
                            id="producto-stock-suelto"
                            type="number"
                            step="0.01"
                            value={stockSuelto}
                            onChange={(e) => setStockSuelto(e.target.value)}
                            placeholder="Vacío = no se controla"
                            className="border border-border rounded-xl px-3 py-2 w-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            disabled={loading}
                        />
                        <p className="mt-1 text-xs text-fg-muted">
                            Stock simple sin lotes: se descuenta al vender lo que no cubran los lotes y
                            puede quedar negativo (aviso de que has vendido de más). Déjalo vacío si el
                            producto no lleva control de stock.
                        </p>
                    </div>

                    <div>
                        <label htmlFor="producto-iva" className="block font-semibold">
                            IVA (%)
                        </label>
                        <input
                            id="producto-iva"
                            type="number"
                            step="0.1"
                            min="0"
                            max="100"
                            value={ivaPercent}
                            onChange={(e) => setIvaPercent(e.target.value)}
                            placeholder="Vacío = el del negocio"
                            className="border border-border rounded-xl px-3 py-2 w-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            disabled={loading}
                        />
                        <p className="mt-1 text-xs text-fg-muted">
                            Déjalo vacío salvo que este producto tribute distinto al resto: lo que se
                            consume en el local va todo al mismo tipo. Se rellena para cosas como
                            productos envasados para llevar. El tipo que haya al vender queda guardado
                            en el ticket, así que cambiarlo no altera las ventas ya hechas.
                        </p>
                    </div>

                    <div className="md:col-span-2 rounded-2xl border border-border bg-surface-2 p-4">
                        <div className="flex items-center justify-between gap-3">
                            <div>
                                <p className="font-extrabold text-fg">
                                    {isEdit ? "Añadir lote" : "Lote inicial"}
                                </p>
                                <p className="text-sm text-fg-muted">
                                    {isEdit
                                        ? "Se crea un lote nuevo para este producto al guardar."
                                        : "Recomendado: así ya tienes stock y FEFO desde el primer día."}
                                </p>
                            </div>

                            <button
                                type="button"
                                disabled={loading}
                                onClick={() => setCrearLoteInicial((v) => !v)}
                                className={[
                                    "relative inline-flex h-8 w-14 items-center rounded-full transition",
                                    crearLoteInicial ? "bg-accent" : "bg-negro/20",
                                    loading ? "opacity-60" : "",
                                ].join(" ")}
                                aria-pressed={crearLoteInicial}
                            >
                                <span
                                    className={[
                                        "inline-block h-7 w-7 transform rounded-full bg-surface shadow transition",
                                        crearLoteInicial ? "translate-x-6" : "translate-x-1",
                                    ].join(" ")}
                                />
                            </button>
                        </div>

                        {crearLoteInicial && (
                            <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mt-4">
                                <div>
                                    <label
                                        htmlFor="producto-lote-codigo"
                                        className="block text-sm font-semibold"
                                    >
                                        Código lote *
                                    </label>
                                    <input
                                        id="producto-lote-codigo"
                                        value={codigoLoteInicial}
                                        onChange={(e) => setCodigoLoteInicial(e.target.value)}
                                        className="border border-border rounded-xl px-3 py-2 w-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                        disabled={loading}
                                        required
                                    />
                                </div>

                                <div>
                                    <label
                                        htmlFor="producto-lote-caducidad"
                                        className="block text-sm font-semibold"
                                    >
                                        Caducidad
                                    </label>
                                    <input
                                        id="producto-lote-caducidad"
                                        type="date"
                                        value={caducidadLoteInicial}
                                        onChange={(e) => setCaducidadLoteInicial(e.target.value)}
                                        className="border border-border rounded-xl px-3 py-2 w-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                        disabled={loading}
                                    />
                                </div>

                                <div>
                                    <label
                                        htmlFor="producto-lote-cantidad"
                                        className="block text-sm font-semibold"
                                    >
                                        Cantidad *
                                    </label>
                                    <input
                                        id="producto-lote-cantidad"
                                        type="number"
                                        step="0.01"
                                        value={cantidadInicialLote}
                                        onChange={(e) => setCantidadInicialLote(e.target.value)}
                                        className="border border-border rounded-xl px-3 py-2 w-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                        disabled={loading}
                                        required
                                    />
                                </div>

                                {!loteInicialOk && (
                                    <p className="md:col-span-3 text-xs text-danger font-semibold">
                                        Revisa el código y la cantidad del lote.
                                    </p>
                                )}
                            </div>
                        )}
                    </div>

                    <div className="md:col-span-2">
                        <button
                            type="button"
                            onClick={() => setAlergenosOpen((v) => !v)}
                            disabled={loading}
                            className="w-full border border-border rounded-2xl py-3 font-bold hover:bg-surface-2 transition flex items-center justify-between px-4"
                        >
                            <span>Alérgenos</span>
                            <span className="text-fg-muted text-sm font-semibold">
                                {selectedAlergenos.size
                                    ? `${selectedAlergenos.size} seleccionados`
                                    : "—"}
                            </span>
                        </button>

                        <div
                            className={[
                                "overflow-hidden transition-all duration-300",
                                alergenosOpen
                                    ? "max-h-[520px] opacity-100 mt-3"
                                    : "max-h-0 opacity-0 mt-0",
                            ].join(" ")}
                        >
                            <div className="rounded-2xl border border-border bg-surface-2 p-4">
                                {!alergenos.length ? (
                                    <p className="text-sm text-fg-muted">
                                        No hay alérgenos configurados.
                                    </p>
                                ) : (
                                    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
                                        {alergenos.map((a: any) => {
                                            const id = String(a.ID_Alergeno ?? "").trim();
                                            const checked = selectedAlergenos.has(id);
                                            const imgUrl = alergenoImgUrl[id] ?? "";

                                            return (
                                                <label
                                                    key={id}
                                                    className={[
                                                        "cursor-pointer select-none rounded-2xl border p-3 flex items-center gap-3 transition",
                                                        checked
                                                            ? "border-accent bg-accent/10"
                                                            : "border-border bg-surface",
                                                    ].join(" ")}
                                                >
                                                    <button
                                                        type="button"
                                                        disabled={loading}
                                                        onClick={() => toggleAlergeno(id, !checked)}
                                                        className={[
                                                            "relative inline-flex h-7 w-12 items-center rounded-full transition",
                                                            checked ? "bg-accent" : "bg-negro/20",
                                                            loading ? "opacity-60" : "",
                                                        ].join(" ")}
                                                        aria-pressed={checked}
                                                        aria-label={`Alergeno ${a.Nombre}`}
                                                    >
                                                        <span
                                                            className={[
                                                                "inline-block h-6 w-6 transform rounded-full bg-surface shadow transition",
                                                                checked
                                                                    ? "translate-x-5.5"
                                                                    : "translate-x-0.5",
                                                            ].join(" ")}
                                                        />
                                                    </button>

                                                    <div className="w-9 h-9 rounded-xl border border-border bg-surface-2 overflow-hidden flex items-center justify-center shrink-0">
                                                        {imgUrl ? (
                                                            <img
                                                                src={imgUrl}
                                                                alt={a.Nombre}
                                                                className="w-full h-full object-cover"
                                                                draggable={false}
                                                            />
                                                        ) : (
                                                            <span className="text-[10px] text-fg-subtle font-semibold">
                                                                IMG
                                                            </span>
                                                        )}
                                                    </div>

                                                    <div className="min-w-0">
                                                        <p className="text-sm font-semibold text-fg truncate">
                                                            {a.Nombre}
                                                        </p>
                                                    </div>
                                                </label>
                                            );
                                        })}
                                    </div>
                                )}
                            </div>
                        </div>
                    </div>

                    <div className="md:col-span-2 flex flex-col gap-2">
                        <label htmlFor="producto-imagen" className="font-semibold text-fg">
                            Imagen <span className="text-fg-muted font-medium">(opcional)</span>
                        </label>

                        <input
                            id="producto-imagen"
                            ref={fileInputRef}
                            type="file"
                            accept="image/*"
                            className="hidden"
                            onChange={(e) => handleFile(e.target.files?.[0] ?? null)}
                            disabled={loading}
                        />

                        {isEdit && existingImageUrl && !image && (
                            <div className="flex items-center gap-3 rounded-2xl border border-border bg-surface-2 p-3">
                                <div className="w-20 h-20 rounded-2xl overflow-hidden border border-border bg-surface-2 shrink-0">
                                    <img
                                        src={existingImageUrl}
                                        alt="Imagen actual"
                                        className="w-full h-full object-cover"
                                        draggable={false}
                                    />
                                </div>

                                <div className="flex-1 min-w-0">
                                    <p className="text-sm font-bold text-fg">Imagen actual</p>
                                    <p className="text-xs text-fg-muted break-words">
                                        {existingImageName ?? ""}
                                    </p>

                                    <button
                                        type="button"
                                        onClick={pickFile}
                                        disabled={loading}
                                        className="mt-2 inline-flex items-center justify-center px-4 py-2 rounded-xl bg-accent text-white font-bold hover:opacity-90 transition disabled:opacity-60"
                                    >
                                        Elegir archivo
                                    </button>
                                </div>
                            </div>
                        )}

                        {(!isEdit || image || !existingImageUrl) && (
                            <div
                                onClick={() => !loading && pickFile()}
                                onDragOver={(e) => e.preventDefault()}
                                onDrop={handleDrop}
                                className="cursor-pointer rounded-2xl border-2 border-dashed p-4 transition border-accent/60 hover:border-accent"
                            >
                                {!image ? (
                                    <div className="flex flex-col sm:flex-row items-center justify-between gap-3">
                                        <div className="flex items-center gap-3">
                                            <div className="w-11 h-11 rounded-2xl border border-border bg-surface-2 flex items-center justify-center">
                                                <svg
                                                    className="w-6 h-6 text-fg-muted"
                                                    xmlns="http://www.w3.org/2000/svg"
                                                    fill="none"
                                                    viewBox="0 0 24 24"
                                                    stroke="currentColor"
                                                    strokeWidth={2}
                                                >
                                                    <path
                                                        strokeLinecap="round"
                                                        strokeLinejoin="round"
                                                        d="M12 16v-8m0 0l-3 3m3-3l3 3"
                                                    />
                                                    <path
                                                        strokeLinecap="round"
                                                        strokeLinejoin="round"
                                                        d="M20 16.5a4.5 4.5 0 00-1.3-3.2A4.5 4.5 0 0015.5 12H15a6 6 0 10-12 0h-.5A4.5 4.5 0 002 16.5 4.5 4.5 0 006.5 21h11A4.5 4.5 0 0020 16.5z"
                                                    />
                                                </svg>
                                            </div>
                                            <div>
                                                <p className="font-bold text-fg">Sube una imagen</p>
                                                <p className="text-sm text-fg-muted">
                                                    Click o arrastra y suelta (PNG/JPG).
                                                </p>
                                            </div>
                                        </div>

                                        <div className="w-full sm:w-auto text-center px-4 py-2 rounded-xl bg-accent text-white font-bold">
                                            Elegir archivo
                                        </div>
                                    </div>
                                ) : (
                                    <div className="flex flex-col sm:flex-row gap-4 items-center">
                                        <div className="w-full sm:w-[200px] aspect-[4/3] rounded-2xl overflow-hidden border border-border bg-surface-2">
                                            <img
                                                src={previewUrl}
                                                alt="preview"
                                                className="w-full h-full object-cover"
                                            />
                                        </div>

                                        <div className="flex-1 w-full">
                                            <p className="font-bold text-fg break-words">
                                                {image.name}
                                            </p>
                                            <p className="text-sm text-fg-muted">
                                                {(image.size / 1024 / 1024).toFixed(2)} MB
                                            </p>

                                            <div className="grid grid-cols-2 gap-2 mt-3">
                                                <button
                                                    type="button"
                                                    onClick={pickFile}
                                                    disabled={loading}
                                                    className="border border-border rounded-xl py-2 font-semibold hover:bg-surface-2 transition"
                                                >
                                                    Cambiar
                                                </button>
                                                <button
                                                    type="button"
                                                    onClick={() => setImage(null)}
                                                    disabled={loading}
                                                    className="border border-danger text-danger rounded-xl py-2 font-semibold hover:bg-danger hover:text-white transition"
                                                >
                                                    Quitar
                                                </button>
                                            </div>
                                        </div>
                                    </div>
                                )}
                            </div>
                        )}
                    </div>

                    <button
                        type="submit"
                        disabled={loading}
                        className="md:col-span-2 bg-accent text-white py-2 rounded-xl font-extrabold mt-2"
                    >
                        {loading ? "Guardando..." : isEdit ? "Guardar cambios" : "Guardar producto"}
                    </button>
                </form>
            </div>
        </Modal>
    );
}
