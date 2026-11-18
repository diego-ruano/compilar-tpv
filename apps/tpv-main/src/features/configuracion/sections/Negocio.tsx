import { guardarImagen } from "../../../shared/lib/guardarImagen";
// src/features/configuracion/sections/Negocio.tsx
//
// Configuración → Negocio: los datos que salen en el ticket, quién factura (FISCAL-01), el correo de
// contacto y el logo. Sin NIF ni razón social no se puede emitir la factura, y sin factura no se
// puede cobrar. Esta rama no remite a la AEAT (docs/arquitectura/verifactu.md).
//
// El correo de contacto se guarda en otra tabla (`Contact_Settings`), pero con el mismo botón. El de
// RECUPERACIÓN es otro, a propósito: vive en la base central y tiene su propio panel, que lo cambia
// verificando el buzón nuevo (LOGIN-08).
import React, { useCallback, useEffect, useRef, useState } from "react";
import { commands, toAppError } from "@tpv/client";
import type { EstadoFiscal } from "@tpv/contracts";

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
import { useEstadoFiscal } from "../../../shared/stores/useEstadoFiscal";
import { useMode } from "../../../shared/stores/useMode";
import { nifValido } from "../../../shared/ticket/nif";
import { CorreoRecuperacion } from "./CorreoRecuperacion";
import { CambioDeOtroEquipo } from "../ui/CambioDeOtroEquipo";
import { ErrorDeAjustes } from "../ui/ErrorDeAjustes";
import type { Choques } from "../borrador";

