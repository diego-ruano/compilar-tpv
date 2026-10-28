import { commands } from "@tpv/client";
import React, { useEffect, useState } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import {
    Check,
    KeyRound,
    LockKeyhole,
    Mail,
    ShieldCheck,
    UserRound,
} from "lucide-react";

import ConfirmarCorreoRecuperacion from "../../features/login/ConfirmarCorreoRecuperacion";
import { useAuth } from "../../shared/stores/useAuth";
import { useMode } from "../../shared/stores/useMode";
import { Badge, Button, Card, Input } from "../../shared/ui";
import Titlebar from "../layoutComponent/Titlebar";
import { conAviso } from "../../shared/lib/conAviso";
import { correoValido } from "../../shared/lib/correo";

/**
 * Elegir el PIN del primer arranque. Se llega aqui de dos maneras:
 *
 *  - SIN sesion, nada mas abrir la app recien instalada (lo normal): `App` la enseña en vez del
 *    login y al terminar avisa por `onCompletado` para que se pase al login con el PIN nuevo.
 *  - CON sesion, como red de seguridad: si alguien entra y su usuario sigue marcado, el login
 *    manda a /setup y al terminar se sigue a la app.
 */
export default function SetupInicial({ onCompletado }: { onCompletado?: () => void }) {
    const navigate = useNavigate();

    const mode = useMode((s) => s.mode);

    const idUsuarioSesion = useAuth((s) => s.idUsuario);
    const nombreSesion = useAuth((s) => s.nombre);
    const emailPrev = useAuth((s) => s.email);
    const setSession = useAuth((s) => s.setSession);
    const role = useAuth((s) => s.role);

    // LOGIN-08: a dónde llegan los códigos para recuperar el PIN. Por defecto, al correo de la
    // compra, que ya está demostrado. Si se desmarca, el correo escrito se confirma con su código
    // (o se salta) antes de guardar el PIN, porque al guardarlo se cierra la ventana en la que se
    // puede confirmar sin sesión. Por eso sólo se ofrece sin sesión, en el primer arranque; con ella
    // se cambia en Configuración → Negocio.
    const elegirCorreoRecuperacion = !idUsuarioSesion;
    const [usarCorreoCompra, setUsarCorreoCompra] = useState(true);
    const [correoRecuperacion, setCorreoRecuperacion] = useState("");
    const [correoAConfirmar, setCorreoAConfirmar] = useState<string | null>(null);
    const [correoConfirmado, setCorreoConfirmado] = useState<string | null>(null);
    const correoRecuperacionResuelto = usarCorreoCompra || correoConfirmado !== null;

    // Sin sesion no hay de donde sacar el usuario: se pregunta al equipo quien tiene el setup
    // pendiente (el admin que siembra la BD al crearse).
    const [pendiente, setPendiente] = useState<{
        idUsuario: string | null;
        nombre: string | null;
    } | null>(null);

    const [pinNuevo, setPinNuevo] = useState("");
    const [pinNuevo2, setPinNuevo2] = useState("");
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        if (idUsuarioSesion) return;

        let vivo = true;
        commands.setupPendiente()
            .then((r) => {
                if (!vivo) return;
                setPendiente({
                    idUsuario: r.id_usuario,
                    nombre: r.nombre,
                });
            })
            .catch((e) => {
                console.error("No se pudo leer el estado del setup inicial:", e);
            });
        return () => {
            vivo = false;
        };
    }, [idUsuarioSesion]);

    const idUsuario = idUsuarioSesion ?? pendiente?.idUsuario ?? null;
    const nombre = nombreSesion ?? pendiente?.nombre ?? null;

    if (mode === "handy") {
        return <Navigate to="/VentaRapida" replace />;
    }

    const canSave =
        !saving &&
        correoRecuperacionResuelto &&
        !!idUsuario &&
        pinNuevo.length >= 4 &&
        pinNuevo === pinNuevo2;

    const onSave = async () => {
        if (!idUsuario) return;

        setError(null);

        if (pinNuevo !== pinNuevo2) {
            setError("Los PIN nuevos no coinciden.");
            return;
        }

        if (pinNuevo.trim().length < 4) {
            setError("El PIN nuevo debe tener al menos 4 dígitos.");
            return;
        }

        setSaving(true);

        try {
            await commands.completeInitialSetup({
                id_usuario: idUsuario,
                pin_nuevo: pinNuevo,
            });

            // Subimos el setup a la nube para que la Handy haga login con datos reales.
            // No es bloqueante: si la nube falla, el TPV local ya quedó configurado y debe
            // poder continuar (solo se resentiría el login de la Handy hasta reintentarlo).
            try {
                await commands.configUploadInitialSetup({
                    id_usuario: idUsuario,
                    pin: pinNuevo,
                });
            } catch (e) {
                console.warn("uploadInitialSetupToCloud falló (setup local OK):", e);
            }

            if (role) {
                setSession({
                    role,
                    idUsuario,
                    idTrabajador: null,
                    nombre: nombre ?? "",
                    requiresSetup: false,
                    email: emailPrev,
                });

                void navigate("/", { replace: true });
                return;
            }

            // Primer arranque: no se entra sin mas, se pasa por el login con el PIN elegido.
            onCompletado?.();
        } catch (e: any) {
            const msg =
                typeof e === "string"
                    ? e
                    : e?.message
                        ? String(e.message)
                        : "Error guardando";

            setError(msg);
        } finally {
            setSaving(false);
            setPinNuevo("");
            setPinNuevo2("");
        }
    };

    return (
        <div className="flex h-full min-h-0 w-full flex-col overflow-hidden bg-bg text-fg">
            <Titlebar />

            <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-y-auto p-4 sm:p-6 lg:p-10">
                <div
                    className="pointer-events-none absolute -left-24 -top-24 size-80 rounded-full bg-accent-soft blur-3xl"
                    aria-hidden
                />
                <div
                    className="pointer-events-none absolute -bottom-32 -right-16 size-96 rounded-full bg-accent-soft opacity-70 blur-3xl"
                    aria-hidden
                />

                <Card
                    padded={false}
                    className="relative grid w-full max-w-5xl overflow-hidden rounded-3xl shadow-xl lg:grid-cols-[0.9fr_1.1fr]"
                >
                <section className="flex flex-col justify-between border-b border-border bg-surface-2 p-6 sm:p-8 lg:border-b-0 lg:border-r">
                    <div>
                        <div className="flex items-center justify-between gap-3">
                            <div className="grid size-14 place-items-center rounded-2xl bg-accent-soft text-accent">
                                <ShieldCheck className="size-7" aria-hidden />
                            </div>
                            <Badge tone="accent">Primer acceso</Badge>
                        </div>

                        <h1 className="mt-6 text-2xl font-bold tracking-tight text-fg sm:text-3xl">
                            Termina de preparar tu cuenta
                        </h1>
                        <p className="mt-3 text-sm leading-relaxed text-fg-muted sm:text-base">
                            Hola, <span className="font-semibold text-fg">{nombre ?? "usuario"}</span>.
                            Elige el PIN con el que vas a entrar. Después iniciarás sesión con
                            ese PIN.
                        </p>

                        <div className="mt-7 space-y-4">
                            <div className="flex gap-3">
                                <div className="grid size-9 shrink-0 place-items-center rounded-xl bg-surface text-accent shadow-sm">
                                    <KeyRound className="size-4" aria-hidden />
                                </div>
                                <div>
                                    <p className="text-sm font-semibold text-fg">
                                        Crea tu PIN personal
                                    </p>
                                    <p className="mt-0.5 text-xs leading-relaxed text-fg-muted">
                                        Utiliza entre 4 y 6 dígitos que puedas recordar.
                                    </p>
                                </div>
                            </div>

                            {elegirCorreoRecuperacion ? (
                                <div className="flex gap-3">
                                    <div className="grid size-9 shrink-0 place-items-center rounded-xl bg-surface text-accent shadow-sm">
                                        <Mail className="size-4" aria-hidden />
                                    </div>
                                    <div>
                                        <p className="text-sm font-semibold text-fg">
                                            Por si lo olvidas
                                        </p>
                                        <p className="mt-0.5 text-xs leading-relaxed text-fg-muted">
                                            Te mandaremos un código al correo de la compra, o al
                                            que elijas.
                                        </p>
                                    </div>
                                </div>
                            ) : null}
                        </div>
                    </div>

                    <div className="mt-8 flex items-center gap-2 rounded-2xl border border-border bg-surface px-4 py-3 text-xs text-fg-muted">
                        <LockKeyhole className="size-4 shrink-0 text-success" aria-hidden />
                        Tus datos se guardarán al completar este paso.
                    </div>
                </section>

                <section className="p-6 sm:p-8">
                    <div className="flex items-center gap-3">
                        <div className="grid size-10 place-items-center rounded-xl bg-accent-soft text-accent">
                            <UserRound className="size-5" aria-hidden />
                        </div>
                        <div>
                            <h2 className="text-lg font-bold text-fg">
                                Datos de acceso
                            </h2>
                            <p className="text-sm text-fg-muted">
                                Todos los campos son obligatorios.
                            </p>
                        </div>
                    </div>

                    <div className="mt-6 grid gap-5">
                        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                            <div>
                                <label
                                    htmlFor="setup-pin-nuevo"
                                    className="text-sm font-semibold text-fg"
                                >
                                    Tu PIN
                                </label>
                                <Input
                                    id="setup-pin-nuevo"
                                    type="password"
                                    value={pinNuevo}
                                    onChange={(e) =>
                                        setPinNuevo(
                                            e.target.value.replace(/\D/g, "").slice(0, 6),
                                        )
                                    }
                                    className="mt-2 h-12 px-4 text-base tracking-[0.3em]"
                                    placeholder="••••"
                                    inputMode="numeric"
                                    autoComplete="new-password"
                                    maxLength={6}
                                />
                            </div>

                            <div>
                                <label
                                    htmlFor="setup-pin-confirmacion"
                                    className="text-sm font-semibold text-fg"
                                >
                                    Repite el PIN
                                </label>
                                <Input
                                    id="setup-pin-confirmacion"
                                    type="password"
                                    value={pinNuevo2}
                                    onChange={(e) =>
                                        setPinNuevo2(
                                            e.target.value.replace(/\D/g, "").slice(0, 6),
                                        )
                                    }
                                    invalid={
                                        pinNuevo2.length > 0 &&
                                        pinNuevo !== pinNuevo2
                                    }
                                    className="mt-2 h-12 px-4 text-base tracking-[0.3em]"
                                    placeholder="••••"
                                    inputMode="numeric"
                                    autoComplete="new-password"
                                    maxLength={6}
                                />
                                {pinNuevo2.length > 0 && pinNuevo === pinNuevo2 ? (
                                    <p className="mt-2 flex items-center gap-1.5 text-xs font-medium text-success">
                                        <Check className="size-3.5" aria-hidden />
                                        Los PIN coinciden
                                    </p>
                                ) : null}
                            </div>
                        </div>

                        {elegirCorreoRecuperacion && correoAConfirmar ? (
                            <ConfirmarCorreoRecuperacion
                                correo={correoAConfirmar}
                                onResuelto={(confirmado) => {
                                    setCorreoAConfirmar(null);
                                    if (confirmado) setCorreoConfirmado(correoAConfirmar);
                                    else setUsarCorreoCompra(true);
                                }}
                            />
                        ) : elegirCorreoRecuperacion ? (
                            <div className="rounded-2xl border border-border bg-surface-2 px-4 py-3">
                                <label
                                    htmlFor="setup-usar-correo-compra"
                                    className="flex cursor-pointer items-start gap-3"
                                >
                                    <input
                                        id="setup-usar-correo-compra"
                                        type="checkbox"
                                        checked={usarCorreoCompra}
                                        disabled={correoConfirmado !== null}
                                        onChange={(e) => setUsarCorreoCompra(e.target.checked)}
                                        className="mt-0.5 h-4 w-4 rounded border-border accent-accent"
                                    />
                                    <span>
                                        <span className="block text-sm font-semibold text-fg">
                                            Usar el correo de la compra para recuperar el PIN
                                        </span>
                                        <span className="mt-0.5 block text-xs text-fg-muted">
                                            Si prefieres otro, desmárcalo y escríbelo: te
                                            mandaremos un código para confirmarlo.
                                        </span>
                                    </span>
                                </label>

                                {usarCorreoCompra ? null : correoConfirmado ? (
                                    <p className="mt-3 flex items-center gap-1.5 text-xs font-medium text-success">
                                        <Check className="size-3.5 shrink-0" aria-hidden />
                                        Los códigos para recuperar el PIN llegarán a {correoConfirmado}.
                                    </p>
                                ) : (
                                    <div className="mt-3 flex gap-2">
                                        <Input
                                            id="setup-correo-recuperacion"
                                            type="email"
                                            value={correoRecuperacion}
                                            onChange={(e) => setCorreoRecuperacion(e.target.value)}
                                            invalid={
                                                correoRecuperacion.trim().length > 0 &&
                                                !correoValido(correoRecuperacion)
                                            }
                                            className="h-12 min-w-0 flex-1 px-4 text-base"
                                            placeholder="encargado@tubar.com"
                                            inputMode="email"
                                            autoComplete="email"
                                        />
                                        <Button
                                            size="lg"
                                            variant="secondary"
                                            disabled={!correoValido(correoRecuperacion)}
                                            onClick={() =>
                                                setCorreoAConfirmar(
                                                    correoRecuperacion.trim().toLowerCase(),
                                                )
                                            }
                                        >
                                            Enviar código
                                        </Button>
                                    </div>
                                )}
                            </div>
                        ) : null}

                        {error ? (
                            <div
                                className="rounded-2xl border border-danger bg-danger-soft px-4 py-3 text-sm text-danger"
                                role="alert"
                            >
                                {error}
                            </div>
                        ) : null}

                        <Button
                            type="button"
                            size="lg"
                            fullWidth
                            loading={saving}
                            disabled={!canSave}
                            onClick={conAviso(onSave)}
                            leftIcon={<ShieldCheck className="size-5" aria-hidden />}
                            className="mt-1"
                        >
                            Guardar y continuar
                        </Button>

                        <p className="text-center text-xs text-fg-subtle">
                            {correoRecuperacionResuelto
                                ? "Este paso es necesario para desbloquear el TPV."
                                : "Antes, confirma el correo de recuperación o usa el de la compra."}
                        </p>
                    </div>
                </section>
                </Card>
            </div>
        </div>
    );
}
