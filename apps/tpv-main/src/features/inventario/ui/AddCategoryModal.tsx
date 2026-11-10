import { guardarImagen } from "../../../shared/lib/guardarImagen";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { toAppError } from "@tpv/client";
import Modal from "./Modal";
import { useToast } from "../../../shared/toast";

import { useCreateCategoria } from "../inventarioQueries";
import { triggerImageUploadDrain } from "../../../shared/lib/imageUrl";
import { conAviso } from "../../../shared/lib/conAviso";

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

            // La imagen se procesa (redimensionado conservando el formato) en Rust y se sube a R2 (Main y Handy).
            if (image) {
                const guardada = await guardarImagen(image, "categorias");
                nombreArchivo = guardada.nombre;
                rutaParaBD = guardada.ruta;
            }

            await createCategoria.mutateAsync({
                nombre: name.trim(),
                nombre_imagen: nombreArchivo,
                ruta_imagen: rutaParaBD,
                vendible: !!vendible,
                pasa_cocina: !!pasaCocina,
            });

            if (image) triggerImageUploadDrain();

            await onSaved();
            onClose();
        } catch (err) {
            toast.error("No se pudo guardar la categoría", toAppError(err).message);
        } finally {
            setLoading(false);
        }
    };

    return (
        <Modal open={open} onClose={handleClose} title="Añadir categoría">
            <form onSubmit={conAviso(handleSubmit)} className="flex flex-col gap-4">
                <div className="flex flex-col gap-1.5">
                    <label className="font-semibold text-fg">
                        Nombre <span className="text-danger">*</span>
                    </label>
                    <input
                        type="text"
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        onBlur={() => setTouched(true)}
                        disabled={loading}
                        placeholder="Ej: Bebidas, Cocina, Postres..."
                        className={`border rounded-xl px-3 py-2 outline-none transition ${nameError
                                ? "border-danger"
                                : "border-border focus:border-accent"
                            }`}
                    />
                    {nameError && <p className="text-sm text-danger">{nameError}</p>}
                </div>

                <div className="rounded-2xl border border-border bg-surface p-3">
                    <p className="font-bold text-fg mb-2">Opciones de la categoría</p>

                    <div className="flex flex-col gap-2">
                        <label
                            className={cn(
                                "flex items-start justify-between gap-4 rounded-2xl border p-3 transition select-none",
                                "border-border bg-surface hover:bg-surface-2",
                                loading && "opacity-60 cursor-not-allowed",
                                !loading && "cursor-pointer",
                            )}
                        >
                            <div className="leading-tight">
                                <p className="font-semibold text-fg">¿Esta categoría es vendible?</p>
                                <p className="text-sm text-fg-muted">
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
                                        "border-border bg-surface-3 peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-ring",
                                        "peer-checked:bg-accent peer-checked:border-accent/60",
                                    )}
                                />
                                <span
                                    className={cn(
                                        "absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-surface shadow-sm transition",
                                        "translate-x-0 peer-checked:translate-x-5",
                                    )}
                                />
                            </span>
                        </label>

                        <label
                            className={cn(
                                "flex items-start justify-between gap-4 rounded-2xl border p-3 transition select-none",
                                "border-border bg-surface hover:bg-surface-2",
                                loading && "opacity-60 cursor-not-allowed",
                                !loading && "cursor-pointer",
                            )}
                        >
                            <div className="leading-tight">
                                <p className="font-semibold text-fg">¿Esta categoría pasa a cocina?</p>
                                <p className="text-sm text-fg-muted">
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
                                        "border-border bg-surface-3 peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-ring",
                                        "peer-checked:bg-accent peer-checked:border-accent/60",
                                    )}
                                />
                                <span
                                    className={cn(
                                        "absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-surface shadow-sm transition",
                                        "translate-x-0 peer-checked:translate-x-5",
                                    )}
                                />
                            </span>
                        </label>
                    </div>
                </div>

                <div className="flex flex-col gap-2">
                    <label className="font-semibold text-fg">
                        Imagen <span className="text-fg-subtle text-sm">(opcional)</span>
                    </label>

                    <input
                        ref={fileInputRef}
                        type="file"
                        accept="image/jpeg,image/png,.jpg,.jpeg,.png"
                        className="hidden"
                        onChange={(e) => handleFile(e.target.files?.[0] ?? null)}
                        disabled={loading}
                    />

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
                                            <path strokeLinecap="round" strokeLinejoin="round" d="M12 16v-8m0 0l-3 3m3-3l3 3" />
                                            <path
                                                strokeLinecap="round"
                                                strokeLinejoin="round"
                                                d="M20 16.5a4.5 4.5 0 00-1.3-3.2A4.5 4.5 0 0015.5 12H15a6 6 0 10-12 0h-.5A4.5 4.5 0 002 16.5 4.5 4.5 0 006.5 21h11A4.5 4.5 0 0020 16.5z"
                                            />
                                        </svg>
                                    </div>
                                    <div>
                                        <p className="font-bold text-fg">Sube una imagen</p>
                                        <p className="text-sm text-fg-muted">Click o arrastra y suelta (PNG/JPG).</p>
                                    </div>
                                </div>

                                <div className="w-full sm:w-auto text-center px-4 py-2 rounded-xl bg-accent text-white font-bold">
                                    Elegir archivo
                                </div>
                            </div>
                        ) : (
                            <div className="flex flex-col sm:flex-row gap-4 items-center">
                                <div className="w-full sm:w-[200px] aspect-[4/3] rounded-2xl overflow-hidden border border-border bg-surface-2">
                                    <img src={previewUrl} alt="preview" className="w-full h-full object-cover" />
                                </div>

                                <div className="flex-1 w-full">
                                    <p className="font-bold text-fg break-words">{image.name}</p>
                                    <p className="text-sm text-fg-muted">{(image.size / 1024 / 1024).toFixed(2)} MB</p>

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
                                            className="border border-danger text-danger rounded-xl py-2 font-semibold hover:bg-danger hover:text-danger-fg transition"
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
                        className="w-full px-4 py-2 rounded-xl border border-border hover:bg-surface-2 transition font-semibold"
                    >
                        Cancelar
                    </button>

                    <button
                        type="submit"
                        disabled={loading}
                        className={`w-full cursor-pointer rounded-xl px-4 py-2 font-extrabold shadow-sm transition ${loading
                                ? "cursor-not-allowed bg-surface-2 text-fg-subtle"
                                : "bg-accent text-accent-fg hover:bg-accent-hover"
                            }`}
                    >
                        {loading ? "Guardando..." : "Guardar categoría"}
                    </button>
                </div>
            </form>
        </Modal>
    );
}