import React, { useEffect, useMemo, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import LogoAltaria from "../assets/img/logo.png";
import CerrarVentana from "../assets/svg/CerrarVentana.svg";
import MinimizarVentana from "../assets/svg/MinimizarVentana.svg";
import PantallaCompleta from "../assets/svg/PantallaCompleta.svg";
import { useNavigate } from "react-router-dom";
import { useBusinessSettings } from "../shared/stores/useBusinessSettings";
import { useToast } from "../shared/toast";
import { useAuth } from "../shared/stores/useAuth";

import {
    listLoginUsers,
    loginUser,
    getTodayPunchStatus,
    punch as punchApi,
    setTurnoPartidoHoy,
    type DbUser,
    type PunchStatus,
} from "../features/login/loginApi";

function cn(...classes: Array<string | false | undefined | null>) {
    return classes.filter(Boolean).join(" ");
}

export default function Login() {
    const setSession = useAuth((s) => s.setSession);
    const navigate = useNavigate();
    const toast = useToast();
    const { businessName, logoDataUrl } = useBusinessSettings();

    const [users, setUsers] = useState<DbUser[]>([]);
    const [loadingUsers, setLoadingUsers] = useState(true);

    const [isSubmitting, setIsSubmitting] = useState(false);
    const [selectedUserId, setSelectedUserId] = useState<number | null>(null);

    const selectedUser = useMemo(
        () => users.find((u) => u.id_usuario === selectedUserId) ?? null,
        [users, selectedUserId],
    );

    const [pin, setPin] = useState("");
    const pinRef = useRef(pin);

    useEffect(() => {
        pinRef.current = pin;
    }, [pin]);

    const [punchStatus, setPunchStatus] = useState<PunchStatus | null>(null);
    const [loadingPunch, setLoadingPunch] = useState(false);

    const canType = Boolean(selectedUser) && !isSubmitting;
    const pinMasked = useMemo(() => "•".repeat(pin.length), [pin.length]);

    const p1 = useMemo(
        () => punchStatus?.partes?.find((p) => p.parte === 1) ?? null,
        [punchStatus],
    );
    const p2 = useMemo(
        () => punchStatus?.partes?.find((p) => p.parte === 2) ?? null,
        [punchStatus],
    );

    const turnoPartido = punchStatus?.turno_partido === 1;

    const hasEntrada1 = Boolean(p1?.entrada);
    const hasSalida1 = Boolean(p1?.salida);
    const hasEntrada2 = Boolean(p2?.entrada);
    const hasSalida2 = Boolean(p2?.salida);

    const fichajeCompleto =
        hasEntrada1 && hasSalida1 && (!turnoPartido || (hasEntrada2 && hasSalida2));

    const ficharLabel = !hasEntrada1
        ? "Fichar entrada"
        : !hasSalida1
            ? "Fichar salida"
            : turnoPartido && !hasEntrada2
                ? "Fichar entrada (2ª)"
                : turnoPartido && !hasSalida2
                    ? "Fichar salida (2ª)"
                    : "Fichaje completado";

    const ficharTone =
        !hasEntrada1 ||
            !hasSalida1 ||
            (turnoPartido && (!hasEntrada2 || !hasSalida2))
            ? ("action" as const)
            : ("default" as const);

    const pinOk = pin.length >= 4 && canType;

    const ficharDisabled =
        !selectedUser || isSubmitting || loadingPunch || !pinOk || fichajeCompleto;

    const canEnter = canType && hasEntrada1 && pinOk;

    const ventana = getCurrentWindow();
    const showBottomBlock = Boolean(selectedUser);

    const refreshPunch = async (uid: number) => {
        const st = await getTodayPunchStatus({ idUsuario: uid });
        setPunchStatus(st);
    };

    useEffect(() => {
        let mounted = true;

        (async () => {
            try {
                setLoadingUsers(true);
                const arr = await listLoginUsers();
                if (!mounted) return;
                setUsers(arr ?? []);
            } catch (e) {
                console.error("listLoginUsers error:", e);
                toast.error(
                    "No se pudieron cargar los usuarios",
                    "Revisa la conexión con la base de datos.",
                );
            } finally {
                if (mounted) setLoadingUsers(false);
            }
        })();

        return () => {
            mounted = false;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useEffect(() => {
        pinRef.current = "";
        setPin("");
        setIsSubmitting(false);
        setPunchStatus(null);

        if (!selectedUserId) return;

        let mounted = true;
        (async () => {
            try {
                setLoadingPunch(true);
                const st = await getTodayPunchStatus({
                    idUsuario: selectedUserId,
                });
                if (!mounted) return;
                setPunchStatus(st);
            } catch (e: any) {
                console.error("get_today_punch_status error:", e);
                if (!mounted) return;
                setPunchStatus(null);
                toast.error(
                    "No se pudo comprobar el fichaje",
                    "Revisa la conexión con la base de datos.",
                );
            } finally {
                if (mounted) setLoadingPunch(false);
            }
        })();

        return () => {
            mounted = false;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [selectedUserId]);

    const requireUserOrWarn = () => {
        if (selectedUser) return true;
        toast.warning(
            "Selecciona un usuario antes de introducir la contraseña",
            "Elige un usuario.",
        );
        return false;
    };

    const handleDigit = (d: string) => {
        if (!requireUserOrWarn()) return;
        if (isSubmitting) return;

        setPin((prev) => {
            const next = prev.length >= 6 ? prev : prev + d;
            pinRef.current = next;
            return next;
        });
    };

    const handleBackspace = () => {
        if (!requireUserOrWarn()) return;
        if (isSubmitting) return;

        setPin((prev) => {
            const next = prev.slice(0, -1);
            pinRef.current = next;
            return next;
        });
    };

    const handleClear = () => {
        if (!requireUserOrWarn()) return;
        if (isSubmitting) return;
        pinRef.current = "";
        setPin("");
    };

    const handleTurnoPartidoToggle = async (checked: boolean) => {
        if (!selectedUserId) return;

        try {
            setLoadingPunch(true);
            await setTurnoPartidoHoy({
                idUsuario: selectedUserId,
                turnoPartido: checked,
            });
            await refreshPunch(selectedUserId);
            toast.success(
                "Turno actualizado",
                checked ? "Marcado como turno partido." : "Turno partido desactivado.",
            );
        } catch (e) {
            console.error("setTurnoPartidoHoy error:", e);
            toast.error("No se pudo guardar turno partido", "Inténtalo de nuevo.");
        } finally {
            setLoadingPunch(false);
        }
    };

    const handlePunch = async () => {
        if (isSubmitting) return;
        if (!requireUserOrWarn()) return;

        const currentPin = pinRef.current.trim();
        if (currentPin.length < 4) {
            toast.info("PIN incompleto", "Introduce al menos 4 dígitos para fichar.");
            return;
        }

        const tipo: "entrada" | "salida" = !hasEntrada1
            ? "entrada"
            : !hasSalida1
                ? "salida"
                : turnoPartido && !hasEntrada2
                    ? "entrada"
                    : turnoPartido && !hasSalida2
                        ? "salida"
                        : "entrada";

        if (fichajeCompleto) {
            toast.info("Fichaje completado", "Ya has completado tu fichaje hoy.");
            return;
        }

        setIsSubmitting(true);
        setLoadingPunch(true);

        try {
            const st = await punchApi({
                idUsuario: selectedUserId!,
                pin: currentPin,
                tipo,
            });

            setPunchStatus(st);

            pinRef.current = "";
            setPin("");

            toast.success(
                tipo === "entrada" ? "Entrada registrada" : "Salida registrada",
                "Fichaje guardado correctamente.",
            );
        } catch (e: any) {
            console.error("punch error:", e);

            const msg =
                typeof e === "string"
                    ? e
                    : e?.message
                        ? String(e.message)
                        : "No se pudo fichar";

            toast.error("Error al fichar", msg);
        } finally {
            setIsSubmitting(false);
            setLoadingPunch(false);
        }
    };

    const handleSubmit = async () => {
        if (isSubmitting) return;
        if (!requireUserOrWarn()) return;

        const currentPin = pinRef.current.trim();
        if (currentPin.length < 4) {
            toast.info("PIN incompleto", "Introduce al menos 4 dígitos.");
            return;
        }

        setIsSubmitting(true);

        try {
            const ok = await loginUser({
                idUsuario: selectedUserId!,
                pin: currentPin,
            });

            if (!ok.rol || !ok.id_usuario) {
                throw new Error("Login sin datos de sesión válidos");
            }

            if (ok.requiere_setup === 1) {
                setSession({
                    role: ok.rol,
                    idUsuario: ok.id_usuario,
                    idTrabajador: ok.id_trabajador,
                    nombre: ok.nombre,
                    requiresSetup: true,
                    email: ok.email,
                });

                navigate("/setup", { replace: true });
                return;
            }

            if (!hasEntrada1) {
                toast.warning(
                    "Debes fichar entrada antes de entrar",
                    "Pulsa “Fichar entrada” e introduce tu PIN.",
                );
                pinRef.current = "";
                setPin("");
                return;
            }

            setSession({
                role: ok.rol,
                idUsuario: ok.id_usuario,
                idTrabajador: ok.id_trabajador,
                nombre: ok.nombre,
                requiresSetup: false,
                email: ok.email,
            });

            navigate("/", { replace: true });
        } catch (e: any) {
            const msg =
                typeof e === "string"
                    ? e
                    : e?.message
                        ? String(e.message)
                        : "PIN incorrecto";

            toast.error("Acceso denegado", msg);
            pinRef.current = "";
            setPin("");
        } finally {
            setIsSubmitting(false);
        }
    };

    useEffect(() => {
        const onKeyDown = (e: KeyboardEvent) => {
            if (!selectedUser) return;

            const el = document.activeElement as HTMLElement | null;
            const tag = el?.tagName?.toLowerCase();
            const typing =
                tag === "input" || tag === "textarea" || el?.isContentEditable === true;
            if (typing) return;

            if (e.repeat) return;

            if (isSubmitting) {
                if (e.key === "Enter" || /^\d$/.test(e.key)) e.preventDefault();
                return;
            }

            if (/^\d$/.test(e.key)) {
                e.preventDefault();
                setPin((prev) => {
                    const next = prev.length >= 6 ? prev : prev + e.key;
                    pinRef.current = next;
                    return next;
                });
                return;
            }

            if (e.key === "Backspace") {
                e.preventDefault();
                setPin((prev) => {
                    const next = prev.slice(0, -1);
                    pinRef.current = next;
                    return next;
                });
                return;
            }

            if (e.key === "Escape") {
                e.preventDefault();
                pinRef.current = "";
                setPin("");
                return;
            }

            if (e.key === "Enter") {
                e.preventDefault();
                if (!hasEntrada1) handlePunch();
                else handleSubmit();
            }
        };

        window.addEventListener("keydown", onKeyDown);
        return () => window.removeEventListener("keydown", onKeyDown);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [selectedUser, isSubmitting, hasEntrada1]);

    const mobileFichajeResumen = useMemo(() => {
        if (!selectedUser) return "Selecciona un usuario";
        if (loadingPunch) return "Comprobando fichaje...";
        if (fichajeCompleto) return "Fichaje completado";
        if (!hasEntrada1) return "Pendiente: entrada";
        if (!hasSalida1) return "Pendiente: salida";
        if (turnoPartido && !hasEntrada2) return "Pendiente: entrada (2ª)";
        if (turnoPartido && !hasSalida2) return "Pendiente: salida (2ª)";
        return "OK";
    }, [
        selectedUser,
        loadingPunch,
        fichajeCompleto,
        hasEntrada1,
        hasSalida1,
        turnoPartido,
        hasEntrada2,
        hasSalida2,
    ]);

    return (
        <div className="relative h-screen overflow-hidden bg-linear-to-b from-zinc-50 to-zinc-100">
            <div className="w-full flex justify-between shrink-0 absolute top-0 left-0 right-0 z-50">
                <div
                    className="flex bg-white w-full p-1.5 items-center gap-2 sm:gap-3"
                    data-tauri-drag-region
                >
                    <img
                        src={logoDataUrl ?? LogoAltaria}
                        className="size-5 rounded-sm object-cover"
                        data-tauri-drag-region
                        alt="logo"
                    />
                    <p data-tauri-drag-region className="truncate max-w-[45vw] sm:max-w-60">
                        {businessName || "TPV"}
                    </p>
                </div>
                <div className="flex gap-2 sm:gap-4 w-fit p-1 px-2 bg-white">
                    <button
                        data-tauri-drag-region
                        className="hover:scale-140 transition-all cursor-pointer"
                        onClick={() => ventana.minimize()}
                        type="button"
                    >
                        <img src={MinimizarVentana} className="size-7 sm:size-8" alt="minimizar" />
                    </button>
                    <button
                        data-tauri-drag-region
                        className="hover:scale-140 transition-all cursor-pointer"
                        onClick={() => ventana.toggleMaximize()}
                        type="button"
                    >
                        <img src={PantallaCompleta} className="size-5" alt="maximizar" />
                    </button>
                    <button
                        data-tauri-drag-region
                        className="hover:scale-140 transition-all cursor-pointer"
                        onClick={() => ventana.close()}
                        type="button"
                    >
                        <img src={CerrarVentana} className="size-7 sm:size-8" alt="cerrar" />
                    </button>
                </div>
            </div>

            <div className="pt-11 sm:pt-12 h-full">
                <div
                    className={cn(
                        "mx-auto w-full max-w-6xl",
                        "h-[calc(100vh-44px)] sm:h-[calc(100vh-48px)]",
                        "px-2 sm:px-4 pb-2 sm:pb-4",
                        "flex flex-col lg:grid lg:grid-cols-2",
                        "gap-2 sm:gap-6",
                    )}
                >
                    <section
                        className={cn(
                            "rounded-3xl border border-black/5 bg-white/60 shadow-sm backdrop-blur",
                            "p-3 sm:p-5",
                            "min-h-0",
                            "lg:h-[calc(100vh-140px)] lg:max-h-[760px] lg:min-h-[540px]",
                        )}
                    >
                        <div className="flex items-start sm:items-center justify-between gap-3">
                            <div className="min-w-0">
                                <h1 className="text-base sm:text-xl font-semibold text-zinc-900">
                                    Acceso
                                </h1>
                                <p className="mt-1 text-[11px] sm:text-sm text-zinc-600">
                                    Selecciona usuario y mete el PIN.
                                </p>
                            </div>

                            {selectedUser ? (
                                <div className="rounded-2xl bg-black/5 px-2.5 py-2 text-[11px] sm:text-sm text-zinc-700 shrink-0 max-w-[62%]">
                                    <span className="font-semibold">{selectedUser.nombre}</span>
                                    <span className="opacity-70"> · {selectedUser.nombre_rol}</span>
                                </div>
                            ) : (
                                <div className="rounded-2xl bg-amber-50 px-2.5 py-2 text-[11px] sm:text-sm text-amber-900 border border-amber-200 shrink-0">
                                    Ningún usuario
                                </div>
                            )}
                        </div>

                        <div className="mt-2 sm:hidden">
                            {loadingUsers ? (
                                <div className="rounded-3xl border border-black/5 bg-white/70 p-3 text-sm text-zinc-600">
                                    Cargando usuarios...
                                </div>
                            ) : users.length === 0 ? (
                                <div className="rounded-3xl border border-black/5 bg-white/70 p-3 text-sm text-zinc-600">
                                    No hay usuarios en la base de datos.
                                </div>
                            ) : (
                                <div className="flex gap-2 overflow-x-auto pb-1.5 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                                    {users.map((u) => {
                                        const active = u.id_usuario === selectedUserId;
                                        const initial = (u.nombre?.[0] ?? "?").toUpperCase();
                                        const fullName = `${u.nombre}${u.apellido ? " " + u.apellido : ""}`;

                                        return (
                                            <button
                                                key={u.id_usuario}
                                                type="button"
                                                onClick={() => setSelectedUserId(u.id_usuario)}
                                                className={cn(
                                                    "shrink-0 w-[118px] xs:w-[126px]",
                                                    "rounded-xl border px-2 py-1.5 text-left shadow-sm transition active:scale-[0.99]",
                                                    "bg-white/70 hover:bg-white cursor-pointer",
                                                    active
                                                        ? "border-black/20 ring-2 ring-black/10"
                                                        : "border-black/5",
                                                )}
                                            >
                                                <div className="flex items-center gap-2">
                                                    <div
                                                        className={cn(
                                                            "grid h-7 w-7 place-items-center rounded-lg bg-black/5 text-zinc-700",
                                                            active && "bg-black text-white",
                                                        )}
                                                    >
                                                        <span className="text-[11px] font-bold">{initial}</span>
                                                    </div>

                                                    <div className="min-w-0">
                                                        <p className="truncate text-[11px] font-semibold text-zinc-900 leading-4">
                                                            {fullName}
                                                        </p>
                                                        <p className="truncate text-[10px] text-zinc-600 leading-4">
                                                            {u.nombre_rol}
                                                        </p>
                                                    </div>
                                                </div>
                                            </button>
                                        );
                                    })}
                                </div>
                            )}
                        </div>

                        <div
                            className={cn(
                                "mt-5 hidden sm:block",
                                "min-h-0 overflow-y-auto pr-0 lg:pr-1",
                                showBottomBlock ? "lg:pb-[270px]" : "pb-0",
                            )}
                        >
                            {loadingUsers ? (
                                <div className="rounded-3xl border border-black/5 bg-white/70 p-4 text-sm text-zinc-600">
                                    Cargando usuarios...
                                </div>
                            ) : users.length === 0 ? (
                                <div className="rounded-3xl border border-black/5 bg-white/70 p-4 text-sm text-zinc-600">
                                    No hay usuarios en la base de datos.
                                </div>
                            ) : (
                                <div className="grid grid-cols-2 p-3 sm:p-4 gap-3 sm:grid-cols-3">
                                    {users.map((u) => {
                                        const active = u.id_usuario === selectedUserId;
                                        const initial = (u.nombre?.[0] ?? "?").toUpperCase();
                                        const fullName = `${u.nombre}${u.apellido ? " " + u.apellido : ""}`;

                                        return (
                                            <button
                                                key={u.id_usuario}
                                                type="button"
                                                onClick={() => setSelectedUserId(u.id_usuario)}
                                                className={cn(
                                                    "group rounded-3xl border p-3 mt-2 text-left shadow-sm transition active:scale-[0.99] cursor-pointer",
                                                    "bg-white/70 hover:bg-white",
                                                    active
                                                        ? "border-black/20 ring-2 ring-black/10"
                                                        : "border-black/5",
                                                )}
                                            >
                                                <div className="flex items-center gap-3">
                                                    <div
                                                        className={cn(
                                                            "grid h-10 w-10 place-items-center rounded-2xl bg-black/5 text-zinc-700",
                                                            active && "bg-black text-white",
                                                        )}
                                                    >
                                                        <span className="text-sm font-bold">{initial}</span>
                                                    </div>
                                                    <div className="min-w-0">
                                                        <p className="truncate text-sm font-semibold text-zinc-900">
                                                            {fullName}
                                                        </p>
                                                        <p className="truncate text-xs text-zinc-600">{u.nombre_rol}</p>
                                                    </div>
                                                </div>
                                            </button>
                                        );
                                    })}
                                </div>
                            )}
                        </div>

                        <div className="mt-2 sm:hidden">
                            <div className="rounded-3xl border border-black/5 bg-white/80 p-3">
                                <div className="flex items-center justify-between gap-3">
                                    <div className="min-w-0">
                                        <p className="text-[10px] font-medium text-zinc-500">Fichaje</p>
                                        <p className="truncate text-sm font-semibold text-zinc-900">
                                            {mobileFichajeResumen}
                                        </p>
                                    </div>

                                    <label className="flex items-center gap-2 select-none shrink-0">
                                        <input
                                            type="checkbox"
                                            className="h-4 w-4 rounded border-zinc-300"
                                            checked={turnoPartido}
                                            onChange={(e) => handleTurnoPartidoToggle(e.target.checked)}
                                            disabled={!selectedUserId}
                                        />
                                        <span className="text-xs text-zinc-700">Partido</span>
                                    </label>
                                </div>

                                <button
                                    type="button"
                                    onClick={handlePunch}
                                    disabled={ficharDisabled}
                                    className={cn(
                                        "mt-2 h-10 w-full rounded-2xl border border-black/5 shadow-sm",
                                        "transition active:scale-[0.98]",
                                        ficharTone === "action"
                                            ? "bg-black text-white hover:bg-black/90"
                                            : "bg-white text-zinc-900 hover:bg-zinc-50",
                                        ficharDisabled && "opacity-40 cursor-not-allowed active:scale-100",
                                    )}
                                >
                                    <span className="text-sm font-semibold">
                                        {loadingPunch ? "Cargando..." : ficharLabel}
                                    </span>
                                </button>
                            </div>
                        </div>

                        <div
                            className={cn(
                                "hidden sm:block",
                                "mt-4 lg:mt-0",
                                "lg:absolute lg:left-5 lg:right-10 lg:bottom-5",
                                showBottomBlock ? "lg:z-30 lg:pointer-events-auto" : "lg:z-10 lg:pointer-events-none",
                                "relative",
                            )}
                        >
                            <div
                                className={cn(
                                    "will-change-transform transform-gpu",
                                    "transition-[transform,opacity] duration-500 ease-[cubic-bezier(0.22,1,0.36,1)]",
                                    showBottomBlock ? "opacity-100 translate-y-0" : "opacity-0 translate-y-4",
                                )}
                            >
                                <div className="rounded-3xl border border-black/5 bg-white p-4 text-sm text-zinc-700">
                                    <p className="font-semibold text-zinc-900">Fichaje de hoy</p>

                                    {loadingPunch ? (
                                        <p className="mt-1 text-zinc-600">Comprobando...</p>
                                    ) : (
                                        <>
                                            <label className="mt-2 flex items-center gap-2 select-none">
                                                <input
                                                    type="checkbox"
                                                    className="h-4 w-4 rounded border-zinc-300"
                                                    checked={turnoPartido}
                                                    onChange={(e) => handleTurnoPartidoToggle(e.target.checked)}
                                                    disabled={!selectedUserId}
                                                />
                                                <span className="text-sm text-zinc-700">Hoy tienes turno partido</span>
                                            </label>

                                            <div className="mt-3 space-y-3">
                                                <div>
                                                    <p className="font-semibold text-zinc-900">Parte 1</p>
                                                    <p>
                                                        Entrada:{" "}
                                                        <span
                                                            className={cn(
                                                                "font-semibold",
                                                                hasEntrada1 ? "text-emerald-700" : "text-rose-700",
                                                            )}
                                                        >
                                                            {hasEntrada1 ? "OK" : "Pendiente"}
                                                        </span>
                                                    </p>
                                                    <p>
                                                        Salida:{" "}
                                                        <span
                                                            className={cn(
                                                                "font-semibold",
                                                                hasSalida1 ? "text-emerald-700" : "text-zinc-600",
                                                            )}
                                                        >
                                                            {hasSalida1 ? "OK" : "—"}
                                                        </span>
                                                    </p>
                                                </div>

                                                {turnoPartido ? (
                                                    <div>
                                                        <p className="font-semibold text-zinc-900">Parte 2</p>
                                                        <p>
                                                            Entrada:{" "}
                                                            <span
                                                                className={cn(
                                                                    "font-semibold",
                                                                    hasEntrada2 ? "text-emerald-700" : "text-rose-700",
                                                                )}
                                                            >
                                                                {hasEntrada2 ? "OK" : "Pendiente"}
                                                            </span>
                                                        </p>
                                                        <p>
                                                            Salida:{" "}
                                                            <span
                                                                className={cn(
                                                                    "font-semibold",
                                                                    hasSalida2 ? "text-emerald-700" : "text-zinc-600",
                                                                )}
                                                            >
                                                                {hasSalida2 ? "OK" : "—"}
                                                            </span>
                                                        </p>
                                                    </div>
                                                ) : null}

                                                {!hasEntrada1 ? (
                                                    <p className="text-amber-900">
                                                        Debes fichar entrada para poder entrar.
                                                    </p>
                                                ) : null}
                                            </div>
                                        </>
                                    )}
                                </div>

                                <div className="mt-3">
                                    <button
                                        type="button"
                                        onClick={handlePunch}
                                        disabled={ficharDisabled}
                                        className={cn(
                                            "h-14 w-full rounded-2xl border border-black/5 shadow-sm",
                                            "transition active:scale-[0.98]",
                                            ficharTone === "action"
                                                ? "bg-black text-white hover:bg-black/90"
                                                : "bg-white text-zinc-900 hover:bg-zinc-50",
                                            ficharDisabled && "opacity-40 cursor-not-allowed active:scale-100",
                                        )}
                                    >
                                        <span className="text-lg font-semibold">
                                            {loadingPunch ? "Cargando..." : ficharLabel}
                                        </span>
                                    </button>

                                    {selectedUser && !loadingPunch ? (
                                        <p className="mt-2 text-xs text-zinc-600">
                                            {!hasEntrada1
                                                ? "Para entrar en la app, primero ficha entrada."
                                                : "Puedes entrar. Si terminas tu jornada, ficha salida."}
                                        </p>
                                    ) : null}
                                </div>
                            </div>
                        </div>
                    </section>

                    <section
                        className={cn(
                            "rounded-3xl border border-black/5 bg-white/60 shadow-sm backdrop-blur",
                            "p-3 sm:p-5",
                            "min-h-0",
                            "lg:h-[calc(100vh-140px)] lg:max-h-[760px] lg:min-h-[540px]",
                            "overflow-hidden",
                        )}
                    >
                        <div className="flex items-start justify-between gap-3 sm:gap-4">
                            <div className="min-w-0">
                                <h2 className="text-base sm:text-lg font-semibold text-zinc-900">PIN</h2>
                                <p className="mt-1 text-[11px] sm:text-sm text-zinc-600 line-clamp-2">
                                    {selectedUser
                                        ? isSubmitting
                                            ? "Procesando..."
                                            : !hasEntrada1
                                                ? `Introduce PIN y ficha entrada (${selectedUser.nombre}).`
                                                : `Introduce el PIN (${selectedUser.nombre}).`
                                        : "Selecciona un usuario para habilitar el teclado."}
                                </p>
                            </div>

                            <button
                                type="button"
                                onClick={() => setSelectedUserId(null)}
                                className={cn(
                                    "rounded-2xl px-3 py-2 text-[11px] sm:text-sm font-semibold transition shrink-0",
                                    selectedUser && !isSubmitting
                                        ? "bg-black/5 text-zinc-800 hover:bg-black/10 active:scale-[0.98] cursor-pointer"
                                        : "bg-black/5 text-zinc-400 cursor-not-allowed",
                                )}
                                disabled={!selectedUser || isSubmitting}
                                title="Cambiar usuario"
                            >
                                Cambiar
                            </button>
                        </div>

                        <div className="mt-2 sm:mt-5 flex items-center justify-between rounded-2xl border border-black/5 bg-white/70 px-3 py-2 sm:px-4 sm:py-4">
                            <div className="min-w-0">
                                <p className="text-[10px] sm:text-xs font-medium text-zinc-500">PIN</p>
                                <p className="mt-0.5 truncate text-lg sm:text-2xl font-semibold tracking-[0.35em] text-zinc-900">
                                    {pinMasked || "— — — —"}
                                </p>
                            </div>

                            <div className="flex items-center gap-1.5 shrink-0">
                                <button
                                    type="button"
                                    onClick={handleBackspace}
                                    className={cn(
                                        "rounded-xl px-2 py-1.5 text-[11px] sm:text-sm font-semibold transition",
                                        canType
                                            ? "bg-black/5 text-zinc-800 hover:bg-black/10 active:scale-[0.98] cursor-pointer"
                                            : "bg-black/5 text-zinc-400 cursor-not-allowed",
                                    )}
                                    disabled={!canType}
                                    title="Borrar último"
                                >
                                    ⌫
                                </button>
                                <button
                                    type="button"
                                    onClick={handleClear}
                                    className={cn(
                                        "rounded-xl px-2 py-1.5 text-[11px] sm:text-sm font-semibold transition",
                                        canType
                                            ? "bg-black/5 text-zinc-800 hover:bg-black/10 active:scale-[0.98] cursor-pointer"
                                            : "bg-black/5 text-zinc-400 cursor-not-allowed",
                                    )}
                                    disabled={!canType}
                                    title="Limpiar"
                                >
                                    Limpiar
                                </button>
                            </div>
                        </div>

                        <div className="mt-2 sm:mt-5 grid grid-cols-3 gap-1.5 sm:gap-3">
                            {["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((d) => (
                                <button
                                    key={d}
                                    type="button"
                                    onClick={() => handleDigit(d)}
                                    disabled={!canType}
                                    className={cn(
                                        "h-10 xs:h-11 sm:h-14 w-full rounded-xl sm:rounded-2xl border border-black/5 shadow-sm",
                                        "backdrop-blur transition active:scale-[0.98]",
                                        !canType
                                            ? "opacity-40 cursor-not-allowed"
                                            : "bg-white/70 text-zinc-900 hover:bg-white cursor-pointer",
                                    )}
                                >
                                    <span className="text-base xs:text-lg font-semibold">{d}</span>
                                </button>
                            ))}

                            <button
                                type="button"
                                onClick={() => handleDigit("0")}
                                disabled={!canType}
                                className={cn(
                                    "h-10 xs:h-11 sm:h-14 w-full rounded-xl sm:rounded-2xl border border-black/5 shadow-sm",
                                    "backdrop-blur transition active:scale-[0.98]",
                                    !canType
                                        ? "opacity-40 cursor-not-allowed"
                                        : "bg-white/70 text-zinc-900 hover:bg-white cursor-pointer",
                                )}
                            >
                                <span className="text-base xs:text-lg font-semibold">0</span>
                            </button>

                            <button
                                type="button"
                                onClick={handleSubmit}
                                disabled={!canEnter}
                                className={cn(
                                    "h-10 xs:h-11 sm:h-14 w-full rounded-xl sm:rounded-2xl border border-black/5 shadow-sm",
                                    "backdrop-blur transition active:scale-[0.98]",
                                    canEnter
                                        ? "bg-black text-white hover:bg-black/90 cursor-pointer"
                                        : "opacity-40 cursor-not-allowed bg-white/70 text-zinc-900",
                                )}
                            >
                                <span className="text-sm xs:text-base sm:text-lg font-semibold">
                                    Entrar
                                </span>
                            </button>

                            <button
                                type="button"
                                onClick={() => {
                                    if (!requireUserOrWarn()) return;
                                    if (isSubmitting) return;
                                    pinRef.current = "";
                                    setPin("");
                                }}
                                disabled={!canType}
                                className={cn(
                                    "h-10 xs:h-11 sm:h-14 w-full rounded-xl sm:rounded-2xl border border-black/5 shadow-sm",
                                    "backdrop-blur transition active:scale-[0.98]",
                                    canType
                                        ? "bg-rose-600 text-white hover:bg-rose-500 cursor-pointer"
                                        : "opacity-40 cursor-not-allowed bg-white/70 text-zinc-900",
                                )}
                            >
                                <span className="text-sm xs:text-base sm:text-lg font-semibold">
                                    Cancelar
                                </span>
                            </button>
                        </div>
                    </section>
                </div>
            </div>
        </div>
    );
}