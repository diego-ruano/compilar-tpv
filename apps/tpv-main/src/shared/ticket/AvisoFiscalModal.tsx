// src/shared/ticket/AvisoFiscalModal.tsx
//
// Los dos peldaños altos de la escalera de avisos de Veri*factu (FISCAL-01; docs/arquitectura/verifactu.md).
//
// Los dos primeros peldaños viven donde corresponde: `visible` es el panel de Configuración →
// Fiscal, y `notificacion` es una notificación al Administrador que emite el job. Los dos últimos
// tienen que salir a buscar a quien esté delante del TPV, porque a las 24 y a las 72 horas ya no
// basta con que el dato esté disponible en algún sitio:
//
//   · `modal_login` — al entrar. Una vez por sesión, con reconocimiento explícito.
//   · `modal_cobro` — DESPUÉS de cada cobro.
//
// ## Por qué el de cobro va después y no antes
//
// El plan lo describía como «modal en cada cobro». Se hace al terminar, y por la regla más firme de
// este producto: **nada de lo que rodea al ticket puede impedir cobrar.** Un diálogo delante del
// cobro es una pulsación más en la ruta más caliente de la aplicación, cableada en dos pantallas
// distintas, que un bug convierte en «el TPV no cobra» en hora punta. Al terminar consigue lo mismo
// —es imposible no verlo, va una vez por venta— y no puede llevarse por delante una venta.
//
// ## Y no hay botón de «no volver a avisar»
//
// A propósito. Lo que esto señala no se arregla ignorándolo, y un interruptor para silenciarlo es la
// primera cosa que alguien pulsaría. El aviso desaparece cuando la cola baja del peldaño, que es
// cuando el problema deja de existir.

import React from "react";
import { useNavigate } from "react-router-dom";

import { ModalShell } from "../ui/ModalShell";
import { alMenos, useEstadoFiscal } from "../stores/useEstadoFiscal";
import { useAuth } from "../stores/useAuth";
import { esAdmin } from "../lib/permisos";

function antiguedadLegible(min: number | null): string {
    if (min == null) return "";
    if (min < 60) return `${min} minutos`;
    const h = Math.floor(min / 60);
    if (h < 48) return `${h} horas`;
    return `${Math.floor(h / 24)} días`;
}

export default function AvisoFiscalModal({
    open,
    onClose,
    /** `login` = al entrar (una vez por sesión). `cobro` = tras una venta. */
    momento,
}: {
    open: boolean;
    onClose: () => void;
    momento: "login" | "cobro";
}) {
    const escalon = useEstadoFiscal((s) => s.escalon);
    const antiguedad = useEstadoFiscal((s) => s.antiguedadMin);
    const pendientes = useEstadoFiscal((s) => s.pendientes);

    if (!open) return null;

    const tresDias = escalon === "modal_cobro";

    return (
        <ModalShell open={open} onClose={onClose}>
            <div className="absolute inset-0 bg-black/60" />
            <div className="relative w-[560px] max-w-[94vw] rounded-3xl border border-border bg-surface p-6 shadow-xl">
                <h3
                    className={[
                        "text-lg font-bold",
                        tresDias ? "text-danger" : "text-amber-600 dark:text-amber-400",
                    ].join(" ")}
                >
                    {tresDias
                        ? "Llevas más de TRES DÍAS sin enviar facturas a Hacienda"
                        : "Llevas más de un día sin enviar facturas a Hacienda"}
                </h3>

                <div className="mt-3 space-y-2 text-sm text-fg">
                    <p>
                        Hay <strong>{pendientes}</strong> factura(s) esperando, y la más antigua
                        lleva <strong>{antiguedadLegible(antiguedad)}</strong> en cola.
                    </p>
                    <p className="text-fg-muted">
                        Las facturas están <strong>emitidas y guardadas</strong>: no se ha perdido
                        ninguna venta y el papel que se entregó es válido. Lo que falta es{" "}
                        <strong>remitirlas</strong>, y eso sí es una obligación con plazo.
                    </p>
                    {tresDias ? (
                        <p className="font-semibold text-danger">
                            Un equipo al que se le pone internet cada tres días para soltar el atraso
                            no es un sistema VERI*FACTU. Esto hay que resolverlo hoy.
                        </p>
                    ) : null}
                    <p className="text-fg-muted">
                        Qué mirar, por orden: que el equipo tenga internet, y que el certificado siga
                        siendo válido en <strong>Configuración → Fiscal</strong> (ahí hay un botón
                        «Probar» que lo dice en dos segundos). Si no sabes por dónde empezar, llama a
                        soporte.
                    </p>
                </div>

                <div className="mt-6 flex items-center justify-end">
                    <button
                        type="button"
                        onClick={onClose}
                        className="h-10 rounded-xl border border-primary bg-primary px-5 text-sm font-bold text-white shadow-sm hover:opacity-90 active:scale-[0.97]"
                    >
                        {momento === "login" ? "Lo he entendido" : "Continuar"}
                    </button>
                </div>
            </div>
        </ModalShell>
    );
}

