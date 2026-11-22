// src/shared/ticket/DatosFiscalesModal.tsx
//
// Los datos del cliente para emitir una FACTURA COMPLETA (FISCAL-02).
//
// Se llega aquí por dos caminos y el texto de arriba lo dice, porque no son lo mismo:
//
//   · El cliente la pide («Factura con NIF»). Es voluntario y se puede cancelar.
//   · El importe pasa del límite de la factura simplificada —3.000 € con IVA en hostelería, art. 4.2
//     RD 1619/2012— y entonces **no hay alternativa**: por encima de esa cifra no cabe un ticket, así
//     que sin estos datos no se puede cobrar. Cancelar aquí vuelve al cobro sin hacer nada, que es
//     lo correcto: el cliente puede ir a buscar el NIF.
//
// El NIF se valida al escribir, con el dígito de control. No es un lujo: un NIF mal dictado **no**
// se rechaza al enviar — vuelve como «error admisible: NIF no censado» horas después, sin el cliente
// delante y con una subsanación que alguien tiene que disparar a mano.
//
// En la Main, el formulario conoce las fichas de cliente (`clientes_para_factura`): «Elegir cliente»
// rellena los tres campos con los de una ficha, un NIF que es el de una ficha ofrece rellenar con
// sus datos, y el nombre que se teclea sugiere las fichas que casan. La casilla «Guardar en la ficha
// del cliente» guarda los datos con los que se factura, pero DESPUÉS: sólo si `onConfirmar` dice que
// el cobro o la emisión han entrado (devuelve `true`), y si falla sólo se avisa
// (`fichaFiscal.ts`, `trasFacturar`). La Handy no cobra, y allí no aparece nada de esto.

import React, { useEffect, useMemo, useRef, useState } from "react";

import { ModalShell } from "../ui/ModalShell";
import { nifValido } from "./nif";
import type { DestinatarioInput, Dinero } from "@tpv/contracts";
import { eur } from "../lib/dinero";
import { useMode } from "../stores/useMode";
import {
    buscarFichas,
    camposSinLaFicha,
    fichaConNif,
    fichaDestino,
    guardarPorDefecto,
    mismosDatos,
    planDeGuardado,
    rellenoConFicha,
    sirveParaFacturar,
    sugerenciasPorNombre,
    trasFacturar,
    type CamposFiscales,
    type ClienteParaFactura,
} from "../../features/clientes/fichaFiscal";
import {
    useClientesParaFactura,
    useGuardarDatosFiscales,
} from "../../features/clientes/clientesQueries";

type Props = {
    open: boolean;
    onClose: () => void;
    /**
     * Cobra o emite con estos datos. Devuelve `true` si ha entrado: sólo entonces se guardan en la
     * ficha del cliente (si la casilla está marcada). Cualquier otra cosa es que no ha entrado.
     */
    onConfirmar: (d: DestinatarioInput) => boolean | void | Promise<boolean | void>;
    importe: Dinero;
    limite: Dinero;
    /** `true` cuando el importe OBLIGA a facturar (no es una elección del cliente). */
    obligatorio: boolean;
    guardando?: boolean;
    error?: string | null;
    /** Datos de partida, si el cobro es de un cliente con ficha. */
    inicial?: Partial<DestinatarioInput> | null;
    /**
     * La comanda que se cobra. Si su cliente (el de su reserva) tiene ficha con NIF, el formulario
     * empieza con sus datos cuando no trae otros (`inicial`).
     */
    idComanda?: string | null;
    /**
     * El número de la factura completa que se corrige. Una factura expedida no se modifica: se
     * corrige emitiendo otra (FISCAL-02), y el formulario lo dice.
     */
    corrigiendo?: string | null;
    /**
     * Lo que dice el botón, y mientras se hace. «Cobrar y facturar» es lo del TPV, que cobra a la
     * vez; desde Cuentas el cobro ya está hecho y se emite o se corrige la factura.
     */
    accion?: { texto: string; enCurso: string };
};

export default function DatosFiscalesModal(props: Props) {
    // Cerrado no se monta: así se empieza de cero cada vez y las fichas sólo se piden al abrirlo.
    if (!props.open) return null;
    return <Formulario {...props} />;
}

const CAMPO =
    "mt-1 h-10 w-full rounded-xl border border-border bg-surface px-3 text-sm text-fg outline-none focus:border-primary";
const BOTON_SECUNDARIO =
    "cursor-pointer rounded-xl border border-border bg-surface px-3 py-1.5 text-xs font-semibold text-fg hover:bg-surface-2";

