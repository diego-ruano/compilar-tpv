// src/shared/ticket/AvisoFiscalModal.tsx
//
// El aviso de que faltan los datos fiscales del negocio (FISCAL-01; docs/arquitectura/verifactu.md):
// sin ellos, el siguiente cobro va a fallar.

import React from "react";
import { useNavigate } from "react-router-dom";

import { ModalShell } from "../ui/ModalShell";
import { useEstadoFiscal } from "../stores/useEstadoFiscal";
import { useMode } from "../stores/useMode";
import { useAuth } from "../stores/useAuth";
import { esAdmin } from "../lib/permisos";

/**
 * Faltan los datos del obligado, y por tanto **este equipo no puede cobrar**.
 *
 * ## Por qué aparece aquí y no antes del login
 *
 * Porque quien puede arreglarlo tiene que estar identificado: `config_patch_business_settings`
 * exige Administrador. Una pantalla anterior al login no podría guardar nada.
 *
 * ## Por qué se puede cerrar
 *
 * Porque atrapar aquí a un camarero que sólo quiere mirar las mesas no arregla nada —él no puede
 * rellenarlo— y porque desde FIS-01 la caja **ya dice** por qué no cobra. Esto adelanta el momento
 * en que alguien se entera; no es la única red.
 */
function AvisoDatosFiscalesModal({ onClose }: { onClose: () => void }) {
    const navigate = useNavigate();
    const soyAdmin = esAdmin(useAuth((s) => s.role));

    return (
        <ModalShell open onClose={onClose}>
            <div className="absolute inset-0 bg-black/60" />
            <div className="relative w-[560px] max-w-[94vw] rounded-3xl border border-border bg-surface p-6 shadow-xl">
                <h3 className="text-lg font-bold text-danger">
                    Este TPV todavía no puede cobrar
                </h3>

                <div className="mt-3 space-y-2 text-sm text-fg">
                    <p>
                        Falta decir <strong>quién factura</strong>: el NIF y la razón social del
                        negocio. Sin eso no se puede emitir la factura, y{" "}
                        <strong>cada cobro expide una</strong>.
                    </p>
                    <p className="text-fg-muted">
                        No es un ajuste opcional ni algo que se pueda dejar para luego: mientras
                        falte, cualquier intento de cobro se cancelará. La licencia no lo rellena —
                        el nombre que se puso al activarla es el de la licencia, no el del obligado
                        tributario.
                    </p>
                    {soyAdmin ? null : (
                        <p className="font-semibold text-amber-600 dark:text-amber-400">
                            Sólo lo puede rellenar un Administrador. Avisa a quien lleve el bar
                            antes de abrir.
                        </p>
                    )}
                </div>

                <div className="mt-6 flex items-center justify-end gap-2">
                    <button
                        type="button"
                        onClick={onClose}
                        className="h-10 rounded-xl border border-border px-5 text-sm font-semibold text-fg-muted hover:bg-surface-2"
                    >
                        Ahora no
                    </button>
                    {soyAdmin ? (
                        <button
                            type="button"
                            onClick={() => {
                                onClose();
                                void navigate("/Configuracion", { state: { seccion: "NEGOCIO" } });
                            }}
                            className="h-10 rounded-xl border border-accent bg-accent px-5 text-sm font-bold text-accent-fg shadow-sm hover:border-accent-hover hover:bg-accent-hover hover:opacity-90 active:scale-[0.97]"
                        >
                            Rellenarlo ahora
                        </button>
                    ) : null}
                </div>
            </div>
        </ModalShell>
    );
}

/**
 * El aviso, cableado al store. Se monta **una vez** en el layout y decide solo cuándo aparecer.
 *
 * Se monta en el layout y no en cada pantalla por lo de siempre: una regla que hay que acordarse de
 * repetir en cada sitio nuevo es una regla que se rompe al añadir la siguiente pantalla.
 *
 * Sólo en la Main: una Handy no cobra ni guarda registros de facturación, así que ni pregunta ni
 * avisa. Va por el modo del equipo y no por la plataforma, porque un escritorio puede ser una Handy.
 */
export function AvisoFiscalMontado() {
    const esMain = useMode((s) => s.mode === "tpv");
    const listo = useEstadoFiscal((s) => s.listo);
    const datosFiscalesCompletos = useEstadoFiscal((s) => s.datosFiscalesCompletos);
    const datosReconocidos = useEstadoFiscal((s) => s.datosReconocidos);
    const reconocerDatos = useEstadoFiscal((s) => s.reconocerDatos);
    const init = useEstadoFiscal((s) => s.init);

    React.useEffect(() => {
        if (esMain) init();
    }, [init, esMain]);

    if (!esMain || !listo) return null;

    if (!datosFiscalesCompletos && !datosReconocidos) {
        return <AvisoDatosFiscalesModal onClose={reconocerDatos} />;
    }

    return null;
}
