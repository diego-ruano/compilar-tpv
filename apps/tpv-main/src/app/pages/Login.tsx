import { commands } from "@tpv/client";
import { todayLocalYmd } from "../../features/login/fechaJornada";
import type { UserListItem as DbUser, PunchStatus } from "@tpv/contracts";
import { toAppError } from "@tpv/client";
import React, { useEffect, useMemo, useRef, useState } from "react";
import {
    Delete,
    LogIn,
    Users,
    Lock,
    RotateCw,
    Eye,
    EyeOff,
    Check,
    UserRound,
    Store,
    Lightbulb,
} from "lucide-react";
import LogoAltaria from "../../assets/img/logo-altaria-azul-transparente.png";
import { useNavigate } from "react-router-dom";
import { useBusinessSettings } from "../../shared/stores/useBusinessSettings";
import { useImageUrl } from "../../shared/lib/useImageUrl";
import { useToast } from "../../shared/toast";
import { useAuth } from "../../shared/stores/useAuth";
import { useMode } from "../../shared/stores/useMode";
import { Button, IconButton, ThemeToggle } from "../../shared/ui";


import RecuperarPinModal from "../../features/login/RecuperarPinModal";
import { conAviso } from "../../shared/lib/conAviso";
import ControlesVentana from "../layoutComponent/ControlesVentana";
import { ROL_ADMIN } from "../../shared/lib/permisos";

function cn(...classes: Array<string | false | undefined | null>) {
    return classes.filter(Boolean).join(" ");
}

// Paleta de colores suaves para los avatares (determinista por usuario).
// Funcionan bien tanto en claro como en oscuro (tinte translúcido).
const AVATAR_PALETTE = [
    "bg-[#2B81D4]/15 text-[#2B81D4]",
    "bg-sky-500/15 text-sky-500",
    "bg-emerald-500/15 text-emerald-500",
    "bg-amber-500/15 text-amber-500",
    "bg-rose-500/15 text-rose-500",
    "bg-cyan-500/15 text-cyan-500",
    "bg-[#0F2C56]/15 text-[#0F2C56]",
    "bg-[#016FFC]/15 text-[#016FFC]",
];

function avatarColor(seed: string): string {
    // Hash estable del id (UUID string) a un índice de la paleta.
    let h = 0;
    for (const ch of String(seed || "")) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    const idx = h % AVATAR_PALETTE.length;
    return AVATAR_PALETTE[idx];
}

// Consejos rotativos que se muestran en el panel del PIN.
const LOGIN_TIPS = [
    "Puedes escribir el PIN con el teclado físico y pulsar Enter para entrar.",
    "Pulsa el icono del ojo para ver el PIN mientras lo escribes.",
    "Recuerda fichar tu entrada antes de empezar tu jornada.",
    "Alterna entre tema claro y oscuro desde el botón de la barra superior.",
    "Selecciona tu usuario y se habilitará el teclado numérico.",
    "¿Turno partido? Márcalo en el panel de fichaje para registrar dos tramos.",
    "Usa “Cambiar usuario” si te has equivocado de cuenta.",
];

