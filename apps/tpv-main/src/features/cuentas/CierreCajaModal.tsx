import { commands } from "@tpv/client";
// src/features/cuentas/CierreCajaModal.tsx
//
// El cierre de caja (arqueo). CUENTA-06.
//
// Cuatro pasos, en el orden en que se hace de verdad: mirar qué debería haber, contar el cajón, ver
// la diferencia y decidir qué se deja para mañana. Sustituye a la antigua "Entrada de Caja", que era
// el mismo contador sin guardar nada.
//
// Lo que esta pantalla NO hace, a propósito: decidir. Enseña el descuadre y pide una explicación
// cuando es grande, pero no impide cerrar ni corrige nada. El programa no puede saber si el dinero
// está en el cajón; sólo registra lo que alguien declara.

import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, Coins, Wallet, X } from "lucide-react";

import type { BackfillEstado } from "@tpv/contracts";

import { ModalShell } from "../../shared/ui";
import { CampoDinero, useImporte } from "../../shared/ui/CampoDinero";
import { cn } from "../../shared/lib/cn";
import { esError, toAppError } from "@tpv/client";

import DenomsGrid from "./DenomsGrid";
import {
    aDenominaciones,
    cierreConfirmar,
    textoSinCobrar,
    type CierreDto,
    type PreparacionCierreDto,
} from "./cierreApis";
import {
    decCash,
    DEFAULT_DENOMS,
    incCash,
    resetCash,
    type CashCount,
} from "./cuentasApis";
import { conAviso } from "../../shared/lib/conAviso";
import { CERO, abs, deCentimos, eur } from "../../shared/lib/dinero";
import {
    calcularArqueo,
    exigeMotivo as descuadreExigeMotivo,
    totalRecuento,
    validarCierre,
} from "../../shared/lib/efectivo";

type Props = {
    open: boolean;
    onClose: () => void;
    /** Se llama cuando el cierre se guarda, para que la pantalla recargue lo que dependa de él. */
    onCerrado?: (cierre: CierreDto) => void;
};

