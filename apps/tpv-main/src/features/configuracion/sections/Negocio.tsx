import { guardarImagen } from "../../../shared/lib/guardarImagen";
// src/features/configuracion/sections/Negocio.tsx
import React, { useEffect, useRef, useState } from "react";

import { Panel } from "../ui/Panel";
import { Field } from "../ui/Field";
import { TextInput } from "../ui/Inputs";
import { GhostButton, PrimaryButton } from "../ui/Buttons";
import { cn } from "../utils";
import type { BusinessDraft } from "../types";
import {
    resolveImageUrl,
    triggerImageUploadDrain,
} from "../../../shared/lib/imageUrl";
import { useToast } from "../../../shared/toast";
import { conAviso } from "../../../shared/lib/conAviso";

export function Negocio({
    darkMode,
    inputTone,
    bizHydrated,
    draft,
    setDraft,
    dirty,
    saving,
    onSave,
    onReset,
}: {
    darkMode: boolean;
    inputTone: string;
    bizHydrated: boolean;
    draft: BusinessDraft;
    setDraft: React.Dispatch<React.SetStateAction<BusinessDraft>>;
    dirty: boolean;
    saving: boolean;
    onSave: () => Promise<void>;
    onReset: () => void;
}) {
    const fileInputRef = useRef<HTMLInputElement | null>(null);
    const toast = useToast();
    const [uploadingLogo, setUploadingLogo] = useState(false);

    // `draft.logo_data_url` puede ser una ruta relativa (`images/logo/…`, nuevo canal R2) o un
    // data URL heredado; `resolveImageUrl` maneja ambos y devuelve una URL para el <img>.
    const [logoSrc, setLogoSrc] = useState<string>("");
    useEffect(() => {
        let alive = true;
        resolveImageUrl(draft.logo_data_url)
            .then((u) => {
                if (alive) setLogoSrc(u);
            })
            .catch(() => {
                if (alive) setLogoSrc("");
            });
        return () => {
            alive = false;
        };
    }, [draft.logo_data_url]);

    const onPickLogo = () => fileInputRef.current?.click();

    // Sube el logo por el MISMO canal que las imágenes de producto (disco local + cola R2), y
    // guarda en el draft sólo la ruta relativa (`images/logo/{uuid}.jpg`). Así el logo ya no
    // viaja como base64 embebido en la sentencia replicada (CONF-02): sólo una ruta corta.
    const onLogoFile = async (f?: File | null) => {
        if (!f) return;
        setUploadingLogo(true);
        try {
            const guardada = await guardarImagen(f, "logo");
            setDraft((d) => ({ ...d, logo_data_url: guardada.ruta }));
            triggerImageUploadDrain();
        } catch (e) {
            console.error("save_image (logo) error:", e);
            toast.error(
                "Logo",
                e instanceof Error ? e.message : typeof e === "string" ? e : "No se pudo subir el logo.",
            );
        } finally {
            setUploadingLogo(false);
        }
    };

    return (
        <div className="flex flex-col gap-4">
            <Panel
                title="Logo"
                subtitle="Se mostrará en el ticket (si lo tienes activado)."
                right={
                    <div className="flex items-center gap-2">
                        <GhostButton
                            onClick={onPickLogo}
                            disabled={!bizHydrated || uploadingLogo}
                        >
                            {uploadingLogo ? "Subiendo…" : "Subir logo"}
                        </GhostButton>
                        <GhostButton
                            onClick={() =>
                                setDraft((d) => ({ ...d, logo_data_url: null }))
                            }
                            disabled={!bizHydrated}
                        >
                            Quitar
                        </GhostButton>

                        <input
                            ref={fileInputRef}
                            type="file"
                            accept="image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp"
                            className="hidden"
                            onChange={conAviso((e) => onLogoFile(e.target.files?.[0]))}
                        />
                    </div>
                }
            >
                <div
                    className={cn(
                        "rounded-2xl border p-4 flex items-center gap-4",
                        darkMode
                            ? "border-border bg-surface-2"
                            : "border-border bg-surface",
                    )}
                >
                    <div
                        className={cn(
                            "h-16 w-16 rounded-2xl border overflow-hidden grid place-items-center shrink-0",
                            darkMode
                                ? "border-border bg-surface-2"
                                : "border-border bg-surface",
                        )}
                    >
                        {draft.logo_data_url && logoSrc ? (
                            <img
                                src={logoSrc}
                                alt="logo"
                                className="h-full w-full object-cover"
                            />
                        ) : (
                            <span
                                className={cn(
                                    "text-xs font-semibold",
                                    darkMode
                                        ? "text-fg-muted"
                                        : "text-fg-muted",
                                )}
                            >
                                LOGO
                            </span>
                        )}
                    </div>

                    <div className="min-w-0">
                        <div
                            className={cn(
                                "text-sm font-bold truncate",
                                darkMode ? "text-white" : "text-fg",
                            )}
                        >
                            {draft.business_name || "TPV"}
                        </div>
                        <div
                            className={cn(
                                "text-xs mt-0.5",
                                darkMode ? "text-fg-muted" : "text-fg-muted",
                            )}
                        >
                            Cambios del logo se guardan al pulsar “Guardar
                            cambios”.
                        </div>
                    </div>
                </div>
            </Panel>

            <Panel
                title="Datos del negocio"
                subtitle="Estos datos se imprimen en el ticket según tus preferencias."
            >
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <Field label="Nombre">
                        <TextInput
                            value={draft.business_name}
                            onChange={(e) =>
                                setDraft((d) => ({
                                    ...d,
                                    business_name: e.target.value,
                                }))
                            }
                            placeholder="Ej: Bar La Plaza"
                            className={inputTone}
                        />
                    </Field>

                    <Field label="Teléfono" hint="Opcional">
                        <TextInput
                            value={draft.telefono}
                            onChange={(e) =>
                                setDraft((d) => ({
                                    ...d,
                                    telefono: e.target.value,
                                }))
                            }
                            placeholder="+34 600 000 000"
                            className={inputTone}
                        />
                    </Field>

                    {/* NO es opcional, y es la MISMA columna (`Business_Settings.CIF`) que edita
                        Configuración → Fiscal diciendo «sin esto no se puede cobrar». Dos pantallas
                        sobre el mismo dato diciendo lo contrario es peor que una sola mal puesta:
                        quien lee ésta se queda tranquilo. El sitio para rellenarlo con su contexto
                        —y con la validación del NIF— es Fiscal; aquí sólo se dice dónde. */}
                    <Field label="CIF" hint="Se configura en Fiscal">
                        <TextInput
                            value={draft.cif}
                            onChange={(e) =>
                                setDraft((d) => ({ ...d, cif: e.target.value }))
                            }
                            placeholder="B12345678"
                            className={inputTone}
                        />
                    </Field>

                    <Field label="Dirección" hint="Opcional">
                        <TextInput
                            value={draft.direccion}
                            onChange={(e) =>
                                setDraft((d) => ({
                                    ...d,
                                    direccion: e.target.value,
                                }))
                            }
                            placeholder="C/ Ejemplo 12, 46000 Valencia"
                            className={inputTone}
                        />
                    </Field>
                </div>

                {/* `justify-end` y no `justify-between`: al quitar el texto de la izquierda, un
                    `between` con un solo hijo lo empujaría al principio de la fila. */}
                <div className="mt-4 flex items-center justify-end gap-2">
                    <div className="flex items-center gap-2">
                        <GhostButton
                            onClick={onReset}
                            disabled={!dirty || saving}
                        >
                            Descartar
                        </GhostButton>
                        <PrimaryButton
                            onClick={conAviso(onSave)}
                            disabled={!dirty || saving || !bizHydrated}
                        >
                            {saving ? "Guardando…" : "Guardar cambios"}
                        </PrimaryButton>
                    </div>
                </div>
            </Panel>
        </div>
    );
}
