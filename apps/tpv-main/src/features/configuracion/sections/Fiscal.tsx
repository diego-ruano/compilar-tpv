// src/features/configuracion/sections/Fiscal.tsx
//
// Configuración → Fiscal (FISCAL-01, Veri*factu).
//
// Reúne las cuatro cosas que el sistema de facturación necesita de una persona y que ningún código
// puede deducir:
//
//   1. Los datos del OBLIGADO (NIF y razón social). Sin ellos no se puede emitir el registro, y sin
//      registro no se puede cobrar: es la única puerta que Veri*factu añade al camino de la venta.
//   2. El CERTIFICADO con el que se remite. Sólo se guarda su huella; la clave privada no sale
//      nunca del almacén de Windows.
//   3. El ENTORNO (producción o pruebas), que es una decisión explícita y visible a propósito: los
//      endpoints se distinguen en tres caracteres y un ticket de pruebas que parece real es peor
//      que uno que no sale.
//   4. El estado de la COLA: cuántos registros esperan y desde cuándo. Es lo que hace visible la
//      escalera de avisos (§1.2.1 del plan) — la obligación de remitir es del bar, y nuestro
//      trabajo es que no pueda decir que no lo sabía.

import React, { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import { Panel } from "../ui/Panel";
import { Field } from "../ui/Field";
import { TextInput } from "../ui/Inputs";
import { GhostButton, PrimaryButton } from "../ui/Buttons";
import { cn } from "../utils";
import { useToast } from "../../../shared/toast";
import { verifactuEstado } from "../api/verifactuApis";
import type { EstadoFiscal } from "@tpv/contracts";

/** Un certificado del almacén, tal como lo devuelve `verifactu_certificados`. */
type Certificado = {
    huella: string;
    sujeto: string;
    emisor: string;
    valido_hasta: string;
    almacen: string;
    uso_silencioso: boolean;
    elegido: boolean;
};

/** Cómo se enseña cada escalón de la escalera de avisos. */
const ESCALONES: Record<
    string,
    { texto: string; tono: string } | undefined
> = {
    ninguno: undefined,
    visible: {
        texto: "Hay facturas esperando a enviarse desde hace más de una hora.",
        tono: "text-fg-muted",
    },
    notificacion: {
        texto: "Hay facturas sin enviar desde hace más de 6 horas. Revisa la conexión.",
        tono: "text-amber-600 dark:text-amber-400",
    },
    modal_login: {
        texto:
            "Llevas más de un día sin enviar facturas a la AEAT. Esto hay que resolverlo: " +
            "el registro se puede emitir sin conexión, pero no se puede dejar de remitir.",
        tono: "text-amber-700 dark:text-amber-300 font-semibold",
    },
    modal_cobro: {
        texto:
            "Llevas más de TRES DÍAS sin enviar facturas a la AEAT. Un equipo al que le ponen " +
            "internet cada tres días para soltar el atraso no es un sistema VERI*FACTU. " +
            "Llama a soporte si no sabes por dónde empezar.",
        tono: "text-red-600 dark:text-red-400 font-semibold",
    },
};

function antiguedadLegible(min: number | null | undefined): string {
    if (min == null) return "";
    if (min < 60) return `${min} min`;
    const h = Math.floor(min / 60);
    if (h < 48) return `${h} h`;
    return `${Math.floor(h / 24)} días`;
}

export function Fiscal({
    inputTone,
    razonSocial,
    setRazonSocial,
    cif,
    setCif,
    dirty,
    saving,
    onSave,
}: {
    inputTone: string;
    razonSocial: string;
    setRazonSocial: (v: string) => void;
    cif: string;
    setCif: (v: string) => void;
    dirty: boolean;
    saving: boolean;
    onSave: () => Promise<void>;
}) {
    const toast = useToast();
    const [estado, setEstado] = useState<EstadoFiscal | null>(null);
    const [certs, setCerts] = useState<Certificado[] | null>(null);
    const [cargandoCerts, setCargandoCerts] = useState(false);
    const [probando, setProbando] = useState(false);
    const [resultadoPrueba, setResultadoPrueba] = useState<string>("");

    const refrescarEstado = useCallback(() => {
        verifactuEstado()
            .then(setEstado)
            .catch(() => setEstado(null));
    }, []);

    useEffect(() => {
        refrescarEstado();

        // Dos fuentes, y las dos hacen falta.
        //
        // El EVENTO es el que da inmediatez: el job de remisión emite `verifactu:cambio` al mover
        // algo, así que el panel se actualiza en el momento en que la cola baja. Es un aviso, no un
        // dato: al recibirlo se vuelve a pedir el estado.
        //
        // El POLL es la red de seguridad, y cubre el caso que el evento no puede: la cola también
        // CRECE sola, con cada cobro, y eso no lo emite este job. Medio minuto es de sobra para una
        // pantalla que alguien está mirando.
        let cancelado = false;
        let dejarDeEscuchar: (() => void) | null = null;
        void listen("verifactu:cambio", () => {
            if (!cancelado) refrescarEstado();
        }).then((un) => {
            if (cancelado) un();
            else dejarDeEscuchar = un;
        });

        const t = setInterval(refrescarEstado, 30_000);
        return () => {
            cancelado = true;
            clearInterval(t);
            dejarDeEscuchar?.();
        };
    }, [refrescarEstado]);

    const cargarCertificados = useCallback(async () => {
        setCargandoCerts(true);
        try {
            const lista = await invoke<Certificado[]>("verifactu_certificados");
            setCerts(lista);
        } catch (e) {
            console.error("verifactu_certificados:", e);
            toast.error("Certificados", "No se pudo leer el almacén de Windows.");
            setCerts([]);
        } finally {
            setCargandoCerts(false);
        }
    }, [toast]);

    const elegir = async (huella: string) => {
        try {
            await invoke("verifactu_set_certificado", { huella });
            toast.success("Certificado", "Elegido para enviar a la AEAT.");
            await cargarCertificados();
            refrescarEstado();
        } catch (e) {
            toast.error("Certificado", typeof e === "string" ? e : "No se pudo elegir.");
        }
    };

    const probar = async (huella?: string) => {
        setProbando(true);
        setResultadoPrueba("");
        try {
            const r = await invoke<string>("verifactu_probar_conexion", {
                huella: huella ?? null,
            });
            setResultadoPrueba(r);
            toast.success("Conexión con la AEAT", "El certificado funciona.");
        } catch (e) {
            const msg = typeof e === "string" ? e : (e as any)?.message ?? "Falló la conexión.";
            setResultadoPrueba(msg);
            toast.error("Conexión con la AEAT", msg);
        } finally {
            setProbando(false);
        }
    };

    const aviso = estado ? ESCALONES[estado.escalon_aviso] : undefined;

    return (
        <div className="flex flex-col gap-4">
            {/* ── Datos del obligado ─────────────────────────────────────────────────────── */}
            <Panel
                title="Datos fiscales del negocio"
                subtitle="Quién factura. Sin esto no se puede cobrar."
                right={
                    <PrimaryButton onClick={onSave} disabled={!dirty || saving}>
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
                            value={razonSocial}
                            onChange={(e) => setRazonSocial(e.target.value)}
                            placeholder="Nombre o razón social del obligado"
                            className={inputTone}
                        />
                    </Field>

                    <Field
                        label="NIF / CIF"
                        hint="El de quien factura. Va en cada registro y en el QR del ticket."
                    >
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

                {estado?.total_registros ? (
                    <div className="mt-3 text-xs text-fg-muted">
                        Ya hay {estado.total_registros} registro(s) de facturación emitidos. Cambiar
                        el NIF a partir de aquí sería empezar otra cadena de facturación, así que no
                        es algo que se haga desde esta pantalla.
                    </div>
                ) : null}
            </Panel>

            {/* ── Estado del envío ───────────────────────────────────────────────────────── */}
            <Panel
                title="Envío a la AEAT"
                subtitle="Cada factura se remite en cuanto se puede. Sin conexión se sigue vendiendo."
                right={<GhostButton onClick={refrescarEstado}>Actualizar</GhostButton>}
            >
                {estado ? (
                    <>
                        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                            {[
                                ["Pendientes", estado.pendientes],
                                ["Aceptadas", estado.aceptados],
                                ["Con avisos", estado.aceptados_con_errores],
                                ["Rechazadas", estado.rechazados],
                            ].map(([etiqueta, valor]) => (
                                <div
                                    key={String(etiqueta)}
                                    className="rounded-2xl border border-border bg-surface-2 px-3 py-3"
                                >
                                    <div className="text-xs text-fg-muted">{etiqueta}</div>
                                    <div className="text-2xl font-semibold tabular-nums">
                                        {Number(valor)}
                                    </div>
                                </div>
                            ))}
                        </div>

                        {aviso ? (
                            <div className={cn("mt-3 text-sm", aviso.tono)}>
                                {aviso.texto}
                                {estado.antiguedad_pendiente_min != null ? (
                                    <>
                                        {" "}
                                        (la más antigua lleva{" "}
                                        {antiguedadLegible(estado.antiguedad_pendiente_min)})
                                    </>
                                ) : null}
                            </div>
                        ) : (
                            <div className="mt-3 text-sm text-fg-muted">
                                {estado.pendientes > 0
                                    ? "Hay facturas en cola. Es lo normal: la AEAT impone una espera entre envíos."
                                    : "No hay nada pendiente de enviar."}
                            </div>
                        )}

                        {estado.motivo_no_remite ? (
                            <div className="mt-3 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-300">
                                No se puede remitir:{" "}
                                {estado.motivo_no_remite === "sin_datos_fiscales"
                                    ? "faltan los datos fiscales del negocio."
                                    : estado.motivo_no_remite}
                            </div>
                        ) : null}

                        {estado.entorno_pruebas ? (
                            <div className="mt-3 rounded-xl border border-amber-500/40 bg-amber-500/15 px-3 py-2 text-sm font-semibold text-amber-700 dark:text-amber-300">
                                ENTORNO DE PRUEBAS. Los tickets llevan un QR que apunta al portal de
                                pruebas de la AEAT y <strong>no son facturas reales</strong>.
                            </div>
                        ) : null}
                    </>
                ) : (
                    <div className="text-sm text-fg-muted">Cargando…</div>
                )}
            </Panel>

            {/* ── Certificado ────────────────────────────────────────────────────────────── */}
            <Panel
                title="Certificado electrónico"
                subtitle="Con el que el equipo se identifica ante la AEAT."
                right={
                    <GhostButton onClick={cargarCertificados} disabled={cargandoCerts}>
                        {cargandoCerts ? "Buscando…" : certs ? "Volver a buscar" : "Buscar"}
                    </GhostButton>
                }
            >
                <div className="text-sm text-fg-muted">
                    Instálalo en Windows como lo instalarías para Autofirma (doble clic en el
                    fichero <code>.p12</code> o <code>.pfx</code>). El TPV{" "}
                    <strong>no guarda el certificado ni su contraseña</strong>: sólo apunta cuál has
                    elegido, y quien firma la conexión es Windows.
                </div>

                {certs === null ? null : certs.length === 0 ? (
                    <div className="mt-3 rounded-xl border border-border bg-surface-2 px-3 py-3 text-sm">
                        No se ha encontrado ningún certificado utilizable.
                        <ul className="mt-2 list-disc pl-5 text-fg-muted">
                            <li>
                                Un fichero <code>.cer</code> o <code>.crt</code> no vale: sólo lleva
                                la parte pública y no puede identificar a nadie.
                            </li>
                            <li>
                                El almacén es <strong>por usuario de Windows</strong>. Si lo instaló
                                otra persona con su sesión, hay que instalarlo también en esta.
                            </li>
                        </ul>
                    </div>
                ) : (
                    <div className="mt-3 flex flex-col gap-2">
                        {certs.map((c) => (
                            <div
                                key={c.huella}
                                className={cn(
                                    "rounded-2xl border px-3 py-3",
                                    c.elegido
                                        ? "border-accent/40 bg-accent-soft"
                                        : "border-border bg-surface-2",
                                )}
                            >
                                <div className="flex flex-wrap items-center justify-between gap-2">
                                    <div className="min-w-0">
                                        <div className="truncate font-medium">{c.sujeto}</div>
                                        <div className="truncate text-xs text-fg-muted">
                                            {c.emisor} · caduca el {c.valido_hasta} · almacén{" "}
                                            {c.almacen}
                                        </div>
                                        {!c.uso_silencioso ? (
                                            <div className="mt-1 text-xs text-amber-600 dark:text-amber-400">
                                                Pedirá una contraseña o un PIN en cada envío, así que
                                                no sirve para el envío automático. Si es un{" "}
                                                <code>.p12</code>, vuelve a importarlo sin marcar
                                                «protección alta».
                                            </div>
                                        ) : null}
                                    </div>
                                    <div className="flex shrink-0 items-center gap-2">
                                        <GhostButton
                                            onClick={() => probar(c.huella)}
                                            disabled={probando}
                                        >
                                            {probando ? "Probando…" : "Probar"}
                                        </GhostButton>
                                        {c.elegido ? (
                                            <span className="text-sm font-medium text-accent">
                                                En uso
                                            </span>
                                        ) : (
                                            <PrimaryButton onClick={() => elegir(c.huella)}>
                                                Usar este
                                            </PrimaryButton>
                                        )}
                                    </div>
                                </div>
                            </div>
                        ))}
                    </div>
                )}

                {resultadoPrueba ? (
                    <div className="mt-3 rounded-xl border border-border bg-surface-2 px-3 py-2 text-sm">
                        {resultadoPrueba}
                    </div>
                ) : null}

                <div className="mt-3 text-xs text-fg-muted">
                    El botón <strong>Probar</strong> abre una conexión de verdad con la AEAT{" "}
                    <strong>sin enviar ninguna factura</strong>. Sirve para que, si el certificado
                    esconde una petición de PIN, salga ahora y no de madrugada con las facturas
                    acumulándose.
                </div>
            </Panel>
        </div>
    );
}