export default function CierreCajaModal({ open, onClose, onCerrado }: Props) {
    const denoms = DEFAULT_DENOMS;

    const [prep, setPrep] = useState<PreparacionCierreDto | null>(null);
    const [cargando, setCargando] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [guardando, setGuardando] = useState(false);

    const [contado, setContado] = useState<CashCount>({});
    const [dejado, setDejado] = useState<CashCount>({});
    const [motivo, setMotivo] = useState("");
    // RI-58: el id del cierre nace al abrir el arqueo y se reutiliza en cada intento de confirmar,
    // así que un doble clic o un reintento tras un error devuelven el mismo cierre en vez de crear
    // otro con el periodo vacío.
    const [idCierre, setIdCierre] = useState(() => crypto.randomUUID());
    // Sólo se usa en el primer cierre: después lo manda el `dejado` del anterior.
    const fondoInicial = useImporte();
    const ponerFondo = fondoInicial.poner;

    useEffect(() => {
        if (!open) return;
        let vivo = true;
        setCargando(true);
        setError(null);
        setContado({});
        setDejado({});
        setMotivo("");
        setIdCierre(crypto.randomUUID());
        ponerFondo(null);
        commands.cierrePreparar()
            .then((p) => {
                if (vivo) setPrep(p);
            })
            .catch((e) => {
                if (vivo) setError(toAppError(e).message);
            })
            .finally(() => {
                if (vivo) setCargando(false);
            });
        return () => {
            vivo = false;
        };
    }, [open, ponerFondo]);

    const totalContado = useMemo(() => totalRecuento(denoms, contado), [denoms, contado]);
    const totalDejado = useMemo(() => totalRecuento(denoms, dejado), [denoms, dejado]);

    // Sólo cuenta en el primer cierre. Lo que no se entiende como importe bloquea el cierre: antes
    // valía 0 sin avisar y se guardaba como fondo, el primer eslabón de todos los cierres. No
    // escribir nada, en cambio, es no haber empezado con nada.
    const fondoIlegible = !!prep?.es_primer_cierre && !fondoInicial.legible;

    const fondo = useMemo(() => {
        if (!prep) return CERO;
        if (!prep.es_primer_cierre) return prep.fondo_inicial;
        return fondoInicial.valor ?? CERO;
    }, [prep, fondoInicial.valor]);

    // La misma cuenta que hará Rust al confirmar (`tpv_domain::cierre_caja::calcular`): lo que se
    // enseña aquí es lo que se va a guardar.
    const arqueo = useMemo(
        () =>
            calcularArqueo({
                fondoInicial: fondo,
                ventasEfectivo: prep?.ventas_efectivo ?? CERO,
                gastosCaja: prep?.gastos_caja ?? CERO,
                contado: totalContado,
                dejado: totalDejado,
            }),
        [fondo, prep, totalContado, totalDejado],
    );
    const { esperado, descuadre, retirado } = arqueo;

    // CAJ-INC-04: sólo lo que de verdad queda por cobrar, con las mesas y la barra por separado.
    const sinCobrar = prep ? textoSinCobrar(prep.mesas_sin_cobrar, prep.tickets_sin_cobrar) : null;

    const umbral = prep?.umbral_descuadre ?? deCentimos(500);
    const exigeMotivo = descuadreExigeMotivo(descuadre, umbral);
    const dejaDeMas = arqueo.dejado > arqueo.contado;

    const puedeCerrar =
        !!prep && !guardando && !fondoIlegible && validarCierre(arqueo, motivo, umbral) === null;

    async function confirmar() {
        if (!puedeCerrar || !prep) return;
        setGuardando(true);
        setError(null);
        try {
            const cierre = await cierreConfirmar({
                idCierre,
                fondoInicial: prep.es_primer_cierre ? fondo : null,
                contado: aDenominaciones(denoms, contado),
                dejado: aDenominaciones(denoms, dejado),
                motivo: motivo,
                esperadoVisto: esperado,
            });
            onCerrado?.(cierre);
            onClose();
        } catch (e) {
            setError(toAppError(e).message);
            // CAJ-INC-01: algo entró o salió del cajón mientras se contaba. Se vuelve a preparar,
            // sin perder el recuento, para que el descuadre se mire contra la cifra buena.
            if (esError(e, "conflict")) {
                try {
                    setPrep(await commands.cierrePreparar());
                } catch (e2) {
                    setError(toAppError(e2).message);
                }
            }
        } finally {
            setGuardando(false);
        }
    }

    return (
        <ModalShell
            open={open}
            onClose={onClose}
            className="fixed inset-0 z-50 flex items-center justify-center p-2 sm:p-4"
        >
            <div className="absolute inset-0 bg-black/50 backdrop-blur-[2px]" onClick={onClose} />

            {/* El ancho lo fija la medida común de las modales (Global.css); ésta la amplía. El
                alto, todo el que deje la pantalla: el recuento es largo y así cabe más sin desplazar. */}
            <div className="relative flex h-full [--modal-width:73.5rem] flex-col overflow-hidden rounded-3xl border border-border bg-surface shadow-2xl">
                <div className="flex shrink-0 items-start justify-between gap-3 border-b border-border bg-surface px-4 py-4 sm:px-6">
                    <div className="flex min-w-0 items-center gap-3">
                        <div className="grid size-11 shrink-0 place-items-center rounded-2xl bg-accent-soft text-accent">
                            <Wallet className="size-6" aria-hidden />
                        </div>
                        <div className="min-w-0">
                            <h3 className="text-xl font-extrabold text-fg">Cerrar caja</h3>
                            {/* Sólo con la preparación cargada: sin ella no se sabe si hay un cierre
                                anterior, y decir «primer cierre» cuando ha fallado confunde. */}
                            {prep ? (
                                <p className="mt-0.5 text-sm text-fg-muted">
                                    {prep.desde
                                        ? `Desde el último cierre (${prep.desde})`
                                        : "Primer cierre: no hay ninguno anterior"}
                                </p>
                            ) : null}
                        </div>
                    </div>

                    <button
                        type="button"
                        onClick={onClose}
                        className="grid size-10 shrink-0 cursor-pointer place-items-center rounded-2xl border border-border bg-surface text-fg-muted transition hover:bg-surface-2 hover:text-fg active:scale-[0.98]"
                        title="Cerrar"
                    >
                        <X className="size-4" aria-hidden />
                    </button>
                </div>

                <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-4 sm:p-6">
                    {cargando ? (
                        <p className="text-sm text-fg-muted">Calculando lo que debería haber…</p>
                    ) : !prep ? (
                        <p className="text-sm text-danger">{error ?? "No se pudo preparar el cierre."}</p>
                    ) : (
                        <>
                            {/* 1 · Qué debería haber */}
                            <div className="mb-4 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
                                <Tarjeta titulo="Fondo de partida" valor={fondoIlegible ? "—" : eur(fondo)}>
                                    {prep.es_primer_cierre
                                        ? "Es el primer cierre: dinos con cuánto empezaste."
                                        : "Lo que dejaste en el último cierre."}
                                </Tarjeta>
                                <Tarjeta titulo="Cobrado en efectivo" valor={eur(prep.ventas_efectivo)}>
                                    Desde el cierre anterior. La tarjeta la cuadra el banco.
                                </Tarjeta>
                                <Tarjeta titulo="Gastos pagados con caja" valor={eur(prep.gastos_caja)}>
                                    Los gastos marcados como pagados con dinero del cajón.
                                </Tarjeta>
                                <Tarjeta
                                    titulo="Debería haber"
                                    valor={fondoIlegible ? "—" : eur(esperado)}
                                    destacada
                                >
                                    Fondo más lo cobrado en efectivo, menos los gastos pagados con caja.
                                </Tarjeta>
                            </div>

                            {prep.es_primer_cierre ? (
                                <label className="mb-4 flex flex-col gap-1 sm:max-w-xs">
                                    <span className="text-xs font-semibold text-fg-muted">
                                        ¿Con cuánto empezaste? (sólo se pregunta esta vez)
                                    </span>
                                    <CampoDinero
                                        {...fondoInicial.campo}
                                        placeholder="150"
                                        className="h-10 rounded-xl border border-border bg-surface px-3 text-sm text-fg outline-none focus:border-accent"
                                    />
                                </label>
                            ) : null}

                            {prep.anulaciones > 0 ? (
                                <Aviso>
                                    Se {prep.anulaciones === 1 ? "ha anulado" : "han anulado"}{" "}
                                    <strong>
                                        {prep.anulaciones}{" "}
                                        {prep.anulaciones === 1 ? "cobro" : "cobros"} por{" "}
                                        {eur(prep.anulaciones_importe)}
                                    </strong>{" "}
                                    en este periodo. No están contados arriba —un cobro anulado no es una
                                    venta—, así que si ese dinero salió del cajón, el recuento lo dirá.
                                </Aviso>
                            ) : null}

                            {sinCobrar ? (
                                <Aviso>
                                    Hay {sinCobrar}. Su cobro entrará en el próximo cierre. Puedes
                                    cerrar igualmente.
                                </Aviso>
                            ) : null}

                            {/* DO-02: tras una recuperación que no cabía entera, lo de este periodo
                                puede estar bajando todavía. Se avisa; no se impide cerrar. */}
                            {prep.historico_pendiente ? (
                                <AvisoHistoricoPendiente
                                    historico={prep.historico_pendiente}
                                    esPrimerCierre={prep.es_primer_cierre}
                                />
                            ) : null}

                            <Aviso tono="info">
                                Esta caja cuenta las <strong>ventas en efectivo</strong> y los <strong>gastos pagados con
                                dinero del cajón</strong>. Si has sacado dinero para otra cosa, apúntalo como gasto pagado
                                con caja o explícalo en el motivo: si no, aquí saldrá como que falta.
                            </Aviso>

                            {/* 2 y 4 · Los dos recuentos */}
                            <div className="mt-4 grid min-w-0 grid-cols-1 gap-4 xl:grid-cols-2">
                                <DenomsGrid
                                    title="1 · Cuenta el cajón"
                                    subtitle="Todo lo que hay dentro ahora mismo."
                                    denoms={denoms}
                                    count={contado}
                                    total={totalContado}
                                    onAdd={(l) => setContado((p) => incCash(p, l))}
                                    onRemove={(l) => setContado((p) => decCash(p, l))}
                                    onReset={() => setContado(resetCash())}
                                />
                                <DenomsGrid
                                    title="2 · Qué dejas para mañana"
                                    subtitle="Será el fondo de partida del próximo cierre."
                                    denoms={denoms}
                                    count={dejado}
                                    total={totalDejado}
                                    onAdd={(l) => setDejado((p) => incCash(p, l))}
                                    onRemove={(l) => setDejado((p) => decCash(p, l))}
                                    onReset={() => setDejado(resetCash())}
                                />
                            </div>

                            {/* 3 · El descuadre */}
                            <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
                                <div
                                    className={cn(
                                        "rounded-2xl border p-4",
                                        descuadre === 0
                                            ? "border-success/30 bg-success-soft"
                                            : "border-danger/30 bg-danger-soft",
                                    )}
                                >
                                    <p className="text-xs font-semibold text-fg-muted">Diferencia</p>
                                    <p
                                        className={cn(
                                            "mt-1 text-2xl font-extrabold",
                                            descuadre === 0 ? "text-success" : "text-danger",
                                        )}
                                    >
                                        {fondoIlegible
                                            ? "—"
                                            : descuadre === 0
                                              ? "Cuadra"
                                              : descuadre < 0
                                                ? `Faltan ${eur(abs(descuadre))}`
                                                : `Sobran ${eur(descuadre)}`}
                                    </p>
                                    <p className="mt-2 text-xs text-fg-muted">
                                        {fondoIlegible
                                            ? "Falta saber con cuánto empezaste."
                                            : `Contado ${eur(totalContado)} frente a ${eur(esperado)} esperados.`}
                                    </p>
                                </div>

                                <Tarjeta titulo="Te llevas" valor={eur(retirado)}>
                                    Lo contado menos lo que dejas en el cajón.
                                </Tarjeta>
                            </div>

                            {dejaDeMas ? (
                                <Aviso tono="error">
                                    No puedes dejar en el cajón más de lo que has contado.
                                </Aviso>
                            ) : null}

                            <label className="mt-4 flex flex-col gap-1">
                                <span className="text-xs font-semibold text-fg-muted">
                                    Motivo {exigeMotivo ? "(obligatorio: la diferencia pasa de " + eur(umbral) + ")" : "(opcional)"}
                                </span>
                                <textarea
                                    rows={2}
                                    value={motivo}
                                    onChange={(e) => setMotivo(e.target.value)}
                                    placeholder="Se pagó un pedido en efectivo, faltaba cambio…"
                                    className={cn(
                                        "rounded-xl border bg-surface px-3 py-2 text-sm text-fg outline-none focus:border-accent",
                                        exigeMotivo && !motivo.trim() ? "border-danger" : "border-border",
                                    )}
                                />
                            </label>

                            {error ? <p className="mt-3 text-sm text-danger">{error}</p> : null}
                        </>
                    )}
                </div>

                <div className="flex shrink-0 items-center justify-end gap-2 border-t border-border bg-surface px-4 py-3 sm:px-6">
                    <button
                        type="button"
                        onClick={onClose}
                        className="h-10 rounded-xl border border-border bg-surface px-4 text-sm font-semibold text-fg transition hover:bg-surface-2 active:scale-[0.98]"
                    >
                        Cancelar
                    </button>
                    <button
                        type="button"
                        onClick={conAviso(confirmar)}
                        disabled={!puedeCerrar}
                        className={cn(
                            "h-10 rounded-xl bg-accent px-4 text-sm font-bold text-accent-fg shadow-sm transition active:scale-[0.98]",
                            !puedeCerrar && "cursor-not-allowed opacity-50",
                        )}
                    >
                        {guardando ? "Cerrando…" : "Cerrar caja"}
                    </button>
                </div>
            </div>
        </ModalShell>
    );
}

