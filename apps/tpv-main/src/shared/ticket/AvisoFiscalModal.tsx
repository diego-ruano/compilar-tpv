// src/shared/ticket/AvisoFiscalModal.tsx
//
// Los dos peldaños altos de la escalera de avisos de Veri*factu (FISCAL-01, §1.2.1 del plan).
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

import { ModalShell } from "../ui/ModalShell";
import { alMenos, useEstadoFiscal } from "../stores/useEstadoFiscal";

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
