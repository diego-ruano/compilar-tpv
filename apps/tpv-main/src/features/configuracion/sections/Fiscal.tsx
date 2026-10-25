import { commands } from "@tpv/client";
// src/features/configuracion/sections/Fiscal.tsx
//
// Configuración → Fiscal (FISCAL-01).
//
// Los datos del OBLIGADO (NIF y razón social): lo único del sistema de facturación que ningún código
// puede deducir. Sin ellos no se puede emitir la factura, y sin factura no se puede cobrar. Esta rama
// no remite a la AEAT (docs/arquitectura/verifactu.md).

import React, { useCallback, useEffect, useState } from "react";

import { Panel } from "../ui/Panel";
import { Field } from "../ui/Field";
import { useEstadoFiscal } from "../../../shared/stores/useEstadoFiscal";
import { TextInput } from "../ui/Inputs";
import { PrimaryButton } from "../ui/Buttons";
import type { EstadoFiscal } from "@tpv/contracts";
import { conAviso } from "../../../shared/lib/conAviso";

export function Fiscal({
    inputTone,
    razon_social,
    setRazonSocial,
    cif,
    setCif,
    dirty,
    saving,
    onSave,
}: {
    inputTone: string;
    razon_social: string;
    setRazonSocial: (v: string) => void;
    cif: string;
    setCif: (v: string) => void;
    dirty: boolean;
    saving: boolean;
    onSave: () => Promise<void>;
}) {
    const [estado, setEstado] = useState<EstadoFiscal | null>(null);

    const refrescarEstado = useCallback(() => {
        commands.verifactuEstado()
            .then(setEstado)
            .catch(() => setEstado(null));

        // Y se avisa al store que usa el RESTO de la aplicación. Sin esto, el aviso bloqueante de
        // «este TPV todavía no puede cobrar» (FIS-01) se quedaba en pantalla hasta el siguiente
        // poll del store —**dos minutos**— después de haber rellenado los datos: el usuario guarda,
        // ve que se ha guardado, y la aplicación sigue tapada diciéndole que no puede cobrar.
        void useEstadoFiscal.getState().refrescar();
    }, []);

    /**
     * Guarda el obligado y **vuelve a preguntar el estado**.
     *
     * El `onSave` que llega por props sólo persiste; quien tiene que enterarse de que ya no faltan
     * los datos es el estado fiscal, aquí y en el store global (ver `refrescarEstado`).
     */
    const guardarObligado = useCallback(async () => {
        await onSave();
        refrescarEstado();
    }, [onSave, refrescarEstado]);

    useEffect(() => {
        refrescarEstado();
    }, [refrescarEstado]);

    return (
        <div className="flex flex-col gap-4">
            <Panel
                title="Datos fiscales del negocio"
                subtitle="Quién factura. Sin esto no se puede cobrar."
                right={
                    <PrimaryButton onClick={conAviso(guardarObligado)} disabled={!dirty || saving}>
                        {saving ? "Guardando…" : "Guardar"}
                    </PrimaryButton>
                }
            >
                <div className="grid gap-4 sm:grid-cols-2">
                    <Field
                        label="Razón social"
                        hint="Quien factura: «Francisco García SL». No es el rótulo del bar."
                    >
                        <TextInput
                            value={razon_social}
                            onChange={(e) => setRazonSocial(e.target.value)}
                            placeholder="Nombre o razón social del obligado"
                            className={inputTone}
                        />
                    </Field>

                    <Field label="NIF / CIF" hint="El de quien factura. Va en cada ticket y en cada factura.">
                        <TextInput
                            value={cif}
                            onChange={(e) => setCif(e.target.value.toUpperCase())}
                            placeholder="B12345674"
                            className={inputTone}
                        />
                    </Field>
                </div>

                {estado && !estado.datos_fiscales_completos ? (
                    <div className="mt-3 rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-600 dark:text-red-400">
                        Faltan los datos fiscales o el NIF no es válido.{" "}
                        <strong>Mientras falten, no se puede cobrar</strong>: cada cobro emite una
                        factura, y una factura necesita saber quién la emite.
                    </div>
                ) : null}
            </Panel>
        </div>
    );
}