export function Negocio({
    darkMode,
    inputTone,
    draft,
    setDraft,
    choques,
    choqueCorreo,
    correo,
    setCorreo,
    correoCargando,
    correoError,
    onReintentarCorreo,
    listo,
    error,
    onReintentar,
    dirty,
    saving,
    onSave,
    onReset,
}: {
    darkMode: boolean;
    inputTone: string;
    draft: BusinessDraft;
    setDraft: React.Dispatch<React.SetStateAction<BusinessDraft>>;
    /** CFG-INC-01: lo que otro equipo ha puesto en un campo que aquí también se ha cambiado. */
    choques: Choques<BusinessDraft>;
    choqueCorreo: string | undefined;
    correo: string;
    setCorreo: (v: string) => void;
    correoCargando: boolean;
    /** CFG-INC-02: el correo no se ha podido leer, y por qué. */
    correoError: string | null;
    onReintentarCorreo: () => Promise<void>;
    /** Los datos del negocio se han leído alguna vez. Hasta entonces no hay formulario. */
    listo: boolean;
    /** CFG-INC-02: la última lectura de los datos del negocio ha fallado, y por qué. */
    error: string | null;
    onReintentar: () => Promise<void>;
    /** Cambios sin guardar en el borrador del negocio o en el correo. */
    dirty: boolean;
    saving: boolean;
    onSave: () => Promise<void>;
    onReset: () => void;
}) {
    const fileInputRef = useRef<HTMLInputElement | null>(null);
    const toast = useToast();
    const esMain = useMode((s) => s.mode === "tpv");
    const [uploadingLogo, setUploadingLogo] = useState(false);

    // Lo GUARDADO: si faltan los datos fiscales, no se puede cobrar.
    const [estado, setEstado] = useState<EstadoFiscal | null>(null);
    const refrescarEstado = useCallback(() => {
        // Sólo la Main guarda registros de facturación: en una Handy no hay qué preguntar.
        if (!esMain) {
            setEstado(null);
            return;
        }
        commands.verifactuEstado()
            .then(setEstado)
            .catch(() => setEstado(null));
        // Y el store que usa el RESTO de la aplicación: sin esto, el aviso de «este TPV todavía no
        // puede cobrar» (FIS-01) seguiría en pantalla hasta su siguiente consulta, a los dos minutos.
        void useEstadoFiscal.getState().refrescar();
    }, [esMain]);
    useEffect(() => {
        refrescarEstado();
    }, [refrescarEstado]);

    // Guarda y vuelve a preguntar el estado: `onSave` sólo persiste.
    const guardar = useCallback(async () => {
        await onSave();
        refrescarEstado();
    }, [onSave, refrescarEstado]);

    // Lo que se está ESCRIBIENDO, con el mismo criterio que el backend (`nifValido`). Un NIF que no
    // vale no se guarda: dejaría el TPV sin poder cobrar por una errata.
    const nifMal = draft.cif.trim().length > 0 && !nifValido(draft.cif);

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
            toast.error("No se pudo subir el logo", toAppError(e).message);
        } finally {
            setUploadingLogo(false);
        }
    };

    // CFG-INC-02: sin una lectura buena no hay formulario. Antes salían los valores por defecto como
    // si fueran los guardados, y «Guardar» los escribía encima de los buenos.
    if (!listo) {
        return (
            <div className="flex flex-col gap-4">
                {error ? (
                    <ErrorDeAjustes
                        titulo="No se han podido leer los datos del negocio"
                        motivo={error}
                        detalle="Hasta leerlos no se pueden ver ni cambiar."
                        onReintentar={onReintentar}
                    />
                ) : null}
                {esMain ? <CorreoRecuperacion /> : null}
            </div>
        );
    }

    return (
        <div className="flex flex-col gap-4">
            {error ? (
                <ErrorDeAjustes
                    titulo="No se han podido volver a leer los datos del negocio"
                    motivo={error}
                    detalle="Lo que ves puede no ser lo último que se guardó: no se puede guardar hasta leerlos."
                    onReintentar={onReintentar}
                />
            ) : null}
            <Panel
                title="Datos del negocio"
                subtitle="Salen en el ticket. Sin la razón social y el NIF no se puede cobrar."
            >
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <Field label="Nombre" hint="El rótulo del bar">
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
                        <CambioDeOtroEquipo valor={choques.business_name} />
                    </Field>

                    <Field label="Razón social" hint="Quien factura: «Francisco García SL»">
                        <TextInput
                            value={draft.razon_social}
                            onChange={(e) =>
                                setDraft((d) => ({ ...d, razon_social: e.target.value }))
                            }
                            placeholder="Nombre o razón social del obligado"
                            className={inputTone}
                        />
                        <CambioDeOtroEquipo valor={choques.razon_social} />
                    </Field>

                    <Field label="NIF / CIF" hint="El de quien factura">
                        <TextInput
                            value={draft.cif}
                            onChange={(e) =>
                                setDraft((d) => ({ ...d, cif: e.target.value.toUpperCase() }))
                            }
                            placeholder="B12345674"
                            className={cn(inputTone, nifMal && "ring-1 ring-danger")}
                        />
                        {nifMal ? (
                            <span className="mt-1 block text-xs text-danger">
                                Ese NIF no es válido: revisa la letra o el dígito de control.
                            </span>
                        ) : null}
                        <CambioDeOtroEquipo valor={choques.cif} />
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
                        <CambioDeOtroEquipo valor={choques.telefono} />
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
                        <CambioDeOtroEquipo valor={choques.direccion} />
                    </Field>

                    <Field label="Correo de contacto" hint="Para los pedidos a proveedores; no sale en el ticket">
                        <TextInput
                            type="email"
                            maxLength={254}
                            value={correo}
                            onChange={(e) => setCorreo(e.target.value)}
                            placeholder={correoCargando ? "Cargando…" : "bar@ejemplo.com"}
                            disabled={correoCargando || correoError !== null}
                            className={inputTone}
                        />
                        {correoError ? (
                            <div className="mt-2">
                                <ErrorDeAjustes
                                    titulo="No se ha podido leer el correo de contacto"
                                    motivo={correoError}
                                    onReintentar={onReintentarCorreo}
                                />
                            </div>
                        ) : null}
                        <CambioDeOtroEquipo valor={choqueCorreo} />
                    </Field>
                </div>

                {estado && !estado.datos_fiscales_completos ? (
                    <div className="mt-4 rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-600 dark:text-red-400">
                        {estado.nif && estado.razon_social
                            ? "El NIF no es válido: revisa que esté bien escrito."
                            : "Faltan la razón social o el NIF."}{" "}
                        <strong>Mientras tanto, no se puede cobrar</strong>: cada cobro emite una
                        factura, y una factura necesita saber quién la emite.
                    </div>
                ) : null}
            </Panel>

            <Panel
                title="Logo"
                subtitle="Se mostrará en el ticket (si lo tienes activado)."
                right={
                    <div className="flex items-center gap-2">
                        <GhostButton
                            onClick={onPickLogo}
                            disabled={uploadingLogo}
                        >
                            {uploadingLogo ? "Subiendo…" : "Subir logo"}
                        </GhostButton>
                        <GhostButton
                            onClick={() =>
                                setDraft((d) => ({ ...d, logo_data_url: null }))
                            }
                        >
                            Quitar
                        </GhostButton>

                        <input
                            ref={fileInputRef}
                            type="file"
                            accept="image/jpeg,image/png,.jpg,.jpeg,.png"
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
                        <CambioDeOtroEquipo
                            valor={choques.logo_data_url}
                            texto={choques.logo_data_url ? "En otro equipo han cambiado el logo." : "En otro equipo han quitado el logo."}
                        />
                    </div>
                </div>
            </Panel>

            {/* Un solo «Guardar» para toda la sección, logo y correo incluidos. */}
            <div className="flex items-center justify-end gap-2">
                <GhostButton
                    onClick={onReset}
                    disabled={!dirty || saving}
                >
                    Descartar
                </GhostButton>
                <PrimaryButton
                    onClick={conAviso(guardar)}
                    disabled={!dirty || saving || nifMal || error !== null || correoError !== null}
                >
                    {saving ? "Guardando…" : "Guardar cambios"}
                </PrimaryButton>
            </div>

            {/* Debajo de «Guardar cambios» porque no va con él: se cambia verificando un código. Sólo
                en la Main, que es donde lo dejan cambiar sus comandos. */}
            {esMain ? <CorreoRecuperacion /> : null}
        </div>
    );
}