/**
 * Faltan los datos del obligado, y por tanto **este equipo no puede cobrar**.
 *
 * Es un aviso distinto de la escalera de atraso y por eso no comparte su reconocimiento: aquélla
 * dice «hay facturas sin remitir», que es grave pero no impide vender. Ésta dice que el siguiente
 * cobro va a fallar.
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
                        negocio. Sin eso no se puede emitir la factura, y desde 2027{" "}
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
                                void navigate("/Configuracion", { state: { seccion: "FISCAL" } });
                            }}
                            className="h-10 rounded-xl border border-primary bg-primary px-5 text-sm font-bold text-white shadow-sm hover:opacity-90 active:scale-[0.97]"
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
 */
export function AvisoFiscalMontado() {
    const listo = useEstadoFiscal((s) => s.listo);
    const escalon = useEstadoFiscal((s) => s.escalon);
    const reconocido = useEstadoFiscal((s) => s.reconocido);
    const reconocer = useEstadoFiscal((s) => s.reconocer);
    const datosFiscalesCompletos = useEstadoFiscal((s) => s.datosFiscalesCompletos);
    const datosReconocidos = useEstadoFiscal((s) => s.datosReconocidos);
    const reconocerDatos = useEstadoFiscal((s) => s.reconocerDatos);
    const init = useEstadoFiscal((s) => s.init);

    const [trasCobro, setTrasCobro] = React.useState(false);

    React.useEffect(() => {
        init();
    }, [init]);

    // El cobro lo anuncian las dos pantallas de venta con un evento propio. Se usa un evento y no una
    // llamada directa para que el aviso no entre en el camino del cobro: si esto fallara, la venta ya
    // está hecha.
    React.useEffect(() => {
        const fn = () => setTrasCobro(true);
        window.addEventListener("verifactu:cobro", fn);
        return () => window.removeEventListener("verifactu:cobro", fn);
    }, []);

    if (!listo) return null;

    // Manda sobre los dos de la escalera, y no es discutible: aquéllos dicen que hay facturas sin
    // remitir; éste dice que **el siguiente cobro va a fallar**. Enseñar primero el del atraso
    // sería hablar de la cola de un equipo que todavía no ha vendido nada.
    if (!datosFiscalesCompletos && !datosReconocidos) {
        return <AvisoDatosFiscalesModal onClose={reconocerDatos} />;
    }

    // El de cobro manda sobre el de login: si los dos tocaran a la vez, el de cobro es el más grave.
    if (trasCobro && escalon === "modal_cobro") {
        return (
            <AvisoFiscalModal
                open
                momento="cobro"
                onClose={() => {
                    setTrasCobro(false);
                    // Reconocer también el de login: acaba de leer exactamente el mismo texto.
                    reconocer();
                }}
            />
        );
    }

    if (!reconocido && alMenos(escalon, "modal_login")) {
        return <AvisoFiscalModal open momento="login" onClose={reconocer} />;
    }

    return null;
}

/** Lo llaman las pantallas de venta tras un cobro correcto. */
export function anunciarCobro(): void {
    window.dispatchEvent(new CustomEvent("verifactu:cobro"));
}
