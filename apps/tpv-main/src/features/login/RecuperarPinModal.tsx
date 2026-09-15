// src/features/login/RecuperarPinModal.tsx
//
// Recuperar el PIN de un administrador por correo (LOGIN-07).
//
// Dos pasos: pedir el código (llega al correo del titular de la licencia) y escribirlo aquí junto
// con el PIN nuevo. El código y el PIN viajan en la MISMA llamada: verificar y guardar son un solo
// comando en el backend, así que no hay un «ya he verificado, ahora guarda» que se pueda saltar.
//
// Sólo se ofrece a administradores y en la Main (lo decide `Login.tsx`, y el backend lo vuelve a
// comprobar). A un camarero le cambia el PIN un administrador desde Trabajadores.

import { useState } from "react";
import { KeyRound, Mail, X } from "lucide-react";
import { toAppError } from "@tpv/client";

import { Button, Input, ModalShell } from "../../shared/ui";
import { conAviso } from "../../shared/lib/conAviso";
import { formatoCuentaAtras, useCuentaAtras } from "../../shared/lib/useCuentaAtras";
import { confirmarCodigoPin, solicitarCodigoPin, type DbUser } from "./loginApi";

type Props = {
    usuario: DbUser;
    onCerrar: () => void;
    onRecuperado: () => void;
};

const soloCifras = (v: string, max: number) => v.replace(/\D/g, "").slice(0, max);

export default function RecuperarPinModal({ usuario, onCerrar, onRecuperado }: Props) {
    const [enviado, setEnviado] = useState<{ emailHint: string; minutos: number } | null>(null);
    const [codigo, setCodigo] = useState("");
    const [pin, setPin] = useState("");
    const [pin2, setPin2] = useState("");
    const [ocupado, setOcupado] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [reenvioHasta, setReenvioHasta] = useState<number | null>(null);
    const espera = useCuentaAtras(reenvioHasta);

    const cerrar = () => {
        if (!ocupado) onCerrar();
    };

    const pedirCodigo = async () => {
        setOcupado(true);
        setError(null);
        try {
            const r = await solicitarCodigoPin(usuario.id_usuario);
            setEnviado(r);
            setReenvioHasta(Date.now() + r.reenvioSegundos * 1000);
            setCodigo("");
        } catch (e) {
            setError(toAppError(e).message);
        } finally {
            setOcupado(false);
        }
    };

    const pinesCoinciden = pin.length > 0 && pin === pin2;
    const puedeConfirmar =
        !ocupado && codigo.length === 6 && pin.length >= 4 && pinesCoinciden;

    const confirmar = async () => {
        if (!puedeConfirmar) return;
        setOcupado(true);
        setError(null);
        try {
            await confirmarCodigoPin({
                idUsuario: usuario.id_usuario,
                codigo,
                pinNuevo: pin,
            });
            onRecuperado();
        } catch (e) {
            setError(toAppError(e).message);
            setOcupado(false);
        }
    };

    return (
        <ModalShell
            open
            onClose={cerrar}
            className="fixed inset-0 z-[70] flex items-center justify-center"
        >
            <div className="absolute inset-0 bg-black/40" onClick={cerrar} />

            <div className="relative w-[480px] max-w-[92vw] rounded-3xl border border-border bg-surface p-6 shadow-xl">
                <div className="flex items-start justify-between gap-3">
                    <div className="flex min-w-0 items-start gap-3">
                        <div className="grid size-10 shrink-0 place-items-center rounded-2xl bg-accent-soft text-accent">
                            <KeyRound className="size-5" aria-hidden />
                        </div>
                        <div className="min-w-0">
                            <h3 className="text-lg font-semibold text-fg">Recuperar el PIN</h3>
                            <p className="text-sm text-fg-muted">
                                De <span className="font-semibold text-fg">{usuario.nombre}</span>
                            </p>
                        </div>
                    </div>

                    <button
                        type="button"
                        className="grid size-9 cursor-pointer place-items-center rounded-xl border border-border bg-surface text-fg-muted transition hover:bg-surface-2 hover:text-fg"
                        onClick={cerrar}
                        title="Cancelar"
                    >
                        <X className="size-4" aria-hidden />
                    </button>
                </div>

                {!enviado ? (
                    <div className="mt-4 space-y-3 text-sm text-fg-muted">
                        <p>
                            Te enviaremos un código al correo de recuperación del TPV (el de la
                            compra, salvo que se haya cambiado). Con él podrás elegir un PIN nuevo.
                        </p>
                        <p className="text-xs text-fg-subtle">Hace falta conexión a internet.</p>
                    </div>
                ) : (
                    <div className="mt-4 grid gap-4">
                        <div className="flex items-start gap-2 rounded-2xl border border-border bg-surface-2 px-4 py-3 text-sm text-fg-muted">
                            <Mail className="mt-0.5 size-4 shrink-0 text-accent" aria-hidden />
                            <span>
                                Hemos enviado un código a{" "}
                                <span className="font-semibold text-fg">{enviado.emailHint}</span>.
                                Caduca en {enviado.minutos} minutos.
                            </span>
                        </div>

                        <label className="block">
                            <span className="text-sm font-semibold text-fg">Código del correo</span>
                            <Input
                                autoFocus
                                value={codigo}
                                onChange={(e) => setCodigo(soloCifras(e.target.value, 6))}
                                inputMode="numeric"
                                autoComplete="one-time-code"
                                placeholder="000000"
                                disabled={ocupado}
                                className="mt-1 h-12 text-center text-lg tracking-[0.4em]"
                            />
                        </label>

                        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                            <label className="block">
                                <span className="text-sm font-semibold text-fg">PIN nuevo</span>
                                <Input
                                    type="password"
                                    value={pin}
                                    onChange={(e) => setPin(soloCifras(e.target.value, 6))}
                                    inputMode="numeric"
                                    autoComplete="new-password"
                                    placeholder="4 a 6 cifras"
                                    disabled={ocupado}
                                    className="mt-1 h-12 tracking-[0.3em]"
                                />
                            </label>
                            <label className="block">
                                <span className="text-sm font-semibold text-fg">Repite el PIN</span>
                                <Input
                                    type="password"
                                    value={pin2}
                                    onChange={(e) => setPin2(soloCifras(e.target.value, 6))}
                                    inputMode="numeric"
                                    autoComplete="new-password"
                                    invalid={pin2.length > 0 && !pinesCoinciden}
                                    disabled={ocupado}
                                    className="mt-1 h-12 tracking-[0.3em]"
                                />
                            </label>
                        </div>
                    </div>
                )}

                {error ? (
                    <div
                        className="mt-4 rounded-2xl border border-danger/30 bg-danger-soft px-4 py-2 text-sm text-danger"
                        role="alert"
                    >
                        {error}
                    </div>
                ) : null}

                <div className="mt-6 flex flex-wrap items-center justify-end gap-2">
                    {!enviado ? (
                        <Button loading={ocupado} onClick={conAviso(pedirCodigo)}>
                            Enviar código
                        </Button>
                    ) : (
                        <>
                            <Button
                                variant="secondary"
                                disabled={ocupado || espera > 0}
                                onClick={conAviso(pedirCodigo)}
                            >
                                {espera > 0
                                    ? `Enviar otro código (${formatoCuentaAtras(espera)})`
                                    : "Enviar otro código"}
                            </Button>
                            <Button
                                loading={ocupado}
                                disabled={!puedeConfirmar}
                                onClick={conAviso(confirmar)}
                            >
                                Cambiar PIN
                            </Button>
                        </>
                    )}
                </div>
            </div>
        </ModalShell>
    );
}