function Formulario({
    open,
    onClose,
    onConfirmar,
    importe,
    limite,
    obligatorio,
    guardando = false,
    error = null,
    inicial,
    idComanda = null,
    corrigiendo = null,
    accion = { texto: "Cobrar y facturar", enCurso: "Cobrando…" },
}: Props) {
    const [nombre, setNombre] = useState(inicial?.nombre_razon ?? "");
    const [nif, setNif] = useState(inicial?.nif ?? "");
    const [domicilio, setDomicilio] = useState(inicial?.domicilio ?? "");
    const [tocadoNif, setTocadoNif] = useState(false);
    const primerCampo = useRef<HTMLInputElement | null>(null);

    // ── Las fichas (sólo en la Main, que es la que cobra) ──────────────────────────────────────
    const esMain = useMode((st) => st.mode) === "tpv";
    const fichasQuery = useClientesParaFactura(idComanda, esMain);
    const fichas = useMemo(() => fichasQuery.data?.clientes ?? [], [fichasQuery.data]);
    const conFichas = esMain && fichasQuery.isSuccess;
    const guardarEnFicha = useGuardarDatosFiscales();

    const [elegida, setElegida] = useState<ClienteParaFactura | null>(null);
    /** Lo que había escrito antes de elegir la ficha: vuelve con «No es esta ficha». */
    const [antesDeLaFicha, setAntesDeLaFicha] = useState<CamposFiscales | null>(null);
    const [buscador, setBuscador] = useState<string | null>(null);
    /** `null` = lo que toque por defecto (`guardarPorDefecto`); si se toca la casilla, lo elegido. */
    const [guardarFicha, setGuardarFicha] = useState<boolean | null>(null);

    useEffect(() => {
        setNombre(inicial?.nombre_razon ?? "");
        setNif(inicial?.nif ?? "");
        setDomicilio(inicial?.domicilio ?? "");
        setTocadoNif(false);
        // El foco al primer campo: esto se abre a mitad de un cobro y hay alguien esperando.
        const t = setTimeout(() => primerCampo.current?.focus(), 50);
        return () => clearTimeout(t);
    }, [inicial?.nombre_razon, inicial?.nif, inicial?.domicilio]);

    /**
     * Rellena con los datos de una ficha. Sobre lo escrito a mano, lo que la ficha no tiene se deja
     * como estaba; si antes se había elegido otra, se sustituye todo (`rellenoConFicha`).
     */
    function rellenar(f: ClienteParaFactura) {
        const r = rellenoConFicha({ nombre, nif, domicilio }, f, elegida != null);
        if (elegida == null) setAntesDeLaFicha({ nombre, nif, domicilio });
        setNombre(r.nombre);
        setNif(r.nif);
        setDomicilio(r.domicilio);
        setElegida(f);
        setBuscador(null);
        setGuardarFicha(null);
    }

    /**
     * La ficha elegida no es la del cliente: deja de estar elegida y se lleva lo que puso en el
     * formulario (`camposSinLaFicha`), para que elegir otra no la mezcle con la primera.
     */
    function noEsEstaFicha() {
        if (elegida) {
            const r = camposSinLaFicha(
                { nombre, nif, domicilio },
                antesDeLaFicha ?? { nombre: "", nif: "", domicilio: "" },
                elegida,
            );
            setNombre(r.nombre);
            setNif(r.nif);
            setDomicilio(r.domicilio);
        }
        setElegida(null);
        setAntesDeLaFicha(null);
        setGuardarFicha(null);
    }

    // El cliente de la comanda (el de su reserva), si tiene ficha con NIF y el formulario no trae
    // otros datos ni se ha empezado a escribir. Una sola vez: las fichas llegan después de abrir.
    const empezadoConLaComanda = useRef(false);
    useEffect(() => {
        if (empezadoConLaComanda.current || !fichasQuery.data) return;
        empezadoConLaComanda.current = true;
        const id = fichasQuery.data.id_cliente_de_la_comanda;
        const suya = fichas.find((f) => f.id_cliente === id);
        if (!sirveParaFacturar(suya) || inicial?.nif || nombre.trim() || nif.trim()) return;
        rellenar(suya);
        // Sólo al llegar las fichas: lo que ya se haya escrito manda, y se mira dentro.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [fichasQuery.data]);

    const nifOk = useMemo(() => nifValido(nif), [nif]);
    const puede = nombre.trim().length > 0 && nifOk && !guardando;

    const actuales: DestinatarioInput = {
        nombre_razon: nombre.trim(),
        nif: nif.trim().toUpperCase(),
        domicilio: domicilio.trim() || undefined,
    };
    const coincidente = useMemo(() => (conFichas ? fichaConNif(fichas, nif) : null), [conFichas, fichas, nif]);
    const destino = fichaDestino(elegida, coincidente, nif);
    /** La ficha elegida no es donde se guardaría: el NIF es de otra, o no es el suyo. */
    const noEsLaElegida = elegida != null && destino?.id_cliente !== elegida.id_cliente;
    const ofrecerCoincidente =
        coincidente != null &&
        coincidente.id_cliente !== elegida?.id_cliente &&
        !mismosDatos(actuales, coincidente);
    // La ficha ya elegida no se sugiere: está arriba, y pulsarla volvería a poner su NIF encima del
    // que se acaba de escribir.
    const sugerencias = useMemo(
        () =>
            conFichas && destino == null
                ? sugerenciasPorNombre(fichas, nombre, elegida?.id_cliente ?? null)
                : [],
        [conFichas, destino, fichas, nombre, elegida],
    );
    const encontradas = useMemo(
        () => (buscador != null ? buscarFichas(fichas, buscador) : []),
        [buscador, fichas],
    );
    const marcada = guardarFicha ?? guardarPorDefecto(actuales, destino);

    const confirmar = () => {
        const plan = conFichas && marcada ? planDeGuardado(actuales, destino) : null;
        void trasFacturar(async () => (await onConfirmar(actuales)) === true, plan, guardarEnFicha);
    };

    return (
        <ModalShell open={open} onClose={() => (guardando ? undefined : onClose())}>
            <div
                className="absolute inset-0 bg-black/40"
                onClick={() => (guardando ? null : onClose())}
            />
            <div className="relative max-h-[92vh] w-[520px] max-w-[92vw] overflow-y-auto rounded-3xl border border-border bg-surface p-6 shadow-xl">
                <div className="flex items-start justify-between gap-3">
                    <h3 className="text-lg font-semibold text-fg">
                        {corrigiendo
                            ? `Corregir el cliente de la factura ${corrigiendo}`
                            : obligatorio
                              ? "Este cobro necesita factura"
                              : "Factura con NIF"}
                    </h3>
                    {conFichas && fichas.length > 0 ? (
                        <button
                            type="button"
                            disabled={guardando}
                            onClick={() => setBuscador((b) => (b == null ? "" : null))}
                            className={`${BOTON_SECUNDARIO} shrink-0`}
                        >
                            Elegir cliente
                        </button>
                    ) : null}
                </div>
                <p className="mt-1 text-sm text-fg-muted">
                    {corrigiendo ? (
                        <>
                            Una factura ya expedida no se cambia: se emite otra con los datos
                            correctos que la corrige, con los mismos importes.
                        </>
                    ) : obligatorio ? (
                        <>
                            Son {eur(importe)}, y por encima de {eur(limite)} la ley no permite
                            entregar un ticket: hay que emitir una factura con los datos del cliente.{" "}
                            <strong>Sin ellos no se puede cobrar.</strong>
                        </>
                    ) : (
                        <>
                            Se emitirá una factura completa en lugar de un ticket. Pídele al cliente
                            el NIF y el nombre o la razón social.
                        </>
                    )}
                </p>

                {buscador != null ? (
                    <div className="mt-4 rounded-2xl border border-border bg-surface-2 p-3">
                        <input
                            type="text"
                            autoFocus
                            value={buscador}
                            onChange={(e) => setBuscador(e.target.value)}
                            placeholder="Nombre, razón social o NIF"
                            aria-label="Buscar cliente"
                            className={CAMPO}
                        />
                        {buscador.trim() && encontradas.length === 0 ? (
                            <p className="mt-2 text-xs text-fg-muted">Ninguna ficha coincide.</p>
                        ) : null}
                        <ul className="mt-2 flex flex-col gap-1">
                            {encontradas.map((f) => (
                                <li key={f.id_cliente}>
                                    <button
                                        type="button"
                                        onClick={() => rellenar(f)}
                                        className="w-full cursor-pointer rounded-xl px-3 py-2 text-left text-sm hover:bg-surface"
                                    >
                                        <span className="font-semibold text-fg">{f.nombre}</span>
                                        <span className="block text-xs text-fg-muted">
                                            {[f.razon_social !== f.nombre ? f.razon_social : null, f.nif ?? "Sin NIF"]
                                                .filter(Boolean)
                                                .join(" · ")}
                                        </span>
                                    </button>
                                </li>
                            ))}
                        </ul>
                    </div>
                ) : null}

                {elegida ? (
                    <p className="mt-3 flex items-center justify-between gap-2 text-xs text-fg-muted">
                        <span>
                            Ficha: <strong className="text-fg">{elegida.nombre}</strong>
                        </span>
                        <button
                            type="button"
                            disabled={guardando}
                            onClick={noEsEstaFicha}
                            className="cursor-pointer underline"
                        >
                            No es esta ficha
                        </button>
                    </p>
                ) : null}

                <label className="mt-4 block">
                    <span className="text-sm font-semibold text-fg">Nombre o razón social</span>
                    <input
                        ref={primerCampo}
                        type="text"
                        value={nombre}
                        onChange={(e) => setNombre(e.target.value)}
                        placeholder="Empresa Cliente SL"
                        maxLength={120}
                        disabled={guardando}
                        className={CAMPO}
                    />
                </label>
                {sugerencias.length > 0 ? (
                    <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-fg-muted">
                        <span>¿Es alguna de estas fichas?</span>
                        {sugerencias.map((f) => (
                            <button
                                key={f.id_cliente}
                                type="button"
                                disabled={guardando}
                                onClick={() => rellenar(f)}
                                className={BOTON_SECUNDARIO}
                            >
                                {f.nombre}
                                {f.nif ? ` · ${f.nif}` : ""}
                            </button>
                        ))}
                    </div>
                ) : null}

                <label className="mt-3 block">
                    <span className="text-sm font-semibold text-fg">NIF / CIF</span>
                    <input
                        type="text"
                        value={nif}
                        onChange={(e) => setNif(e.target.value.toUpperCase())}
                        onBlur={() => setTocadoNif(true)}
                        placeholder="B12345674"
                        disabled={guardando}
                        className={[
                            "mt-1 h-10 w-full rounded-xl border bg-surface px-3 text-sm text-fg outline-none",
                            tocadoNif && nif.trim() && !nifOk
                                ? "border-danger focus:border-danger"
                                : "border-border focus:border-primary",
                        ].join(" ")}
                    />
                    {tocadoNif && nif.trim() && !nifOk ? (
                        <span className="mt-1 block text-xs text-danger">
                            Ese NIF no es válido. Compruébalo con el cliente delante: una factura
                            con el NIF mal hay que rectificarla después.
                        </span>
                    ) : null}
                </label>
                {ofrecerCoincidente && coincidente ? (
                    <button
                        type="button"
                        disabled={guardando}
                        onClick={() => rellenar(coincidente)}
                        className="mt-2 w-full cursor-pointer rounded-xl border border-primary/40 bg-surface-2 px-3 py-2 text-left text-sm text-fg hover:bg-surface"
                    >
                        Es <strong>{coincidente.nombre}</strong>: rellenar con sus datos
                    </button>
                ) : null}

                <label className="mt-3 block">
                    <span className="text-sm font-semibold text-fg">
                        Domicilio <span className="font-normal text-fg-muted">(para el papel)</span>
                    </span>
                    <input
                        type="text"
                        value={domicilio}
                        onChange={(e) => setDomicilio(e.target.value)}
                        placeholder="Calle Mayor 1, 28013 Madrid"
                        maxLength={250}
                        disabled={guardando}
                        className={CAMPO}
                    />
                    <span className="mt-1 block text-xs text-fg-muted">
                        Una factura lo lleva por ley.
                    </span>
                </label>

                {conFichas ? (
                    <label className="mt-4 flex items-start gap-2 text-sm text-fg">
                        <input
                            type="checkbox"
                            checked={marcada}
                            disabled={guardando}
                            onChange={(e) => setGuardarFicha(e.target.checked)}
                            className="mt-0.5 size-4"
                        />
                        <span>
                            Guardar en la ficha del cliente
                            <span className="block text-xs text-fg-muted">
                                {destino
                                    ? `En la ficha de ${destino.nombre}, cuando la factura esté hecha.`
                                    : "En una ficha nueva con este nombre, cuando la factura esté hecha."}
                                {noEsLaElegida
                                    ? ` El NIF no es el de la ficha de ${elegida.nombre}: esa ficha no se cambia.`
                                    : null}
                            </span>
                        </span>
                    </label>
                ) : null}

                {error ? (
                    <div className="mt-3 rounded-2xl border border-danger/30 bg-danger-soft px-4 py-2 text-sm text-danger">
                        {error}
                    </div>
                ) : null}

                <div className="mt-6 flex items-center justify-end gap-2">
                    <button
                        type="button"
                        disabled={guardando}
                        onClick={onClose}
                        className={[
                            "h-10 rounded-xl border border-border bg-surface px-4 text-sm font-semibold text-fg shadow-sm",
                            "hover:bg-surface-2 active:scale-[0.97]",
                            guardando ? "cursor-not-allowed opacity-60" : "",
                        ].join(" ")}
                    >
                        {obligatorio ? "Volver al cobro" : "Cancelar"}
                    </button>
                    <button
                        type="button"
                        disabled={!puede}
                        onClick={confirmar}
                        className={[
                            "h-10 rounded-xl border border-primary bg-primary px-5 text-sm font-bold text-white shadow-sm",
                            "hover:opacity-90 active:scale-[0.97]",
                            !puede ? "cursor-not-allowed opacity-60" : "",
                        ].join(" ")}
                    >
                        {guardando ? accion.enCurso : accion.texto}
                    </button>
                </div>
            </div>
        </ModalShell>
    );
}
