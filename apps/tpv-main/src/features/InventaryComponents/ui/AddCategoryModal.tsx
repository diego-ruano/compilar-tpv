import React, { useEffect, useMemo, useRef, useState } from "react";
import Modal from "./Modal";
import { useToast } from "../../../shared/toast";
import { invoke } from "@tauri-apps/api/core";
import { convertirABase64 } from "../utils/inventarioFormat";
import { useCreateCategoria } from "../inventarioQueries";

function cn(...classes: Array<string | false | undefined | null>) {
    return classes.filter(Boolean).join(" ");
}

export default function AddCategoryModal({
    open,
    onClose,
    onSaved,
}: {
    open: boolean;
    onClose: () => void;
    onSaved: () => void | Promise<void>;
}) {
    const [name, setName] = useState("");
    const [image, setImage] = useState<File | null>(null);

    const [vendible, setVendible] = useState(true);
    const [pasaCocina, setPasaCocina] = useState(false);

    const [loading, setLoading] = useState(false);
    const [touched, setTouched] = useState(false);
    const toast = useToast();
    const fileInputRef = useRef<HTMLInputElement | null>(null);

    const createCategoria = useCreateCategoria();

    const nameError = useMemo(() => {
        if (!touched) return "";
        if (!name.trim()) return "El nombre es obligatorio.";
        if (name.trim().length < 2) return "Mínimo 2 caracteres.";
        return "";
    }, [name, touched]);

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

        setName("");
        setImage(null);
        setVendible(true);
        setPasaCocina(false);
        setLoading(false);
        setTouched(false);
    }, [open]);

    const pickFile = () => fileInputRef.current?.click();

    const handleClose = () => {
        if (loading) return;
        onClose();
    };

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

    const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
        e.preventDefault();
        setTouched(true);
        if (nameError) return;

        setLoading(true);
        try {
            let nombreArchivo = "";
            let rutaParaBD = "";

            if (image) {
                const uuid = crypto.randomUUID();
                const extension = image.name.split(".").pop() || "png";
                nombreArchivo = `${uuid}.${extension}`;

                const subcarpeta = "categorias";
                rutaParaBD = `images/${subcarpeta}/${nombreArchivo}`;

                const base64String = await convertirABase64(image);
                const base64Data = base64String.split(",")[1];

                await invoke("save_image", {
                    subfolder: subcarpeta,
                    filename: nombreArchivo,
                    base64Data,
                });
            }

            await createCategoria.mutateAsync({
                nombre: name.trim(),
                nombre_imagen: nombreArchivo,
                ruta_imagen: rutaParaBD,
                vendible: !!vendible,
                pasa_cocina: !!pasaCocina,
            });

            await onSaved();
            onClose();
        } catch (err) {
            console.error("Error guardando categoría:", err);
            toast.error("Error", "Hubo un error al guardar la categoría.");
        } finally {
            setLoading(false);
        }
    };

    return (
        <Modal open={open} onClose={handleClose} title="Añadir categoría">
            <form onSubmit={handleSubmit} className="flex flex-col gap-4">
                <div className="flex flex-col gap-1.5">
                    <label className="font-semibold text-negro">
                        Nombre <span className="text-rojo">*</span>
                    </label>
                    <input
                        type="text"
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        onBlur={() => setTouched(true)}
                        disabled={loading}
                        placeholder="Ej: Bebidas, Cocina, Postres..."
                        className={`border rounded-xl px-3 py-2 outline-none transition ${nameError
                                ? "border-rojo"
                                : "border-negro/20 focus:border-verde"
                            }`}
                    />
                    {nameError && <p className="text-sm text-rojo">{nameError}</p>}
                </div>

                <div className="rounded-2xl border border-negro/10 bg-white p-3">
                    <p className="font-bold text-negro mb-2">Opciones de la categoría</p>

                    <div className="flex flex-col gap-2">
                        <label
                            className={cn(
                                "flex items-start justify-between gap-4 rounded-2xl border p-3 transition select-none",
                                "border-negro/10 bg-white hover:bg-black/[0.02]",
                                loading && "opacity-60 cursor-not-allowed",
                                !loading && "cursor-pointer",
                            )}
                        >
                            <div className="leading-tight">
                                <p className="font-semibold text-negro">¿Esta categoría es vendible?</p>
                                <p className="text-sm text-negro/60">
                                    Si está desactivado, no aparecerá en la pantalla de venta.
                                </p>
                            </div>

                            <span className="relative mt-1">
                                <input
                                    type="checkbox"
                                    checked={vendible}
                                    onChange={(e) => setVendible(e.target.checked)}
                                    disabled={loading}
                                    className="peer sr-only"
                                />
                                <span
                                    className={cn(
                                        "block h-6 w-11 rounded-full border transition",
                                        "border-black/10 bg-black/10 peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-black/10",
                                        "peer-checked:bg-verde peer-checked:border-verde/60",
                                    )}
                                />
                                <span
                                    className={cn(
                                        "absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white shadow-sm transition",
                                        "translate-x-0 peer-checked:translate-x-5",
                                    )}
                                />
                            </span>
                        </label>

                        <label
                            className={cn(
                                "flex items-start justify-between gap-4 rounded-2xl border p-3 transition select-none",
                                "border-negro/10 bg-white hover:bg-black/[0.02]",
                                loading && "opacity-60 cursor-not-allowed",
                                !loading && "cursor-pointer",
                            )}
                        >
                            <div className="leading-tight">
                                <p className="font-semibold text-negro">¿Esta categoría pasa a cocina?</p>
                                <p className="text-sm text-negro/60">
                                    Si está activado, sus productos se enviarán a cocina en la comanda.
                                </p>
                            </div>

                            <span className="relative mt-1">
                                <input
                                    type="checkbox"
                                    checked={pasaCocina}
                                    onChange={(e) => setPasaCocina(e.target.checked)}
                                    disabled={loading}
                                    className="peer sr-only"
                                />
                                <span
                                    className={cn(
                                        "block h-6 w-11 rounded-full border transition",
                                        "border-black/10 bg-black/10 peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-black/10",
                                        "peer-checked:bg-verde peer-checked:border-verde/60",
                                    )}
                                />
                                <span
                                    className={cn(
                                        "absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white shadow-sm transition",
                                        "translate-x-0 peer-checked:translate-x-5",
                                    )}
                                />
                            </span>
                        </label>
                    </div>
                </div>

                <div className="flex flex-col gap-2">
                    <label className="font-semibold text-negro">
                        Imagen <span className="text-negro/50 text-sm">(opcional)</span>
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
                        className="cursor-pointer rounded-2xl border-2 border-dashed p-4 transition border-verde/60 hover:border-verde"
                    >
                        {!image ? (
                            <div className="flex flex-col sm:flex-row items-center justify-between gap-3">
                                <div className="flex items-center gap-3">
                                    <div className="w-11 h-11 rounded-2xl border border-negro/10 bg-gris flex items-center justify-center">
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
                                        <p className="font-bold text-negro">Sube una imagen</p>
                                        <p className="text-sm text-negro/60">Click o arrastra y suelta (PNG/JPG).</p>
                                    </div>
                                </div>

                                <div className="w-full sm:w-auto text-center px-4 py-2 rounded-xl bg-verde text-white font-bold">
                                    Elegir archivo
                                </div>
                            </div>
                        ) : (
                            <div className="flex flex-col sm:flex-row gap-4 items-center">
                                <div className="w-full sm:w-[200px] aspect-[4/3] rounded-2xl overflow-hidden border border-negro/10 bg-gris">
                                    <img src={previewUrl} alt="preview" className="w-full h-full object-cover" />
                                </div>

                                <div className="flex-1 w-full">
                                    <p className="font-bold text-negro break-words">{image.name}</p>
                                    <p className="text-sm text-negro/60">{(image.size / 1024 / 1024).toFixed(2)} MB</p>

                                    <div className="grid grid-cols-2 gap-2 mt-3">
                                        <button
                                            type="button"
                                            onClick={pickFile}
                                            disabled={loading}
                                            className="border border-negro/20 rounded-xl py-2 font-semibold hover:bg-gris transition"
                                        >
                                            Cambiar
                                        </button>
                                        <button
                                            type="button"
                                            onClick={() => setImage(null)}
                                            disabled={loading}
                                            className="border border-rojo text-rojo rounded-xl py-2 font-semibold hover:bg-rojo hover:text-white transition"
                                        >
                                            Quitar
                                        </button>
                                    </div>
                                </div>
                            </div>
                        )}
                    </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mt-1">
                    <button
                        type="button"
                        onClick={handleClose}
                        disabled={loading}
                        className="w-full px-4 py-2 rounded-xl border border-negro/20 hover:bg-gris transition font-semibold"
                    >
                        Cancelar
                    </button>

                    <button
                        type="submit"
                        disabled={loading}
                        className={`w-full px-4 py-2 rounded-xl font-extrabold transition ${loading
                                ? "bg-gray-400 cursor-not-allowed text-white"
                                : "bg-verde text-white hover:opacity-90"
                            }`}
                    >
                        {loading ? "Guardando..." : "Guardar categoría"}
                    </button>
                </div>
            </form>
        </Modal>
    );
}