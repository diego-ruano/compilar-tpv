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
//
// Y dos cosas que no son ajustes sino OBLIGACIONES del sistema, y que por eso viven aquí y no en un
// PDF que nadie encuentra el día que hace falta:
//
//   5. La EXPORTACIÓN de los registros (art. 8 RRSIF). Un inspector puede pedirla.
//   6. La DECLARACIÓN RESPONSABLE del productor (art. 13 RRSIF), que la norma exige poder ver
//      «en el propio sistema informático, visible en cada una de sus versiones».

import React, { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { save } from "@tauri-apps/plugin-dialog";
import { toAppError } from "@tpv/client";

import { Panel } from "../ui/Panel";
import { Field } from "../ui/Field";
import { TextInput } from "../ui/Inputs";
import { GhostButton, PrimaryButton } from "../ui/Buttons";
import { cn } from "../utils";
import { useToast } from "../../../shared/toast";
import { useBusinessSettings } from "../../../shared/stores/useBusinessSettings";
import {
    verifactuDeclaracionResponsable,
    verifactuEstado,
    verifactuExportar,
    type DeclaracionResponsable,
} from "../api/verifactuApis";
import type { EstadoFiscal } from "@tpv/contracts";

/** `AAAA-MM-DD` de hoy en hora local (`toISOString` da UTC y en España adelanta el día por la noche). */
function hoyISO(): string {
    const d = new Date();
    const p = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** El 1 de enero del año en curso: el rango que pide un asesor por defecto es el ejercicio. */
function inicioDeEjercicioISO(): string {
    return `${new Date().getFullYear()}-01-01`;
}

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

    const [desde, setDesde] = useState(inicioDeEjercicioISO);
    const [hasta, setHasta] = useState(hoyISO);
    const [exportando, setExportando] = useState(false);

    const [dr, setDr] = useState<DeclaracionResponsable | null>(null);
    const [verDr, setVerDr] = useState(false);

    // El entorno NO va por el `draft` de la pantalla de negocio con el resto de los campos, y es a
    // propósito: no es un dato que se teclea y se guarda junto a los demás, es un interruptor con
    // consecuencias inmediatas sobre lo que sale impreso. Se aplica en el momento y se confirma.
    const entorno = useBusinessSettings((st) => st.verifactuEntorno);
    const setMany = useBusinessSettings((st) => st.setMany);
    const [confirmandoEntorno, setConfirmandoEntorno] = useState<
        "produccion" | "pruebas" | null
    >(null);

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

    // La declaración responsable no cambia salvo con la versión del programa, así que se pide una
    // vez y se queda. No se esconde tras un botón «cargar»: la norma pide que esté visible.
    useEffect(() => {
        let vivo = true;
        verifactuDeclaracionResponsable()
            .then((d) => {
                if (vivo) setDr(d);
            })
            .catch(() => {
                if (vivo) setDr(null);
            });
        return () => {
            vivo = false;
        };
    }, []);

    const exportar = useCallback(async () => {
        setExportando(true);
        try {
            // El nombre por defecto lleva el rango dentro: estos ficheros se acumulan en el
            // escritorio de alguien y «registros.zip» no se distingue del de hace tres meses.
            const destino = await save({
                title: "Guardar la exportación de los registros de facturación",
                defaultPath: `registros-facturacion-${desde}_${hasta}.zip`,
                filters: [{ name: "Exportación Veri*factu", extensions: ["zip"] }],
            });
            if (!destino) return;

            const n = await verifactuExportar(destino, desde, hasta);
            if (n === 0) {
                toast.info(
                    "No hay registros en ese rango",
                    "El fichero se ha creado igual, vacío: un rango sin facturas no es un error.",
                );
            } else {
                toast.success(
                    "Exportación guardada",
                    `${n} registro(s). El fichero cadena.txt permite verificar las huellas sin este programa.`,
                );
            }
        } catch (e) {
            toast.error("No se pudo exportar", toAppError(e).message);
        } finally {
            setExportando(false);
        }
    }, [desde, hasta, toast]);

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

            {/* ── Entorno ─────────────────────────────────────────────────────────────────── */}
            <Panel
                title="Entorno de la AEAT"
                subtitle="A dónde se mandan las facturas. Producción es el de verdad."
            >
                <div className="flex flex-wrap gap-2">
                    {(["produccion", "pruebas"] as const).map((v) => {
                        const activo = entorno === v;
                        return (
                            <button
                                key={v}
                                type="button"
                                onClick={() =>
                                    activo ? undefined : setConfirmandoEntorno(v)
                                }
                                className={cn(
                                    "rounded-2xl border px-4 py-3 text-left text-sm transition",
                                    activo
                                        ? v === "pruebas"
                                            ? "border-amber-500/50 bg-amber-500/15 font-semibold text-amber-700 dark:text-amber-300"
                                            : "border-accent/40 bg-accent-soft font-semibold text-accent"
                                        : "border-border bg-surface-2 text-fg hover:bg-surface",
                                )}
                            >
                                <div>{v === "produccion" ? "Producción" : "Pruebas"}</div>
                                <div className="mt-0.5 text-xs font-normal text-fg-muted">
                                    {v === "produccion"
                                        ? "Las facturas cuentan. Es lo que tiene que estar puesto en un bar"
                                        : "Preproducción de la AEAT. Para ensayar sin que nada cuente"}
                                </div>
                            </button>
                        );
                    })}
                </div>

                {confirmandoEntorno === "pruebas" ? (
                    <div className="mt-3 rounded-2xl border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm">
                        <p className="font-semibold text-amber-700 dark:text-amber-300">
                            Pasar a pruebas deja de emitir facturas válidas.
                        </p>
                        <p className="mt-1 text-fg-muted">
                            Todo lo que se cobre a partir de ahora irá a la preproducción de la AEAT:
                            el QR del ticket llevará al portal de pruebas y esas facturas{" "}
                            <strong>no constan en Hacienda</strong>. No hagas esto en un negocio que
                            esté vendiendo.
                        </p>
                        <div className="mt-3 flex gap-2">
                            <PrimaryButton
                                onClick={() => {
                                    setMany({ verifactuEntorno: "pruebas" });
                                    setConfirmandoEntorno(null);
                                    refrescarEstado();
                                    toast.info(
                                        "Entorno de pruebas",
                                        "Las facturas que se emitan ahora no son reales.",
                                    );
                                }}
                            >
                                Entiendo, pasar a pruebas
                            </PrimaryButton>
                            <GhostButton onClick={() => setConfirmandoEntorno(null)}>
                                Cancelar
                            </GhostButton>
                        </div>
                    </div>
                ) : null}

                {confirmandoEntorno === "produccion" ? (
                    <div className="mt-3 rounded-2xl border border-accent/40 bg-accent-soft px-4 py-3 text-sm">
                        <p className="font-semibold">Pasar a producción empieza a facturar de verdad.</p>
                        <p className="mt-1 text-fg-muted">
                            Desde ese momento cada cobro es una factura que consta en Hacienda y que{" "}
                            <strong>no se puede borrar</strong>: como mucho se anula con otro
                            registro, que también queda.
                        </p>
                        {estado && estado.total_registros > 0 ? (
                            <p className="mt-2 rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-2 text-red-600 dark:text-red-400">
                                <strong>
                                    Este equipo ya ha emitido {estado.total_registros} registro(s).
                                </strong>{" "}
                                Si se emitieron ensayando contra preproducción, Hacienda no los tiene,
                                y la cadena de huellas continuaría desde un eslabón que ella no
                                conoce. Antes de facturar de verdad hay que partir de cero: ver{" "}
                                <code>docs/PRUEBAS_AEAT.md</code>.
                            </p>
                        ) : null}
                        <div className="mt-3 flex gap-2">
                            <PrimaryButton
                                onClick={() => {
                                    setMany({ verifactuEntorno: "produccion" });
                                    setConfirmandoEntorno(null);
                                    refrescarEstado();
                                    toast.success(
                                        "Entorno de producción",
                                        "Las facturas que se emitan ahora son reales.",
                                    );
                                }}
                            >
                                Entiendo, pasar a producción
                            </PrimaryButton>
                            <GhostButton onClick={() => setConfirmandoEntorno(null)}>
                                Cancelar
                            </GhostButton>
                        </div>
                    </div>
                ) : null}

                <div className="mt-3 text-xs text-fg-muted">
                    Los dos endpoints se distinguen en tres caracteres (<code>prewww1</code> frente a{" "}
                    <code>www1</code>), así que esto no se decide por un ajuste escondido: se elige
                    aquí, se confirma, y el panel de arriba lo repite en amarillo mientras esté en
                    pruebas.
                </div>
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

            {/* ── Exportación (art. 8 RRSIF) ──────────────────────────────────────────────── */}
            <Panel
                title="Exportar los registros de facturación"
                subtitle="Lo que hay que poder entregar si lo piden. No es una copia de seguridad."
            >
                <div className="grid gap-4 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
                    <Field label="Desde">
                        <TextInput
                            type="date"
                            value={desde}
                            max={hasta}
                            onChange={(e) => setDesde(e.target.value)}
                            className={inputTone}
                        />
                    </Field>
                    <Field label="Hasta">
                        <TextInput
                            type="date"
                            value={hasta}
                            min={desde}
                            onChange={(e) => setHasta(e.target.value)}
                            className={inputTone}
                        />
                    </Field>
                    <PrimaryButton
                        onClick={() => void exportar()}
                        disabled={exportando || !desde || !hasta || desde > hasta}
                    >
                        {exportando ? "Exportando…" : "Exportar…"}
                    </PrimaryButton>
                </div>

                <div className="mt-3 rounded-xl border border-border bg-surface-2 px-3 py-3 text-xs text-fg-muted">
                    Sale un <code>.zip</code> con cuatro ficheros, y el que de verdad importa es{" "}
                    <code>cadena.txt</code>: lleva, registro a registro, el texto exacto del que se
                    calculó su huella.{" "}
                    <strong>
                        Con eso cualquiera puede recalcular las huellas con un SHA-256 y comprobar
                        que la cadena no se ha tocado, sin este programa y sin fiarse de nosotros
                    </strong>
                    . Los otros tres son el XML (el mismo formato que se remite a la AEAT), un CSV
                    para abrir con Excel y un manifiesto con quién exportó, cuándo y qué rango.
                </div>

                <div className="mt-2 text-xs text-fg-muted">
                    Esto <strong>no sustituye a las copias de seguridad</strong> (Configuración →
                    Conectividad): es un extracto de los registros fiscales, no la base de datos del
                    negocio.
                </div>
            </Panel>

            {/* ── Declaración responsable (art. 13 RRSIF) ─────────────────────────────────── */}
            <Panel
                title="Declaración responsable del programa"
                subtitle="Lo que el fabricante de este software declara ante la AEAT."
                right={
                    dr ? (
                        <GhostButton onClick={() => setVerDr((v) => !v)}>
                            {verDr ? "Ocultar" : "Leerla"}
                        </GhostButton>
                    ) : null
                }
            >
                {dr === null ? (
                    <div className="text-sm text-fg-muted">Cargando…</div>
                ) : (
                    <>
                        <div className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
                            <div>
                                <span className="text-fg-muted">Sistema: </span>
                                <strong>{dr.nombre_sistema}</strong>{" "}
                                <span className="text-fg-muted">({dr.id_sistema})</span>
                            </div>
                            <div>
                                <span className="text-fg-muted">Versión: </span>
                                <strong>{dr.version}</strong>
                            </div>
                            <div className="sm:col-span-2">
                                <span className="text-fg-muted">Productor: </span>
                                <strong>{dr.productor_nombre_razon || "—"}</strong>
                                {dr.productor_nif ? (
                                    <span className="text-fg-muted"> · {dr.productor_nif}</span>
                                ) : null}
                            </div>
                        </div>

                        {!dr.completa ? (
                            <div className="mt-3 rounded-xl border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-300">
                                <strong>Pendiente de completar.</strong> Faltan los datos
                                identificativos definitivos del productor del software. Esto tiene
                                que estar resuelto antes de emitir una sola factura real: el art. 13
                                del RD 1007/2023 exige que la declaración figure en el propio
                                sistema, y una declaración a medias no es una declaración.
                            </div>
                        ) : null}

                        {verDr && dr.texto ? (
                            <pre className="mt-3 max-h-80 overflow-auto whitespace-pre-wrap rounded-xl border border-border bg-surface-2 px-3 py-3 text-xs leading-relaxed text-fg">
                                {dr.texto}
                            </pre>
                        ) : null}

                        <div className="mt-3 text-xs text-fg-muted">
                            Va aquí porque la norma pide que se pueda leer{" "}
                            <em>
                                «en el propio sistema informático, visible en cada una de sus
                                versiones»
                            </em>
                            . La versión que se lee arriba es la de este programa, no un número
                            escrito a mano.
                        </div>
                    </>
                )}
            </Panel>
        </div>
    );
}
