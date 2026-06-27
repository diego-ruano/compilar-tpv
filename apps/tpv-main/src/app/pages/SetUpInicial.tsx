import React, { useState } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import {
    Check,
    KeyRound,
    LockKeyhole,
    Mail,
    ShieldCheck,
    UserRound,
} from "lucide-react";
import {
    completeInitialSetup,
    uploadInitialSetupToCloud,
} from "../../features/login/loginApi";
import { useAuth } from "../../shared/stores/useAuth";
import { useMode } from "../../shared/stores/useMode";
import { Badge, Button, Card, Input } from "../../shared/ui";
import Titlebar from "../layoutComponent/Titlebar";

export default function SetupInicial() {
    const navigate = useNavigate();

    const mode = useMode((s) => s.mode);

    const idUsuario = useAuth((s) => s.idUsuario);
    const nombre = useAuth((s) => s.nombre);
    const emailPrev = useAuth((s) => s.email);
    const setSession = useAuth((s) => s.setSession);
    const role = useAuth((s) => s.role);

    const [pinActual, setPinActual] = useState("");
    const [pinNuevo, setPinNuevo] = useState("");
    const [pinNuevo2, setPinNuevo2] = useState("");
    const [email, setEmail] = useState(emailPrev ?? "");
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);

    if (mode === "handy") {
        return <Navigate to="/VentaRapida" replace />;
    }

    const emailTrimmed = email.trim();
    const canSave =
        !saving &&
        !!idUsuario &&
        pinActual.length >= 4 &&
        pinNuevo.length >= 4 &&
        pinNuevo === pinNuevo2 &&
        emailTrimmed.includes("@") &&
        emailTrimmed.includes(".");

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

        const cleanEmail = email.trim();

        if (!cleanEmail || !cleanEmail.includes("@") || !cleanEmail.includes(".")) {
            setError("Introduce un email válido.");
            return;
        }

        setSaving(true);

        try {
            await completeInitialSetup({
                idUsuario,
                pinActual,
                pinNuevo,
                emailNuevo: cleanEmail,
            });

            // Subimos el setup a la nube para que la Handy haga login con datos reales.
            // No es bloqueante: si la nube falla, el TPV local ya quedó configurado y debe
            // poder continuar (solo se resentiría el login de la Handy hasta reintentarlo).
            try {
                await uploadInitialSetupToCloud({
                    idUsuario,
                    email: cleanEmail,
                    pin: pinNuevo,
                });
            } catch (e) {
                console.warn("uploadInitialSetupToCloud falló (setup local OK):", e);
            }

            setSession({
                role: role!,
                idUsuario,
                idTrabajador: null,
                nombre: nombre!,
                requiresSetup: false,
                email: cleanEmail,
            });

            navigate("/", { replace: true });
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
            setPinActual("");
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
                            Antes de empezar necesitamos proteger tu acceso y confirmar
                            tu correo.
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

                            <div className="flex gap-3">
                                <div className="grid size-9 shrink-0 place-items-center rounded-xl bg-surface text-accent shadow-sm">
                                    <Mail className="size-4" aria-hidden />
                                </div>
                                <div>
                                    <p className="text-sm font-semibold text-fg">
                                        Confirma tu correo
                                    </p>
                                    <p className="mt-0.5 text-xs leading-relaxed text-fg-muted">
                                        Se asociará a tu usuario para los servicios del TPV.
                                    </p>
                                </div>
                            </div>
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
                        <div>
                            <label
                                htmlFor="setup-pin-actual"
                                className="text-sm font-semibold text-fg"
                            >
                                PIN actual
                            </label>
                            <Input
                                id="setup-pin-actual"
                                type="password"
                                value={pinActual}
                                onChange={(e) =>
                                    setPinActual(
                                        e.target.value.replace(/\D/g, "").slice(0, 6),
                                    )
                                }
                                className="mt-2 h-12 px-4 text-base tracking-[0.3em]"
                                placeholder="••••"
                                inputMode="numeric"
                                autoComplete="current-password"
                                maxLength={6}
                            />
                        </div>

                        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                            <div>
                                <label
                                    htmlFor="setup-pin-nuevo"
                                    className="text-sm font-semibold text-fg"
                                >
                                    PIN nuevo
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

                        <div>
                            <label
                                htmlFor="setup-email"
                                className="text-sm font-semibold text-fg"
                            >
                                Correo electrónico
                            </label>
                            <Input
                                id="setup-email"
                                type="email"
                                value={email}
                                onChange={(e) => setEmail(e.target.value)}
                                className="mt-2 h-12 px-4 text-base"
                                placeholder="tuemail@ejemplo.com"
                                inputMode="email"
                                autoComplete="email"
                            />
                            <p className="mt-2 text-xs text-fg-subtle">
                                No tiene que ser Gmail; puedes usar cualquier correo válido.
                            </p>
                        </div>

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
                            onClick={onSave}
                            leftIcon={<ShieldCheck className="size-5" aria-hidden />}
                            className="mt-1"
                        >
                            Guardar y continuar
                        </Button>

                        <p className="text-center text-xs text-fg-subtle">
                            Este paso es necesario para desbloquear el TPV.
                        </p>
                    </div>
                </section>
                </Card>
            </div>
        </div>
    );
}
