// src/features/configuracion/sections/Negocio.tsx
import React, { useRef } from "react";
import { Panel } from "../ui/Panel";
import { Field } from "../ui/Field";
import { TextInput } from "../ui/Inputs";
import { GhostButton, PrimaryButton } from "../ui/Buttons";
import { cn } from "../utils";
import type { BusinessDraft } from "../types";

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

    const onPickLogo = () => fileInputRef.current?.click();

    const onLogoFile = (f?: File | null) => {
        if (!f) return;
        const reader = new FileReader();
        reader.onload = () => {
            const res = reader.result;
            if (typeof res === "string")
                setDraft((d) => ({ ...d, logoDataUrl: res }));
        };
        reader.readAsDataURL(f);
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
                            disabled={!bizHydrated}
                        >
                            Subir logo
                        </GhostButton>
                        <GhostButton
                            onClick={() =>
                                setDraft((d) => ({ ...d, logoDataUrl: null }))
                            }
                            disabled={!bizHydrated}
                        >
                            Quitar
                        </GhostButton>

                        <input
                            ref={fileInputRef}
                            type="file"
                            accept="image/*"
                            className="hidden"
                            onChange={(e) => onLogoFile(e.target.files?.[0])}
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
                        {draft.logoDataUrl ? (
                            <img
                                src={draft.logoDataUrl}
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
                            {draft.businessName || "TPV"}
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
                            value={draft.businessName}
                            onChange={(e) =>
                                setDraft((d) => ({
                                    ...d,
                                    businessName: e.target.value,
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

                    <Field label="CIF" hint="Opcional">
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

                <div className="mt-4 flex items-center justify-between gap-2">
                    <div className="text-xs text-fg-muted">
                        {bizHydrated
                            ? "Persistencia en DB local (SQLite)"
                            : "Cargando configuración..."}
                    </div>

                    <div className="flex items-center gap-2">
                        <GhostButton
                            onClick={onReset}
                            disabled={!dirty || saving}
                        >
                            Descartar
                        </GhostButton>
                        <PrimaryButton
                            onClick={onSave}
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