function Tarjeta({
    titulo,
    valor,
    destacada,
    children,
}: {
    titulo: string;
    valor: string;
    destacada?: boolean;
    children?: React.ReactNode;
}) {
    return (
        <div
            className={cn(
                "rounded-2xl border p-4",
                destacada ? "border-accent/30 bg-accent-soft" : "border-border bg-surface-2",
            )}
        >
            <p className="flex items-center gap-1.5 text-xs font-semibold text-fg-muted">
                <Coins className="size-4 text-accent" aria-hidden />
                {titulo}
            </p>
            <p className="mt-1 text-2xl font-extrabold text-fg">{valor}</p>
            {children ? <p className="mt-2 text-xs text-fg-muted">{children}</p> : null}
        </div>
    );
}

/**
 * DO-02: tras una recuperación, lo que suma este arqueo (desde el último cierre o, en el primero,
 * desde el principio) puede estar todavía bajando: lo cobrado en efectivo puede salir corto. Con el
 * progreso, para que se pueda decidir si esperar.
 */
function AvisoHistoricoPendiente({
    historico,
    esPrimerCierre,
}: {
    historico: BackfillEstado;
    esPrimerCierre: boolean;
}) {
    const total = historico.tablas_pendientes + historico.tablas_completadas;
    const pct = total > 0 ? Math.round((historico.tablas_completadas / total) * 100) : 0;
    return (
        <Aviso>
            <strong>Todavía se está descargando el histórico de antes de recuperar los datos</strong> (
            {historico.tablas_completadas} de {total} apartados · {pct} %). «Cobrado en efectivo» suma
            desde {esPrimerCierre ? "el principio" : "el último cierre"} y sólo cuenta lo que ya ha
            bajado: el recuento puede salir incompleto hasta que termine. Puedes cerrar igualmente o
            esperar a que acabe.
        </Aviso>
    );
}

function Aviso({
    children,
    tono = "aviso",
}: {
    children: React.ReactNode;
    tono?: "aviso" | "info" | "error";
}) {
    return (
        <div
            className={cn(
                "mt-3 flex items-start gap-2 rounded-2xl border px-4 py-2 text-xs",
                tono === "error"
                    ? "border-danger/30 bg-danger-soft text-danger"
                    : tono === "info"
                      ? "border-border bg-surface-2 text-fg-muted"
                      : "border-warning/30 bg-warning-soft text-warning",
            )}
        >
            <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
            <span>{children}</span>
        </div>
    );
}
