import React, { useState } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import { completeInitialSetup } from "../../features/login/loginApi";
import { useAuth } from "../../shared/stores/useAuth";
import { useMode } from "../../shared/stores/useMode";

function cn(...classes: Array<string | false | undefined | null>) {
    return classes.filter(Boolean).join(" ");
}

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

    const canSave =
        !saving &&
        !!idUsuario &&
        pinActual.length >= 4 &&
        pinNuevo.length >= 4 &&
        pinNuevo === pinNuevo2 &&
        email.trim().length >= 6;

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
        <div className="min-h-screen bg-gradient-to-b from-zinc-50 to-zinc-100 flex items-center justify-center p-6">
            <div className="w-full max-w-xl rounded-3xl border border-black/5 bg-white/70 p-6 shadow-sm backdrop-blur">
                <h1 className="text-xl font-semibold text-zinc-900">
                    Configuración inicial
                </h1>

                <p className="mt-1 text-sm text-zinc-600">
                    Hola {nombre ?? "usuario"}. Antes de usar el TPV debes cambiar el PIN y añadir tu Gmail.
                </p>

                <div className="mt-5 grid gap-4">
                    <div>
                        <label className="text-xs font-semibold text-zinc-700">
                            PIN actual
                        </label>

                        <input
                            value={pinActual}
                            onChange={(e) =>
                                setPinActual(e.target.value.replace(/\D/g, "").slice(0, 6))
                            }
                            className="mt-1 w-full rounded-2xl border border-black/10 bg-white px-4 py-3 text-zinc-900 outline-none"
                            placeholder="1234"
                            inputMode="numeric"
                        />
                    </div>

                    <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                        <div>
                            <label className="text-xs font-semibold text-zinc-700">
                                PIN nuevo
                            </label>

                            <input
                                value={pinNuevo}
                                onChange={(e) =>
                                    setPinNuevo(e.target.value.replace(/\D/g, "").slice(0, 6))
                                }
                                className="mt-1 w-full rounded-2xl border border-black/10 bg-white px-4 py-3 text-zinc-900 outline-none"
                                placeholder="mín 4 dígitos"
                                inputMode="numeric"
                            />
                        </div>

                        <div>
                            <label className="text-xs font-semibold text-zinc-700">
                                Repite PIN nuevo
                            </label>

                            <input
                                value={pinNuevo2}
                                onChange={(e) =>
                                    setPinNuevo2(e.target.value.replace(/\D/g, "").slice(0, 6))
                                }
                                className="mt-1 w-full rounded-2xl border border-black/10 bg-white px-4 py-3 text-zinc-900 outline-none"
                                placeholder="repite"
                                inputMode="numeric"
                            />
                        </div>
                    </div>

                    <div>
                        <label className="text-xs font-semibold text-zinc-700">
                            Gmail
                        </label>

                        <input
                            value={email}
                            onChange={(e) => setEmail(e.target.value)}
                            className="mt-1 w-full rounded-2xl border border-black/10 bg-white px-4 py-3 text-zinc-900 outline-none"
                            placeholder="tuemail@gmail.com"
                            inputMode="email"
                        />
                    </div>

                    {error ? (
                        <div className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800">
                            {error}
                        </div>
                    ) : null}

                    <button
                        onClick={onSave}
                        disabled={!canSave}
                        className={cn(
                            "h-12 w-full rounded-2xl border border-black/5 shadow-sm transition active:scale-[0.98]",
                            canSave
                                ? "bg-black text-white hover:bg-black/90"
                                : "bg-black/5 text-zinc-400 cursor-not-allowed",
                        )}
                    >
                        {saving ? "Guardando..." : "Guardar y continuar"}
                    </button>

                    <p className="text-xs text-zinc-500">
                        Nota: mientras no completes esto, el TPV quedará bloqueado.
                    </p>
                </div>
            </div>
        </div>
    );
}