export default function Login() {
    const setSession = useAuth((s) => s.setSession);
    const navigate = useNavigate();
    const toast = useToast();
    const deviceMode = useMode((s) => s.mode);
    const { business_name, logo_data_url } = useBusinessSettings();
    // Ruta relativa → URL utilizable (ver `useImageUrl`).
    const logoSrc = useImageUrl(logo_data_url);

    const [users, setUsers] = useState<DbUser[]>([]);
    const [loadingUsers, setLoadingUsers] = useState(true);

    const [isSubmitting, setIsSubmitting] = useState(false);
    const [selectedUserId, setSelectedUserId] = useState<string | null>(null);

    const selectedUser = useMemo(
        () => users.find((u) => u.id_usuario === selectedUserId) ?? null,
        [users, selectedUserId],
    );

    const [pin, setPin] = useState("");
    const pinRef = useRef(pin);

    // Solo visual: mostrar/ocultar el PIN en el display (no afecta a la lógica).
    const [showPin, setShowPin] = useState(false);

    // LOGIN-07: recuperar el PIN por correo. Sólo administradores y sólo en la Main: a los demás
    // se lo cambia un administrador desde Trabajadores, y la Handy no guarda PINs.
    const [recuperandoPin, setRecuperandoPin] = useState(false);
    const puedeRecuperarPin =
        deviceMode !== "handy" && selectedUser?.nombre_rol === ROL_ADMIN;

    // Solo visual: consejo rotativo del panel del PIN.
    const [tipIndex, setTipIndex] = useState(0);

    useEffect(() => {
        const id = window.setInterval(() => {
            setTipIndex((i) => (i + 1) % LOGIN_TIPS.length);
        }, 6000);
        return () => window.clearInterval(id);
    }, []);

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
    // RI-05: con un turno de noche en curso, el estado es el de la jornada que empezó ayer.
    const jornadaDeAyer = Boolean(punchStatus?.fecha) && punchStatus?.fecha !== todayLocalYmd();

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

    const faltaSegundaEntrada = turnoPartido && hasSalida1 && !hasEntrada2;
    const canEnter = canType && !loadingPunch && hasEntrada1 && !faltaSegundaEntrada && pinOk;
    const accionEnCursoRef = useRef(false);

    const showBottomBlock = Boolean(selectedUser);

    const refreshPunch = async (uid: string) => {
        const st = await commands.getTodayPunchStatus({ id_usuario: uid });
        setPunchStatus(st);
    };

    useEffect(() => {
        let mounted = true;

        void (async () => {
            try {
                setLoadingUsers(true);
                const arr = await commands.listLoginUsers();
                if (!mounted) return;
                setUsers(arr ?? []);
            } catch (e) {
                toast.error("No se pudieron cargar los usuarios", toAppError(e).message);
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
        void (async () => {
            try {
                setLoadingPunch(true);
                const st = await commands.getTodayPunchStatus({
                    id_usuario: selectedUserId,
                });
                if (!mounted) return;
                setPunchStatus(st);
            } catch (e) {
                if (!mounted) return;
                setPunchStatus(null);
                toast.error("No se pudo comprobar el fichaje", toAppError(e).message);
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
        if (!selectedUserId || accionEnCursoRef.current || loadingPunch || hasEntrada2) return;
        accionEnCursoRef.current = true;
        try {
            setLoadingPunch(true);
            await commands.setTurnoPartidoHoy({
                id_usuario: selectedUserId,
                turno_partido: checked,
                fecha: punchStatus?.fecha,
            });
            await refreshPunch(selectedUserId);
            toast.success(
                "Turno actualizado",
                checked ? "Marcado como turno partido." : "Turno partido desactivado.",
            );
        } catch (e) {
            toast.error("No se pudo guardar turno partido", toAppError(e).message);
        } finally {
            accionEnCursoRef.current = false;
            setLoadingPunch(false);
        }
    };

    const handlePunch = async () => {
        if (accionEnCursoRef.current || loadingPunch) return;
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

        accionEnCursoRef.current = true;
        setIsSubmitting(true);
        setLoadingPunch(true);

        try {
            const st = await commands.punch({
                id_usuario: selectedUserId!,
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
        } catch (e) {
            toast.error("No se pudo fichar", toAppError(e).message);
        } finally {
            accionEnCursoRef.current = false;
            setIsSubmitting(false);
            setLoadingPunch(false);
        }
    };

    const handleSubmit = async () => {
        if (accionEnCursoRef.current || loadingPunch) return;
        if (!requireUserOrWarn()) return;

        const currentPin = pinRef.current.trim();
        if (currentPin.length < 4) {
            toast.info("PIN incompleto", "Introduce al menos 4 dígitos.");
            return;
        }

        if (!hasEntrada1 || faltaSegundaEntrada) {
            toast.warning(faltaSegundaEntrada ? "Debes fichar la segunda entrada antes de entrar" : "Debes fichar entrada antes de entrar");
            return;
        }
        accionEnCursoRef.current = true;
        setIsSubmitting(true);

        try {
            const ok = await commands.loginUser({
                id_usuario: selectedUserId!,
                pin: currentPin,
            });

            if (!ok.rol || !ok.id_usuario) {
                throw new Error("Login sin datos de sesión válidos");
            }

            // El setup inicial (cambiar PIN/email del admin) es responsabilidad de la MAIN.
            // En un Handy NO entramos al flujo de /setup: hacerlo provoca un bucle de
            // redirección (el guard fuerza /setup y SetupInicial expulsa al Handy) → pantalla
            // en blanco. Ignoramos requiere_setup en Handy y entramos como un login normal.
            if (ok.requiere_setup === 1 && deviceMode !== "handy") {
                setSession({
                    role: ok.rol,
                    idUsuario: ok.id_usuario,
                    idTrabajador: ok.id_trabajador,
                    nombre: ok.nombre,
                    requiresSetup: true,
                    email: ok.email,
                });

                void navigate("/setup", { replace: true });
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

            void navigate(ok.rol === "Cocinero" ? "/Comandas" : "/", { replace: true });
        } catch (e) {
            toast.error("Acceso denegado", toAppError(e).message);
            pinRef.current = "";
            setPin("");
        } finally {
            accionEnCursoRef.current = false;
            setIsSubmitting(false);
        }
    };

    useEffect(() => {
        const onKeyDown = (e: KeyboardEvent) => {
            if (!selectedUser) return;
            // Con el modal abierto, el teclado es suyo: Enter no puede intentar entrar ni fichar.
            if (recuperandoPin) return;

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
                if (!hasEntrada1) void handlePunch();
                else void handleSubmit();
            }
        };

        window.addEventListener("keydown", onKeyDown);
        return () => window.removeEventListener("keydown", onKeyDown);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [selectedUser, isSubmitting, hasEntrada1, recuperandoPin]);

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
        <div className="relative h-dvh overflow-hidden bg-bg text-fg">
            {/* Glow decorativo de fondo (sutil, más visible en oscuro) */}
            <div className="pointer-events-none absolute inset-0 overflow-hidden">
                <div className="absolute -left-24 -top-24 size-80 rounded-full bg-accent/10 blur-3xl" />
                <div className="absolute -bottom-32 -right-16 size-96 rounded-full bg-accent/5 blur-3xl" />
            </div>

            {/* Barra de título (drag region + controles de ventana) */}
            <div className="absolute top-0 left-0 right-0 z-50 flex justify-between shrink-0 border-b border-border bg-surface">
                <div
                    className="flex min-w-0 flex-1 items-center gap-2 p-1.5 sm:gap-3"
                    data-tauri-drag-region
                >
                    <img
                        src={logoSrc || LogoAltaria}
                        className="size-6 rounded-md object-cover"
                        data-tauri-drag-region
                        alt="logo"
                    />
                    <p
                        data-tauri-drag-region
                        className="min-w-0 max-w-[35vw] truncate text-sm font-semibold text-fg sm:max-w-60"
                    >
                        {business_name || "TPV"}
                    </p>
                </div>
                <div className="flex w-fit items-center gap-1 p-1 px-1.5">
                    <ThemeToggle size="sm" />
                    <ControlesVentana />
                </div>
            </div>

            <div className="h-full touch-pan-y overflow-y-auto overscroll-contain pt-11 sm:pt-12">
                <div className="mx-auto flex min-h-[calc(100dvh-44px)] w-full max-w-6xl items-start justify-center px-2 py-3 sm:min-h-[calc(100dvh-48px)] sm:px-4 sm:py-4 lg:items-center">
                    <div className="grid w-full grid-cols-1 gap-3 lg:grid-cols-2 lg:gap-6">
                    {/* ===== Columna izquierda: selección de usuario + fichaje ===== */}
                    <section
                        className={cn(
                            "relative flex flex-col rounded-3xl border border-border bg-surface shadow-sm",
                            "p-3 sm:p-5",
                            "min-h-0",
                            "lg:h-[clamp(520px,calc(100dvh-80px),680px)]",
                        )}
                    >
                        <div className="flex flex-col items-stretch gap-3 xs:flex-row xs:items-start xs:justify-between">
                            <div className="flex min-w-0 items-center gap-3">
                                <div className="grid size-10 shrink-0 place-items-center rounded-2xl bg-accent-soft text-accent">
                                    <Store className="size-5" aria-hidden />
                                </div>
                                <div className="min-w-0">
                                    <h1 className="truncate text-base font-bold text-fg sm:text-xl">
                                        Bienvenido a{" "}
                                        <span className="text-accent">{business_name || "TPV"}</span>
                                    </h1>
                                    <p className="mt-0.5 text-[11px] text-fg-muted sm:text-sm">
                                        Selecciona tu usuario e inicia sesión para continuar.
                                    </p>
                                </div>
                            </div>

                            {selectedUser ? (
                                <div className="flex max-w-full shrink-0 self-end items-center gap-2 rounded-full border border-border bg-surface-2 px-3 py-1.5 text-[11px] xs:self-auto sm:text-sm">
                                    <span className="grid size-5 place-items-center rounded-full bg-accent/15 text-accent">
                                        <UserRound className="size-3" aria-hidden />
                                    </span>
                                    <span className="max-w-[120px] truncate font-semibold text-fg">
                                        {selectedUser.nombre}
                                    </span>
                                </div>
                            ) : (
                                <div className="flex max-w-full shrink-0 self-end items-center gap-2 rounded-full border border-border bg-surface-2 px-3 py-1.5 text-[11px] font-medium text-fg-muted xs:self-auto sm:text-sm">
                                    <UserRound className="size-3.5" aria-hidden />
                                    Sin usuario
                                </div>
                            )}
                        </div>

                        {/* Carrusel de usuarios (móvil) */}
                        <div className="mt-2 sm:hidden">
                            {loadingUsers ? (
                                <div className="rounded-3xl border border-border bg-surface-2 p-3 text-sm text-fg-muted">
                                    Cargando usuarios...
                                </div>
                            ) : users.length === 0 ? (
                                <div className="rounded-3xl border border-border bg-surface-2 p-3 text-sm text-fg-muted">
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
                                                disabled={isSubmitting || loadingPunch}
                                                onClick={() => setSelectedUserId(u.id_usuario)}
                                                className={cn(
                                                    "shrink-0 w-[118px] xs:w-[126px]",
                                                    "rounded-xl border px-2 py-1.5 text-left transition active:scale-[0.99] cursor-pointer",
                                                    active
                                                        ? "border-accent bg-accent-soft ring-2 ring-ring"
                                                        : "border-border bg-surface hover:bg-surface-2",
                                                )}
                                            >
                                                <div className="flex items-center gap-2">
                                                    <div
                                                        className={cn(
                                                            "grid size-7 shrink-0 place-items-center rounded-full text-[11px] font-bold",
                                                            avatarColor(u.id_usuario),
                                                        )}
                                                    >
                                                        {initial}
                                                    </div>

                                                    <div className="min-w-0">
                                                        <p className="truncate text-[11px] font-semibold leading-4 text-fg">
                                                            {fullName}
                                                        </p>
                                                        <p className="truncate text-[10px] leading-4 text-fg-muted">
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

                        {/* Grid de usuarios (desktop) */}
                        <div
                            className={cn(
                                "mt-5 hidden sm:flex sm:flex-1 sm:flex-col",
                                "min-h-0 overflow-y-auto pr-0 lg:pr-1",
                                showBottomBlock ? "lg:pb-[270px]" : "pb-0",
                            )}
                        >
                            <div className="mb-1 flex shrink-0 items-center gap-2 px-1 text-fg-muted">
                                <Users className="size-4" aria-hidden />
                                <span className="text-xs font-semibold uppercase tracking-wide">
                                    Usuarios
                                </span>
                            </div>

                            {loadingUsers ? (
                                <div className="rounded-2xl border border-border bg-surface-2 p-4 text-sm text-fg-muted">
                                    Cargando usuarios...
                                </div>
                            ) : users.length === 0 ? (
                                <div className="rounded-2xl border border-border bg-surface-2 p-4 text-sm text-fg-muted">
                                    No hay usuarios en la base de datos.
                                </div>
                            ) : (
                                <div className="grid grid-cols-1 gap-3 p-1 sm:grid-cols-2">
                                    {users.map((u) => {
                                        const active = u.id_usuario === selectedUserId;
                                        const initial = (u.nombre?.[0] ?? "?").toUpperCase();
                                        const fullName = `${u.nombre}${u.apellido ? " " + u.apellido : ""}`;

                                        return (
                                            <button
                                                key={u.id_usuario}
                                                type="button"
                                                disabled={isSubmitting || loadingPunch}
                                                onClick={() => setSelectedUserId(u.id_usuario)}
                                                className={cn(
                                                    "group relative rounded-2xl border p-3.5 text-left transition active:scale-[0.99] cursor-pointer",
                                                    active
                                                        ? "border-accent bg-accent-soft ring-1 ring-accent/40 shadow-sm"
                                                        : "border-border bg-surface hover:bg-surface-2 hover:border-border-strong",
                                                )}
                                            >
                                                {active && (
                                                    <span className="absolute right-2.5 top-2.5 grid size-5 place-items-center rounded-full bg-accent text-accent-fg shadow-sm">
                                                        <Check className="size-3" aria-hidden />
                                                    </span>
                                                )}
                                                <div className="flex items-center gap-3">
                                                    <div
                                                        className={cn(
                                                            "grid size-11 shrink-0 place-items-center rounded-full text-base font-bold",
                                                            avatarColor(u.id_usuario),
                                                        )}
                                                    >
                                                        {initial}
                                                    </div>
                                                    <div className="min-w-0">
                                                        <p className="truncate text-sm font-semibold text-fg">
                                                            {fullName}
                                                        </p>
                                                        <p className="truncate text-xs text-fg-muted">
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

                        {/* Fichaje (móvil) */}
                        <div className="mt-2 sm:hidden">
                            <div className="rounded-3xl border border-border bg-surface-2 p-3">
                                <div className="flex items-center justify-between gap-3">
                                    <div className="min-w-0">
                                        <p className="text-[10px] font-medium text-fg-subtle">Fichaje</p>
                                        <p className="truncate text-sm font-semibold text-fg">
                                            {mobileFichajeResumen}
                                        </p>
                                    </div>

                                    <label className="flex shrink-0 select-none items-center gap-2">
                                        <input
                                            type="checkbox"
                                            className="h-4 w-4 rounded border-border accent-accent"
                                            checked={turnoPartido}
                                            onChange={conAviso((e) => handleTurnoPartidoToggle(e.target.checked))}
                                            disabled={!selectedUserId || loadingPunch || isSubmitting || hasEntrada2}
                                        />
                                        <span className="text-xs text-fg-muted">Partido</span>
                                    </label>
                                </div>

                                <Button
                                    variant={ficharTone === "action" ? "primary" : "secondary"}
                                    fullWidth
                                    onClick={conAviso(handlePunch)}
                                    disabled={ficharDisabled}
                                    className="mt-2"
                                >
                                    {loadingPunch ? "Cargando..." : ficharLabel}
                                </Button>
                            </div>
                        </div>

                        {/* Fichaje (desktop) */}
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
                                <div className="rounded-3xl border border-border bg-surface-2 p-4 text-sm text-fg-muted">
                                    <p className="font-semibold text-fg">
                                        {jornadaDeAyer ? "Jornada de ayer" : "Fichaje de hoy"}
                                    </p>

                                    {loadingPunch ? (
                                        <p className="mt-1 text-fg-muted">Comprobando...</p>
                                    ) : (
                                        <>
                                            <label className="mt-2 flex select-none items-center gap-2">
                                                <input
                                                    type="checkbox"
                                                    className="h-4 w-4 rounded border-border accent-accent"
                                                    checked={turnoPartido}
                                                    onChange={conAviso((e) => handleTurnoPartidoToggle(e.target.checked))}
                                                    disabled={!selectedUserId || loadingPunch || isSubmitting || hasEntrada2}
                                                />
                                                <span className="text-sm text-fg-muted">
                                                    {jornadaDeAyer ? "Ayer tenías turno partido" : "Hoy tienes turno partido"}
                                                </span>
                                            </label>

                                            <div className="mt-3 space-y-3">
                                                <div>
                                                    <p className="font-semibold text-fg">Parte 1</p>
                                                    <p>
                                                        Entrada:{" "}
                                                        <span
                                                            className={cn(
                                                                "font-semibold",
                                                                hasEntrada1 ? "text-success" : "text-danger",
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
                                                                hasSalida1 ? "text-success" : "text-fg-muted",
                                                            )}
                                                        >
                                                            {hasSalida1 ? "OK" : "—"}
                                                        </span>
                                                    </p>
                                                </div>

                                                {turnoPartido ? (
                                                    <div>
                                                        <p className="font-semibold text-fg">Parte 2</p>
                                                        <p>
                                                            Entrada:{" "}
                                                            <span
                                                                className={cn(
                                                                    "font-semibold",
                                                                    hasEntrada2 ? "text-success" : "text-danger",
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
                                                                    hasSalida2 ? "text-success" : "text-fg-muted",
                                                                )}
                                                            >
                                                                {hasSalida2 ? "OK" : "—"}
                                                            </span>
                                                        </p>
                                                    </div>
                                                ) : null}

                                                {(!hasEntrada1 || faltaSegundaEntrada) ? (
                                                    <p className="text-warning">
                                                        {faltaSegundaEntrada ? "Debes fichar la segunda entrada para poder entrar." : "Debes fichar entrada para poder entrar."}
                                                    </p>
                                                ) : null}
                                            </div>
                                        </>
                                    )}
                                </div>

                                <div className="mt-3">
                                    <Button
                                        variant={ficharTone === "action" ? "primary" : "secondary"}
                                        size="lg"
                                        fullWidth
                                        onClick={conAviso(handlePunch)}
                                        disabled={ficharDisabled}
                                    >
                                        {loadingPunch ? "Cargando..." : ficharLabel}
                                    </Button>

                                    {selectedUser && !loadingPunch ? (
                                        <p className="mt-2 text-xs text-fg-muted">
                                            {!hasEntrada1
                                                ? "Para entrar en la app, primero ficha entrada."
                                                : faltaSegundaEntrada ? "Para volver a entrar, ficha la segunda entrada."
                                                : "Puedes entrar. Si terminas tu jornada, ficha salida."}
                                        </p>
                                    ) : null}
                                </div>
                            </div>
                        </div>
                    </section>

                    {/* ===== Columna derecha: PIN ===== */}
                    <section
                        className={cn(
                            "flex flex-col rounded-3xl border border-border bg-surface shadow-sm",
                            "p-3 sm:p-5",
                            "min-h-0",
                            "lg:h-[clamp(520px,calc(100dvh-80px),680px)]",
                            "overflow-y-auto overscroll-contain",
                        )}
                    >
                        <div className="flex flex-col items-stretch gap-3 xs:flex-row xs:items-start xs:justify-between sm:gap-4">
                            <div className="flex min-w-0 items-center gap-3">
                                <div className="grid size-10 shrink-0 place-items-center rounded-2xl bg-accent-soft text-accent">
                                    <Lock className="size-5" aria-hidden />
                                </div>
                                <div className="min-w-0">
                                    <h2 className="text-base font-bold text-fg sm:text-lg">
                                        PIN de acceso
                                    </h2>
                                    <p className="mt-0.5 line-clamp-2 text-[11px] text-fg-muted sm:text-sm">
                                        {selectedUser
                                            ? isSubmitting
                                                ? "Procesando..."
                                                : !hasEntrada1
                                                    ? `Introduce PIN y ficha entrada (${selectedUser.nombre}).`
                                                    : "Introduce tu PIN para habilitar el teclado."
                                            : "Selecciona un usuario para habilitar el teclado."}
                                    </p>
                                </div>
                            </div>

                            <Button
                                variant="secondary"
                                onClick={() => setSelectedUserId(null)}
                                disabled={!selectedUser || isSubmitting || loadingPunch}
                                title="Cambiar usuario"
                                leftIcon={<RotateCw className="size-4" aria-hidden />}
                                className="w-full shrink-0 xs:w-auto"
                            >
                                Cambiar usuario
                            </Button>
                        </div>

                        {/* Display del PIN (puntos indicadores + mostrar/ocultar) */}
                        <div className="mt-2 flex items-center justify-between gap-3 rounded-2xl border border-border bg-surface-2 px-3 py-3 sm:mt-5 sm:px-4 sm:py-4">
                            <div className="flex min-h-9 flex-1 items-center gap-2.5">
                                {Array.from({ length: Math.max(4, pin.length) }).map((_, i) => {
                                    const filled = i < pin.length;

                                    if (showPin && filled) {
                                        return (
                                            <span
                                                key={i}
                                                className="text-xl font-bold tabular-nums text-fg"
                                            >
                                                {pin[i]}
                                            </span>
                                        );
                                    }

                                    return (
                                        <span
                                            key={i}
                                            className={cn(
                                                "size-3 rounded-full transition",
                                                filled ? "bg-accent" : "bg-fg-subtle/30",
                                            )}
                                        />
                                    );
                                })}
                            </div>

                            <div className="flex shrink-0 items-center gap-1.5">
                                <IconButton
                                    size="sm"
                                    variant="ghost"
                                    label={showPin ? "Ocultar PIN" : "Mostrar PIN"}
                                    onClick={() => setShowPin((v) => !v)}
                                >
                                    {showPin ? (
                                        <EyeOff className="size-4" aria-hidden />
                                    ) : (
                                        <Eye className="size-4" aria-hidden />
                                    )}
                                </IconButton>
                                <Button
                                    variant="secondary"
                                    size="sm"
                                    onClick={handleClear}
                                    disabled={!canType}
                                    title="Limpiar"
                                >
                                    Limpiar
                                </Button>
                            </div>
                        </div>

                        {/* Teclado numérico */}
                        <div className="mt-2 grid shrink-0 grid-cols-3 gap-2 sm:mt-[clamp(0.75rem,2dvh,1.25rem)] sm:gap-[clamp(0.5rem,1.2dvh,0.75rem)]">
                            {["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((d) => (
                                <button
                                    key={d}
                                    type="button"
                                    onClick={() => handleDigit(d)}
                                    disabled={!canType}
                                    className={cn(
                                        "h-11 w-full rounded-xl border sm:h-[clamp(2.75rem,7dvh,4rem)] sm:rounded-2xl",
                                        "text-lg font-semibold sm:text-2xl transition active:scale-[0.97]",
                                        !canType
                                            ? "cursor-not-allowed border-border bg-surface-2 text-fg-subtle opacity-50"
                                            : "cursor-pointer border-border bg-surface text-fg shadow-sm hover:border-border-strong hover:bg-surface-2",
                                    )}
                                >
                                    {d}
                                </button>
                            ))}

                            <button
                                type="button"
                                onClick={() => handleDigit("0")}
                                disabled={!canType}
                                className={cn(
                                    "h-11 w-full rounded-xl border sm:h-[clamp(2.75rem,7dvh,4rem)] sm:rounded-2xl",
                                    "text-lg font-semibold sm:text-2xl transition active:scale-[0.97]",
                                    !canType
                                        ? "cursor-not-allowed border-border bg-surface-2 text-fg-subtle opacity-50"
                                        : "cursor-pointer border-border bg-surface text-fg shadow-sm hover:border-border-strong hover:bg-surface-2",
                                )}
                            >
                                0
                            </button>

                            <button
                                type="button"
                                onClick={handleBackspace}
                                disabled={!canType}
                                aria-label="Borrar último"
                                title="Borrar último"
                                className={cn(
                                    "inline-flex h-11 w-full items-center justify-center rounded-xl border sm:h-[clamp(2.75rem,7dvh,4rem)] sm:rounded-2xl",
                                    "transition active:scale-[0.97]",
                                    !canType
                                        ? "cursor-not-allowed border-border bg-surface-2 text-fg-subtle opacity-50"
                                        : "cursor-pointer border-border bg-surface text-fg-muted shadow-sm hover:border-border-strong hover:bg-surface-2 hover:text-fg",
                                )}
                            >
                                <Delete className="size-5 sm:size-6" aria-hidden />
                            </button>

                            <button
                                type="button"
                                onClick={conAviso(handleSubmit)}
                                disabled={!canEnter}
                                className={cn(
                                    "inline-flex h-11 w-full items-center justify-center gap-2 rounded-xl sm:h-[clamp(2.75rem,7dvh,4rem)] sm:rounded-2xl",
                                    "text-base font-semibold sm:text-lg transition active:scale-[0.97]",
                                    canEnter
                                        ? "cursor-pointer bg-accent text-accent-fg shadow-sm hover:bg-accent-hover"
                                        : "cursor-not-allowed bg-surface-2 text-fg-subtle opacity-50",
                                )}
                            >
                                <LogIn className="size-5" aria-hidden />
                                Entrar
                            </button>
                        </div>

                        {puedeRecuperarPin ? (
                            <button
                                type="button"
                                onClick={() => setRecuperandoPin(true)}
                                disabled={isSubmitting}
                                className="mt-3 shrink-0 cursor-pointer self-center text-sm font-medium text-accent hover:underline disabled:cursor-not-allowed disabled:opacity-50"
                            >
                                ¿Has olvidado el PIN?
                            </button>
                        ) : null}

                        {/* Consejos rotativos (rellenan el espacio inferior del panel) */}
                        <div className="mt-3 hidden min-h-fit shrink-0 items-end sm:flex lg:mt-[clamp(0.5rem,1.5dvh,0.75rem)]">
                            <div className="w-full rounded-2xl border border-border bg-surface-2 p-4">
                                <div className="flex items-center gap-2 text-accent">
                                    <Lightbulb className="size-4" aria-hidden />
                                    <span className="text-xs font-semibold uppercase tracking-wide">
                                        Consejo
                                    </span>
                                </div>
                                <p
                                    key={tipIndex}
                                    className="animate-tip mt-1.5 text-sm leading-relaxed text-fg-muted"
                                >
                                    {LOGIN_TIPS[tipIndex]}
                                </p>
                            </div>
                        </div>
                    </section>
                    </div>
                </div>
            </div>

            {recuperandoPin && selectedUser ? (
                <RecuperarPinModal
                    usuario={selectedUser}
                    onCerrar={() => setRecuperandoPin(false)}
                    onRecuperado={() => {
                        setRecuperandoPin(false);
                        pinRef.current = "";
                        setPin("");
                        toast.success("PIN cambiado", "Ya puedes entrar con tu PIN nuevo.");
                    }}
                />
            ) : null}
        </div>
    );
}
