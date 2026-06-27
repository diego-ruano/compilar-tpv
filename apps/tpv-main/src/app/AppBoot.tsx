// src/AppBoot.tsx
import React, { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { RouterProvider } from "react-router-dom";
import {
    ArrowRight,
    Building2,
    Check,
    Database,
    Fingerprint,
    KeyRound,
    Link2,
    Mail,
    MapPin,
    Monitor,
    Phone,
    QrCode,
    RotateCcw,
    ScanLine,
    ShieldCheck,
    Smartphone,
    Store,
    Wifi,
} from "lucide-react";

import { useMode, type DeviceMode, type ModeStateValue } from "../shared/stores/useMode";
import { useConnectionMode } from "../shared/stores/useConnectionMode";
import { useMainPresence } from "../shared/stores/useMainPresence";
import { useBusinessSettings } from "../shared/stores/useBusinessSettings";
import { useContactSettings } from "../shared/stores/useContactSettings";
import { useTicketSettings } from "../shared/stores/useTicketSettings";
import { cloudPost } from "../shared/lib/cloudApi";
import { deviceFingerprint } from "../shared/lib/deviceFingerprint";
import { useMainSocket } from "../shared/lib/useMainSocket";
import { useHandySocket } from "../shared/lib/useHandySocket";
import { queryClient } from "../shared/lib/queryClient";
import UpdateBanner from "../shared/ui/UpdateBanner";
import { Badge, Button, Card, Input } from "../shared/ui";
import Titlebar from "./layoutComponent/Titlebar";

import LogoAltaria from "../assets/img/logo.png";

/* =========================
   Pairing helpers
========================= */

function parsePairUri(
    raw: string,
): { pairCode: string; pairSecret: string } | null {
    const s = String(raw || "").trim();

    if (/^\d{6}$/.test(s)) return { pairCode: s, pairSecret: "" };
    if (!s.toLowerCase().startsWith("tpv://pair")) return null;

    try {
        const u = new URL(s.replace(/^tpv:\/\//i, "https://"));
        const pairCode = (u.searchParams.get("code") || "").trim();
        const pairSecret = (u.searchParams.get("secret") || "").trim();

        if (!/^\d{6}$/.test(pairCode)) return null;

        return { pairCode, pairSecret };
    } catch {
        return null;
    }
}

type LicenseLocalState = {
    tenantId?: string;
    tenant_id?: string;
    deviceId?: string;
    device_id?: string;
    token: string;
    status?: string | null;
    expiresAt?: string | null;
    expires_at?: string | null;
    lastServerTimeMs?: number | null;
    last_server_time_ms?: number | null;

    lastCheckOkMs?: number | null;
    last_check_ok_ms?: number | null;
    lastCheckAttemptMs?: number | null;
    last_check_attempt_ms?: number | null;

    activatedAtMs?: number;
    activated_at_ms?: number;
};

type GateResult = {
    allowed: boolean;
    reason: string;
    state: LicenseLocalState | null;
};

function cn(...classes: Array<string | false | undefined | null>) {
    return classes.filter(Boolean).join(" ");
}

function isDeviceMode(value: unknown): value is DeviceMode | null {
    return value === "tpv" || value === "handy" || value === null;
}

function BlockedScreen({
    reason,
    onRetry,
    onClear,
}: {
    reason: string;
    onRetry: () => void;
    onClear: () => void;
}) {
    return (
        <div className="min-h-full w-full bg-slate-100 flex items-center justify-center p-6">
            <div className="w-full max-w-lg rounded-2xl bg-white shadow-sm border border-slate-200 p-6">
                <h1 className="text-2xl font-semibold text-slate-900">
                    Licencia bloqueada
                </h1>
                <p className="text-sm text-slate-600 mt-2">
                    Motivo: <span className="font-mono">{reason}</span>
                </p>

                <div className="mt-5 flex gap-3">
                    <button
                        onClick={onRetry}
                        className="flex-1 rounded-xl bg-indigo-600 text-white py-3 font-semibold hover:bg-indigo-700"
                    >
                        Reintentar comprobación
                    </button>
                    <button
                        onClick={onClear}
                        className="rounded-xl border border-slate-300 bg-white py-3 px-4 font-semibold text-slate-700 hover:bg-slate-50"
                    >
                        Borrar licencia
                    </button>
                </div>

                <div className="mt-4 text-xs text-slate-500">
                    Si estabas sin internet y se acabó la gracia offline, vuelve
                    a conectar y reintenta.
                </div>
            </div>
        </div>
    );
}

function HandyWaitingMain({
    connecting,
    onUnlink,
}: {
    connecting: boolean;
    onUnlink: () => void;
}) {
    return (
        <div className="relative min-h-full w-full bg-slate-100 flex items-center justify-center p-6">
            <div className="w-full max-w-md rounded-2xl bg-white shadow-sm border border-slate-200 p-6 text-center">
                <div className="mx-auto mb-4 size-12 rounded-full border-4 border-slate-200 border-t-indigo-600 animate-spin" />
                <h1 className="text-xl font-semibold text-slate-900">
                    {connecting ? "Conectando con la Main…" : "La Main no está activa"}
                </h1>
                <p className="text-sm text-slate-600 mt-2">
                    {connecting
                        ? "Estableciendo conexión con el punto de venta principal."
                        : "Este Handy no puede usarse mientras el punto de venta principal esté apagado o en modo offline. Volverá a estar disponible en cuanto la Main se active."}
                </p>

                <button
                    type="button"
                    onClick={onUnlink}
                    className="mt-6 rounded-xl border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-800 hover:bg-slate-50"
                >
                    ← Ir a vinculación
                </button>
            </div>
        </div>
    );
}

/* =========================
   HANDY pairing state
========================= */

type HandyIdentity = {
    deviceId: string;
    devicePubKeyB64: string;
    deviceName?: string;
};

type HandyPairState =
    | { step: "idle" }
    | {
        step: "waiting_approval";
        pairCode: string;
        pairSecret: string;
        nonceB64: string;
        nonceExpiresAtMs: number;
    }
    | { step: "paired"; tenantId: string; token: string; deviceId: string };

export default function AppBoot({ router }: { router: any }) {
    const businessName = useBusinessSettings((s) => s.businessName);
    const logoDataUrl = useBusinessSettings((s) => s.logoDataUrl);

    const bizInit = useBusinessSettings((s) => s.init);
    const ticketInit = useTicketSettings((s) => s.init);
    const contactInit = useContactSettings((s) => s.init);

    const mode = useMode((s) => s.mode);
    const setMode = useMode((s) => s.setMode);

    // Al cambiar de modo (tpv ↔ handy) las URLs de imagen cambian (AppData vs CDN).
    // Limpiamos el caché de React Query para que los datos se refresquen con el modo nuevo.
    const prevModeRef = useRef<ModeStateValue>("loading");
    useEffect(() => {
        const prev = prevModeRef.current;
        prevModeRef.current = mode;
        if (mode !== "loading" && prev !== "loading" && prev !== mode) {
            queryClient.clear();
        }
    }, [mode]);

    const [busy, setBusy] = useState(false);
    const [err, setErr] = useState<string | null>(null);

    const [lic, setLic] = useState<LicenseLocalState | null | "loading">(
        "loading",
    );
    const [gate, setGate] = useState<GateResult | "loading">("loading");

    const [act, setAct] = useState({
        licenseKey: "",
        businessName: "",
        legal_name: "",
        display_name: "",
        email: "",
        phone: "",
        country: "",
    });

    const activationValid = useMemo(() => {
        return (
            act.licenseKey.trim().length > 0 &&
            act.legal_name.trim().length > 0 &&
            act.display_name.trim().length > 0 &&
            act.email.trim().length > 0 &&
            act.phone.trim().length > 0 &&
            act.country.trim().length > 0
        );
    }, [act]);

    // HANDY pairing
    const [handyUriInput, setHandyUriInput] = useState("");
    const [handyCodeInput, setHandyCodeInput] = useState("");
    const [handyPair, setHandyPair] = useState<HandyPairState>({
        step: "idle",
    });
    const [handyPairBusy, setHandyPairBusy] = useState(false);
    const [handyPairErr, setHandyPairErr] = useState<string | null>(null);
    const pairingAliveRef = useRef(true);
    // Modo de funcionamiento (offline/online) persistido en AppData: hidratar al arrancar.
    const hydrateConnMode = useConnectionMode((s) => s.hydrate);
    useEffect(() => {
        void hydrateConnMode();
    }, [hydrateConnMode]);

    // WebSocket de la Main: se abre/cierra según el modo (online → abre, offline → cierra).
    useMainSocket();

    // WebSocket del Handy: se abre cuando el dispositivo es Handy. Solo recibe `change` de la
    // nube y refresca React Query + el tick del POS (no aplica SQL: no hay BD local).
    useHandySocket();

    // Huella propia del dispositivo: el operador del Main la compara con la que ve en la
    // lista de solicitudes antes de aprobar (sobre todo en la ruta de "solo código").
    const [handyFingerprint, setHandyFingerprint] = useState("");

    useEffect(() => {
        let alive = true;
        (async () => {
            try {
                const ident = await handyGetIdentity();
                const fp = await deviceFingerprint(ident.devicePubKeyB64);
                if (alive) setHandyFingerprint(fp);
            } catch {
                /* sin identidad todavía: simplemente no mostramos huella */
            }
        })();
        return () => {
            alive = false;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    async function handyGetIdentity(): Promise<HandyIdentity> {
        const r = (await invoke("device_get_identity")) as any;

        console.log("device_get_identity raw:", r);

        const deviceId = String(r.deviceId || r.device_id || "");
        const pub = String(
            r.devicePubkeyB64 ??
            r.device_pubkey_b64 ??
            r.devicePubKeyB64 ??
            r.device_pub_key_b64 ??
            "",
        ).trim();

        if (!deviceId) throw new Error("handy_missing_deviceId");
        if (!pub || pub.length < 40)
            throw new Error(`handy_missing_pubkey_len_${pub.length}`);

        return {
            deviceId,
            devicePubKeyB64: pub,
            deviceName: r.deviceName ? String(r.deviceName) : undefined,
        };
    }

    async function handySignB64(payload: string): Promise<string> {
        const r = (await invoke("device_sign_b64", {
            args: {
                payload,
            },
        })) as any;

        const sig = String(r.sigB64 ?? r.sig_b64 ?? r.signature ?? "").trim();

        if (!sig) {
            throw new Error("handy_missing_signature");
        }

        return sig;
    }

    async function loadExistingHandyPair() {
        try {
            const tenantIdRaw = (await invoke("handy_get_tenant")) as string | null;
            const tenantId = String(tenantIdRaw || "").trim();

            if (!tenantId) {
                setHandyPair({ step: "idle" });
                return;
            }

            const ident = await handyGetIdentity();

            setHandyPair({
                step: "paired",
                tenantId,
                token: "",
                deviceId: ident.deviceId,
            });
        } catch {
            setHandyPair({ step: "idle" });
        }
    }

    useEffect(() => {
        pairingAliveRef.current = true;
        return () => {
            pairingAliveRef.current = false;
        };
    }, []);

    async function handyStartPair(pairCode: string, pairSecret: string) {
        setHandyPairBusy(true);
        setHandyPairErr(null);

        try {
            const ident = await handyGetIdentity();

            const claim = (await cloudPost("anon", "/v1/pair/claim", {
                pairCode,
                pairSecret,
                deviceId: ident.deviceId,
                devicePubKey: ident.devicePubKeyB64,
                deviceName: "",
            })) as any;

            const nonceB64 = String(claim.nonceB64 ?? claim.nonce_b64 ?? "");
            const nonceExpiresAtMs = Number(
                claim.nonceExpiresAtMs ?? claim.nonce_expires_at_ms ?? 0,
            );

            if (!nonceB64 || !Number.isFinite(nonceExpiresAtMs)) {
                throw new Error("bad_pair_claim_response");
            }

            setHandyPair({
                step: "waiting_approval",
                pairCode,
                pairSecret,
                nonceB64,
                nonceExpiresAtMs,
            });

            const startedAt = Date.now();
            const timeoutMs = 3 * 60 * 1000;

            while (Date.now() - startedAt < timeoutMs) {
                await new Promise((r) => setTimeout(r, 1500));
                if (!pairingAliveRef.current) return;

                const ts = Date.now();
                const msg = `${ts}\nPAIR_FETCH\n${pairCode}\n${nonceB64}\n${ident.deviceId}`;
                const sigB64 = await handySignB64(msg);

                try {
                    const ft = (await cloudPost("anon", "/v1/pair/fetch-token", {
                        pairCode,
                        deviceId: ident.deviceId,
                        nonceB64,
                        ts,
                        sigB64,
                    })) as any;

                    const tenantId = String(ft.tenantId ?? ft.tenant_id ?? "");
                    const token = String(ft.token ?? "");

                    if (!tenantId || !token) {
                        throw new Error("bad_pair_token_response");
                    }

                    await invoke("handy_set_token", {
                        args: {
                            token,
                            tenant_id: tenantId,
                        },
                    });

                    setHandyPair({
                        step: "paired",
                        tenantId,
                        token,
                        deviceId: ident.deviceId,
                    });

                    return;
                } catch (e: any) {
                    const m = String(e?.message || e);
                    if (m === "not_approved") continue;
                    throw e;
                }
            }

            if (!pairingAliveRef.current) return;
            throw new Error("pair_timeout_waiting_approval");
        } catch (e: any) {
            setHandyPairErr(String(e?.message || e));
            setHandyPair({ step: "idle" });
        } finally {
            setHandyPairBusy(false);
        }
    }

    // La capa antigua dualCall/cloudSync fue eliminada. La sync activa corre en
    // useMainSocket / useHandySocket (montados al inicio del componente, ver §9 en CLAUDE.md).

    useEffect(() => {
        (async () => {
            try {
                const rawMode = await invoke("get_device_mode");
                setMode(isDeviceMode(rawMode) ? rawMode : null);
            } catch (e: any) {
                setErr(String(e));
                setMode(null);
            }
        })();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useEffect(() => {
        if (mode !== "tpv") return;

        bizInit().catch(() => {
            // noop
        });

        ticketInit().catch(() => {
            // noop
        });

        contactInit().catch(() => {
            // noop
        });
    }, [mode, bizInit, ticketInit, contactInit]);

    // Imágenes → R2: una sola vez, encolar las imágenes locales pre-existentes (Mains anteriores
    // a R2) y drenar la cola. El backfill se auto-protege con un marcador; el drenado es no-op si
    // no hay nada o si está offline (se reintentará por el WebSocket cuando haya conexión).
    useEffect(() => {
        if (mode !== "tpv") return;
        void invoke("images_backfill")
            .then(() => invoke("images_drain_pending"))
            .catch(() => {
                // offline / sin permisos: se reintenta más tarde
            });
    }, [mode]);

    useEffect(() => {
        if (mode !== "handy") return;

        loadExistingHandyPair().catch(() => {
            setHandyPair({ step: "idle" });
        });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [mode]);

    async function refreshLicense() {
        try {
            const st = (await invoke(
                "license_get_state",
            )) as LicenseLocalState | null;
            setLic(st);
        } catch {
            setLic(null);
        }
    }

    useEffect(() => {
        refreshLicense();
    }, []);

    async function refreshGate(forceNow: boolean) {
        try {
            setGate("loading");

            const r = (await invoke(
                forceNow ? "license_check_now" : "license_gate",
            )) as GateResult;

            setGate(r);
            setLic(r.state);
        } catch (e: any) {
            setGate({
                allowed: false,
                reason: `gate_error:${String(e)}`,
                state: null,
            });
            setLic(null);
        }
    }

    useEffect(() => {
        if (mode === "tpv") {
            refreshGate(false);
        } else {
            setGate("loading");
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [mode]);

    useEffect(() => {
        if (mode !== "tpv") return;
        if (gate === "loading") return;
        if (!gate.allowed) return;

        const everyMs = 6 * 60 * 60 * 1000;
        const id = window.setInterval(() => {
            invoke("license_check_now")
                .then((r: any) => {
                    setGate(r);
                    setLic(r?.state ?? null);
                })
                .catch(() => {
                    // noop
                });
        }, everyMs);

        return () => window.clearInterval(id);
    }, [mode, gate]);

    async function choose(m: DeviceMode) {
        setBusy(true);
        setErr(null);

        try {
            await invoke("set_device_mode", { args: { mode: m } });

            if (m === "tpv") {
                await invoke("init_main");
            }

            setMode(m);

            await refreshLicense();
        } catch (e: any) {
            setErr(String(e));
        } finally {
            setBusy(false);
        }
    }

    async function submitActivation(e: React.FormEvent) {
        e.preventDefault();

        if (busy) return;

        setBusy(true);
        setErr(null);

        try {
            await invoke("license_activate", {
                args: {
                    activation_key: act.licenseKey,
                    restaurant_name: act.display_name || act.businessName,
                    business_name: act.businessName,
                    legal_name: act.legal_name,
                    display_name: act.display_name,
                    email: act.email,
                    phone: act.phone,
                    country: act.country,
                },
            });

            await refreshLicense();
            await refreshGate(true);
        } catch (e: any) {
            setErr(String(e));
        } finally {
            setBusy(false);
        }
    }

    async function goBackToModePicker() {
        setBusy(true);
        setErr(null);

        try {
            // Reversibilidad real: persiste mode=None, suelta los backends y, si veníamos de
            // Handy, desvincula el token. Tras esto, al reiniciar la app vuelve a salir el
            // selector de modo (no solo es un cambio visual).
            await invoke("device_reset_mode");
            setMode(null);
        } catch (e: any) {
            setErr(String(e));
        } finally {
            setBusy(false);
        }
    }

    // Presencia de la Main vista por el Handy: sin Main activa, el Handy se bloquea entero
    // (login incluido). null = aún conectando/sin confirmar (fail-closed).
    const mainOnline = useMainPresence((s) => s.mainOnline);

    const isMainAppReady = mode === "tpv" && gate !== "loading" && gate.allowed;
    const handyIsReady = mode === "handy" && handyPair.step === "paired";
    const handyMainActive = mainOnline === true;
    // El Handy solo muestra su app (RouterProvider, con su propia Titlebar) si está emparejado Y
    // hay una Main activa. Si no, enseñamos la pantalla de espera (que sí necesita la TopBar).
    const handyShowsApp = handyIsReady && handyMainActive;
    // El layout del Handy (RouterProvider) ya trae su propia barra de título (Titlebar, con el
    // toggle claro/oscuro). No mostramos también la barra de arranque para no duplicarla.
    const showBootTopBar = !isMainAppReady && !handyShowsApp;

    return (
        <div className="w-screen h-screen flex flex-col overflow-hidden">
            <UpdateBanner />
            {showBootTopBar ? <Titlebar /> : null}

            <div
                className={cn(
                    "flex-1 min-h-0 bg-slate-100",
                    showBootTopBar ? "overflow-y-auto" : "overflow-hidden",
                )}
            >
                {mode === "loading" || lic === "loading" ? (
                    <div className="min-h-full w-full bg-slate-100 p-6 font-sans">
                        Cargando...
                    </div>
                ) : mode === null ? (
                    <div className="relative flex min-h-full w-full items-center justify-center overflow-hidden bg-bg px-4 py-6 font-sans text-fg sm:px-6 lg:px-10">
                        <div
                            className="pointer-events-none absolute -left-24 -top-24 size-80 rounded-full bg-accent-soft blur-3xl"
                            aria-hidden
                        />
                        <div
                            className="pointer-events-none absolute -bottom-32 -right-16 size-96 rounded-full bg-accent-soft opacity-70 blur-3xl"
                            aria-hidden
                        />

                        <div className="relative w-full max-w-5xl">
                            <div className="mb-5 flex items-center justify-between gap-4">
                                <div className="flex min-w-0 items-center gap-3">
                                    <div className="grid size-11 shrink-0 place-items-center overflow-hidden rounded-2xl border border-border bg-surface shadow-sm">
                                        <img
                                            src={logoDataUrl ?? LogoAltaria}
                                            className="size-8 rounded-lg object-cover"
                                            alt=""
                                        />
                                    </div>
                                    <div className="min-w-0">
                                        <p className="truncate text-sm font-bold text-fg">
                                            {businessName || "TPV"}
                                        </p>
                                        <p className="text-xs text-fg-muted">
                                            Configuración del dispositivo
                                        </p>
                                    </div>
                                </div>

                            </div>

                            <Card
                                padded={false}
                                className="overflow-hidden rounded-3xl shadow-xl"
                            >
                                <div className="border-b border-border px-5 py-5 sm:px-7 sm:py-6">
                                    <Badge tone="accent">Primer inicio</Badge>
                                    <h1 className="mt-3 text-2xl font-bold tracking-tight text-fg sm:text-3xl">
                                        ¿Cómo vas a usar este dispositivo?
                                    </h1>
                                    <p className="mt-2 max-w-2xl text-sm leading-relaxed text-fg-muted sm:text-base">
                                        Elige el tipo de equipo que estás configurando.
                                        Podrás restablecerlo más adelante desde la propia aplicación.
                                    </p>
                                </div>

                                <div className="grid gap-4 p-4 sm:p-6 md:grid-cols-2">
                                    <button
                                        type="button"
                                        disabled={busy}
                                        onClick={() => choose("tpv")}
                                        className={cn(
                                            "group flex min-h-[280px] flex-col rounded-2xl border border-border bg-surface p-5 text-left",
                                            "transition duration-200 hover:-translate-y-0.5 hover:border-accent hover:shadow-lg",
                                            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                                            "disabled:pointer-events-none disabled:opacity-50 sm:p-6",
                                        )}
                                    >
                                        <div className="flex items-start justify-between gap-4">
                                            <div className="grid size-14 place-items-center rounded-2xl bg-accent-soft text-accent">
                                                <Monitor className="size-7" aria-hidden />
                                            </div>
                                            <Badge tone="accent">Principal</Badge>
                                        </div>

                                        <h2 className="mt-5 text-xl font-bold text-fg">
                                            TPV principal
                                        </h2>
                                        <p className="mt-2 text-sm leading-relaxed text-fg-muted">
                                            El equipo central del negocio. Guarda los datos
                                            localmente y puede trabajar aunque no haya conexión.
                                        </p>

                                        <ul className="mt-5 space-y-2.5 text-sm text-fg-muted">
                                            <li className="flex items-center gap-2">
                                                <Database className="size-4 text-accent" aria-hidden />
                                                Base de datos local
                                            </li>
                                            <li className="flex items-center gap-2">
                                                <Check className="size-4 text-success" aria-hidden />
                                                Gestión completa del negocio
                                            </li>
                                        </ul>

                                        <span className="mt-auto flex items-center justify-between border-t border-border pt-5 font-semibold text-accent">
                                            Configurar como TPV
                                            <ArrowRight
                                                className="size-5 transition-transform group-hover:translate-x-1"
                                                aria-hidden
                                            />
                                        </span>
                                    </button>

                                    <button
                                        type="button"
                                        disabled={busy}
                                        onClick={() => choose("handy")}
                                        className={cn(
                                            "group flex min-h-[280px] flex-col rounded-2xl border border-border bg-surface p-5 text-left",
                                            "transition duration-200 hover:-translate-y-0.5 hover:border-accent hover:shadow-lg",
                                            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                                            "disabled:pointer-events-none disabled:opacity-50 sm:p-6",
                                        )}
                                    >
                                        <div className="flex items-start justify-between gap-4">
                                            <div className="grid size-14 place-items-center rounded-2xl bg-surface-2 text-fg">
                                                <Smartphone className="size-7" aria-hidden />
                                            </div>
                                            <Badge>Dispositivo auxiliar</Badge>
                                        </div>

                                        <h2 className="mt-5 text-xl font-bold text-fg">
                                            Handy
                                        </h2>
                                        <p className="mt-2 text-sm leading-relaxed text-fg-muted">
                                            Un dispositivo para camareros conectado al TPV
                                            principal. Necesitarás vincularlo después.
                                        </p>

                                        <ul className="mt-5 space-y-2.5 text-sm text-fg-muted">
                                            <li className="flex items-center gap-2">
                                                <Wifi className="size-4 text-accent" aria-hidden />
                                                Conexión con la Main
                                            </li>
                                            <li className="flex items-center gap-2">
                                                <Check className="size-4 text-success" aria-hidden />
                                                Uso móvil en sala
                                            </li>
                                        </ul>

                                        <span className="mt-auto flex items-center justify-between border-t border-border pt-5 font-semibold text-accent">
                                            Configurar como Handy
                                            <ArrowRight
                                                className="size-5 transition-transform group-hover:translate-x-1"
                                                aria-hidden
                                            />
                                        </span>
                                    </button>
                                </div>

                                {busy ? (
                                    <div
                                        className="border-t border-border bg-surface-2 px-6 py-3 text-center text-sm font-medium text-fg-muted"
                                        role="status"
                                    >
                                        Preparando el dispositivo…
                                    </div>
                                ) : null}

                                {err && (
                                    <pre className="mx-4 mb-4 whitespace-pre-wrap rounded-xl border border-danger bg-danger-soft p-3 text-sm text-danger sm:mx-6 sm:mb-6">
                                        {err}
                                    </pre>
                                )}
                            </Card>

                            <p className="mt-4 text-center text-xs text-fg-subtle">
                                El TPV principal debe configurarse antes de vincular dispositivos Handy.
                            </p>
                        </div>
                    </div>
                ) : mode === "handy" ? (
                    handyIsReady ? (
                        handyMainActive ? (
                            // En modo Handy mostramos siempre un botón flotante para volver a la zona
                            // de vinculación (re-emparejar / cambiar de TPV). Solo se renderiza aquí, en
                            // la rama Handy: en modo TPV este botón no existe.
                            <div className="relative h-full w-full">
                                <RouterProvider router={router} />

                                <button
                                    type="button"
                                    onClick={() => {
                                        setHandyPairErr(null);
                                        setHandyPair({ step: "idle" });
                                    }}
                                    className="absolute bottom-3 left-3 z-50 rounded-xl border border-slate-300 bg-white/95 px-3 py-2 text-sm font-semibold text-slate-800 shadow-md backdrop-blur transition hover:bg-white active:scale-[0.98]"
                                >
                                    ← Vinculación
                                </button>
                            </div>
                        ) : (
                            // Emparejado pero sin Main activa: bloqueo total (login incluido).
                            <HandyWaitingMain
                                connecting={mainOnline === null}
                                onUnlink={() => {
                                    setHandyPairErr(null);
                                    setHandyPair({ step: "idle" });
                                }}
                            />
                        )
                    ) : (
                        <div className="relative flex min-h-full w-full items-center justify-center overflow-y-auto bg-bg p-4 text-fg sm:p-6 lg:p-10">
                            <div
                                className="pointer-events-none absolute -left-24 -top-24 size-80 rounded-full bg-accent-soft blur-3xl"
                                aria-hidden
                            />
                            <div
                                className="pointer-events-none absolute -bottom-32 -right-16 size-96 rounded-full bg-accent-soft opacity-70 blur-3xl"
                                aria-hidden
                            />

                            <div className="relative w-full max-w-5xl">
                                <div className="mb-4 flex items-center justify-between gap-3">
                                    <Button
                                        variant="secondary"
                                        size="sm"
                                        disabled={busy || handyPairBusy}
                                        onClick={goBackToModePicker}
                                    >
                                        ← Volver
                                    </Button>
                                    <Badge>Modo Handy</Badge>
                                </div>

                                <Card
                                    padded={false}
                                    className="grid overflow-hidden rounded-3xl shadow-xl lg:grid-cols-[0.9fr_1.1fr]"
                                >
                                    <section className="flex flex-col justify-between border-b border-border bg-surface-2 p-6 sm:p-8 lg:border-b-0 lg:border-r">
                                        <div>
                                            <div className="flex items-center justify-between gap-3">
                                                <div className="grid size-14 place-items-center rounded-2xl bg-accent-soft text-accent">
                                                    <Smartphone className="size-7" aria-hidden />
                                                </div>
                                                <Badge tone="accent">Vinculación segura</Badge>
                                            </div>

                                            <h1 className="mt-6 text-2xl font-bold tracking-tight text-fg sm:text-3xl">
                                                Conecta este Handy
                                            </h1>
                                            <p className="mt-3 text-sm leading-relaxed text-fg-muted sm:text-base">
                                                Genera una solicitud desde este dispositivo y
                                                apruébala en el TPV principal para empezar a
                                                trabajar en sala.
                                            </p>

                                            <div className="mt-7 space-y-4">
                                                <div className="flex gap-3">
                                                    <div className="grid size-9 shrink-0 place-items-center rounded-xl bg-surface text-accent shadow-sm">
                                                        <QrCode className="size-4" aria-hidden />
                                                    </div>
                                                    <div>
                                                        <p className="text-sm font-semibold text-fg">
                                                            Usa el QR del TPV
                                                        </p>
                                                        <p className="mt-0.5 text-xs leading-relaxed text-fg-muted">
                                                            Pega aquí el contenido leído del código QR.
                                                        </p>
                                                    </div>
                                                </div>

                                                <div className="flex gap-3">
                                                    <div className="grid size-9 shrink-0 place-items-center rounded-xl bg-surface text-accent shadow-sm">
                                                        <ShieldCheck className="size-4" aria-hidden />
                                                    </div>
                                                    <div>
                                                        <p className="text-sm font-semibold text-fg">
                                                            Aprueba en la Main
                                                        </p>
                                                        <p className="mt-0.5 text-xs leading-relaxed text-fg-muted">
                                                            El TPV principal debe aceptar este dispositivo.
                                                        </p>
                                                    </div>
                                                </div>
                                            </div>
                                        </div>

                                        {handyFingerprint ? (
                                            <div className="mt-8 rounded-2xl border border-border bg-surface p-4">
                                                <div className="flex items-center gap-2 text-xs font-semibold text-fg">
                                                    <Fingerprint className="size-4 text-accent" aria-hidden />
                                                    Huella del dispositivo
                                                </div>
                                                <p className="mt-2 break-all font-mono text-sm font-bold text-fg">
                                                    {handyFingerprint}
                                                </p>
                                                <p className="mt-2 text-xs leading-relaxed text-fg-muted">
                                                    Si usas el código manual, comprueba que
                                                    coincide con la huella mostrada en el TPV.
                                                </p>
                                            </div>
                                        ) : null}
                                    </section>

                                    <section className="p-6 sm:p-8">
                                        <div className="flex items-center gap-3">
                                            <div className="grid size-10 place-items-center rounded-xl bg-accent-soft text-accent">
                                                <Link2 className="size-5" aria-hidden />
                                            </div>
                                            <div>
                                                <h2 className="text-lg font-bold text-fg">
                                                    Datos de vinculación
                                                </h2>
                                                <p className="text-sm text-fg-muted">
                                                    Utiliza una de las dos opciones.
                                                </p>
                                            </div>
                                        </div>

                                        <div className="mt-6 grid gap-5">
                                            <div>
                                                <label
                                                    htmlFor="handy-qr-payload"
                                                    className="flex items-center gap-2 text-sm font-semibold text-fg"
                                                >
                                                    <ScanLine className="size-4 text-accent" aria-hidden />
                                                    Contenido del QR
                                                </label>
                                                <Input
                                                    id="handy-qr-payload"
                                                    value={handyUriInput}
                                                    onChange={(e) =>
                                                        setHandyUriInput(e.target.value)
                                                    }
                                                    disabled={handyPairBusy}
                                                    className="mt-2 h-12 px-4 font-mono"
                                                    placeholder="tpv://pair?code=123456&secret=..."
                                                    autoComplete="off"
                                                />
                                                <p className="mt-2 text-xs text-fg-subtle">
                                                    Pega la dirección completa obtenida al escanear el QR.
                                                </p>
                                            </div>

                                            <div className="flex items-center gap-3">
                                                <div className="h-px flex-1 bg-border" />
                                                <span className="text-xs font-semibold uppercase tracking-wider text-fg-subtle">
                                                    o
                                                </span>
                                                <div className="h-px flex-1 bg-border" />
                                            </div>

                                            <div>
                                                <label
                                                    htmlFor="handy-pair-code"
                                                    className="text-sm font-semibold text-fg"
                                                >
                                                    Código manual
                                                </label>
                                                <Input
                                                    id="handy-pair-code"
                                                    value={handyCodeInput}
                                                    onChange={(e) =>
                                                        setHandyCodeInput(
                                                            e.target.value
                                                                .replace(/[^\d]/g, "")
                                                                .slice(0, 6),
                                                        )
                                                    }
                                                    disabled={handyPairBusy}
                                                    className="mt-2 h-14 px-4 text-center font-mono text-xl font-bold tracking-[0.35em]"
                                                    placeholder="123456"
                                                    inputMode="numeric"
                                                    autoComplete="one-time-code"
                                                    maxLength={6}
                                                />
                                            </div>

                                            {handyPair.step === "waiting_approval" ? (
                                                <div
                                                    className="rounded-2xl border border-warning bg-warning-soft px-4 py-3 text-sm text-fg"
                                                    role="status"
                                                >
                                                    <p className="font-semibold">
                                                        Esperando aprobación en el TPV…
                                                    </p>
                                                    <p className="mt-1 text-xs text-fg-muted">
                                                        Código{" "}
                                                        <span className="font-mono font-bold text-fg">
                                                            {handyPair.pairCode}
                                                        </span>
                                                    </p>
                                                </div>
                                            ) : null}

                                            {handyPair.step === "paired" ? (
                                                <div
                                                    className="rounded-2xl border border-success bg-success-soft px-4 py-3 text-sm text-success"
                                                    role="status"
                                                >
                                                    Dispositivo vinculado correctamente.
                                                </div>
                                            ) : null}

                                            {handyPairErr ? (
                                                <div
                                                    className="rounded-2xl border border-danger bg-danger-soft px-4 py-3 text-sm text-danger"
                                                    role="alert"
                                                >
                                                    {handyPairErr}
                                                </div>
                                            ) : null}

                                            <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
                                                <Button
                                                    size="lg"
                                                    fullWidth
                                                    loading={handyPairBusy}
                                                    disabled={handyPairBusy}
                                                    leftIcon={<Link2 className="size-5" aria-hidden />}
                                                    onClick={() => {
                                                        const parsed =
                                                            parsePairUri(handyUriInput) ||
                                                            (handyCodeInput
                                                                ? parsePairUri(handyCodeInput)
                                                                : null);

                                                        if (!parsed) {
                                                            setHandyPairErr(
                                                                "QR o código inválido",
                                                            );
                                                            return;
                                                        }

                                                        handyStartPair(
                                                            parsed.pairCode,
                                                            parsed.pairSecret,
                                                        );
                                                    }}
                                                >
                                                    Vincular dispositivo
                                                </Button>

                                                <Button
                                                    variant="secondary"
                                                    size="lg"
                                                    disabled={handyPairBusy}
                                                    leftIcon={
                                                        <RotateCcw
                                                            className="size-4"
                                                            aria-hidden
                                                        />
                                                    }
                                                    onClick={() => {
                                                        setHandyUriInput("");
                                                        setHandyCodeInput("");
                                                        setHandyPairErr(null);
                                                        setHandyPair({
                                                            step: "idle",
                                                        });
                                                    }}
                                                >
                                                    Limpiar
                                                </Button>
                                            </div>

                                            <p className="text-center text-xs text-fg-subtle">
                                                El Handy no podrá utilizarse hasta que el TPV
                                                principal apruebe la solicitud.
                                            </p>
                                        </div>
                                    </section>
                                </Card>
                            </div>
                        </div>
                    )
                ) : mode === "tpv" ? (
                    gate === "loading" ? (
                        <div className="min-h-full w-full bg-slate-100 p-6 font-sans">
                            Comprobando licencia...
                        </div>
                    ) : !gate.allowed && gate.reason === "needs_activation" ? (
                        <div className="relative flex min-h-full w-full items-center justify-center overflow-y-auto bg-bg p-4 text-fg sm:p-6 lg:p-10">
                            <div
                                className="pointer-events-none absolute -left-24 -top-24 size-80 rounded-full bg-accent-soft blur-3xl"
                                aria-hidden
                            />
                            <div
                                className="pointer-events-none absolute -bottom-32 -right-16 size-96 rounded-full bg-accent-soft opacity-70 blur-3xl"
                                aria-hidden
                            />

                            <div className="relative w-full max-w-6xl">
                                <div className="mb-4 flex items-center justify-between gap-3">
                                    <Button
                                        variant="secondary"
                                        size="sm"
                                        disabled={busy}
                                        onClick={goBackToModePicker}
                                    >
                                        ← Volver
                                    </Button>
                                    <Badge tone={activationValid ? "success" : "warning"}>
                                        {activationValid
                                            ? "Datos completos"
                                            : "Completa todos los campos"}
                                    </Badge>
                                </div>

                                <Card
                                    padded={false}
                                    className="grid overflow-hidden rounded-3xl shadow-xl lg:grid-cols-[0.8fr_1.2fr]"
                                >
                                    <section className="flex flex-col justify-between border-b border-border bg-surface-2 p-6 sm:p-8 lg:border-b-0 lg:border-r">
                                        <div>
                                            <div className="flex items-center justify-between gap-3">
                                                <div className="grid size-14 place-items-center rounded-2xl bg-accent-soft text-accent">
                                                    <ShieldCheck className="size-7" aria-hidden />
                                                </div>
                                                <Badge tone="accent">TPV principal</Badge>
                                            </div>

                                            <h1 className="mt-6 text-2xl font-bold tracking-tight text-fg sm:text-3xl">
                                                Activa tu TPV
                                            </h1>
                                            <p className="mt-3 text-sm leading-relaxed text-fg-muted sm:text-base">
                                                Introduce tu licencia y los datos principales
                                                del negocio para preparar este equipo como
                                                punto de venta principal.
                                            </p>

                                            <div className="mt-7 space-y-4">
                                                <div className="flex gap-3">
                                                    <div className="grid size-9 shrink-0 place-items-center rounded-xl bg-surface text-accent shadow-sm">
                                                        <KeyRound className="size-4" aria-hidden />
                                                    </div>
                                                    <div>
                                                        <p className="text-sm font-semibold text-fg">
                                                            Valida tu licencia
                                                        </p>
                                                        <p className="mt-0.5 text-xs leading-relaxed text-fg-muted">
                                                            La clave identifica la suscripción de tu negocio.
                                                        </p>
                                                    </div>
                                                </div>

                                                <div className="flex gap-3">
                                                    <div className="grid size-9 shrink-0 place-items-center rounded-xl bg-surface text-accent shadow-sm">
                                                        <Building2 className="size-4" aria-hidden />
                                                    </div>
                                                    <div>
                                                        <p className="text-sm font-semibold text-fg">
                                                            Registra el establecimiento
                                                        </p>
                                                        <p className="mt-0.5 text-xs leading-relaxed text-fg-muted">
                                                            Estos datos identificarán el negocio dentro del TPV.
                                                        </p>
                                                    </div>
                                                </div>
                                            </div>
                                        </div>

                                        <div className="mt-8 flex items-center gap-2 rounded-2xl border border-border bg-surface px-4 py-3 text-xs text-fg-muted">
                                            <ShieldCheck className="size-4 shrink-0 text-success" aria-hidden />
                                            La activación requiere conexión a internet.
                                        </div>
                                    </section>

                                    <section className="p-6 sm:p-8">
                                        <div className="flex items-center gap-3">
                                            <div className="grid size-10 place-items-center rounded-xl bg-accent-soft text-accent">
                                                <Store className="size-5" aria-hidden />
                                            </div>
                                            <div>
                                                <h2 className="text-lg font-bold text-fg">
                                                    Licencia y negocio
                                                </h2>
                                                <p className="text-sm text-fg-muted">
                                                    Todos los campos son obligatorios.
                                                </p>
                                            </div>
                                        </div>

                                        <form
                                            onSubmit={submitActivation}
                                            className="mt-6 grid gap-5"
                                        >
                                            <div>
                                                <label
                                                    htmlFor="activation-license-key"
                                                    className="text-sm font-semibold text-fg"
                                                >
                                                    Clave de licencia
                                                </label>
                                                <Input
                                                    id="activation-license-key"
                                                    autoFocus
                                                    value={act.licenseKey}
                                                    onChange={(e) =>
                                                        setAct((s) => ({
                                                            ...s,
                                                            licenseKey: e.target.value,
                                                        }))
                                                    }
                                                    className="mt-2 h-12 px-4 font-mono uppercase tracking-wider"
                                                    placeholder="XXXX-XXXX-XXXX"
                                                    autoComplete="off"
                                                />
                                            </div>

                                            <div className="grid gap-4 sm:grid-cols-2">
                                                <div>
                                                    <label
                                                        htmlFor="activation-legal-name"
                                                        className="text-sm font-semibold text-fg"
                                                    >
                                                        Nombre legal
                                                    </label>
                                                    <Input
                                                        id="activation-legal-name"
                                                        value={act.legal_name}
                                                        onChange={(e) =>
                                                            setAct((s) => ({
                                                                ...s,
                                                                legal_name: e.target.value,
                                                            }))
                                                        }
                                                        className="mt-2 h-12 px-4"
                                                        placeholder="ALTARIA LIGHTS S.L."
                                                        autoComplete="organization"
                                                    />
                                                </div>

                                                <div>
                                                    <label
                                                        htmlFor="activation-display-name"
                                                        className="text-sm font-semibold text-fg"
                                                    >
                                                        Nombre del negocio
                                                    </label>
                                                    <Input
                                                        id="activation-display-name"
                                                        value={act.display_name}
                                                        onChange={(e) =>
                                                            setAct((s) => ({
                                                                ...s,
                                                                display_name: e.target.value,
                                                            }))
                                                        }
                                                        className="mt-2 h-12 px-4"
                                                        placeholder="Bar La Plaza"
                                                        autoComplete="organization"
                                                    />
                                                </div>
                                            </div>

                                            <div className="grid gap-4 sm:grid-cols-2">
                                                <div>
                                                    <label
                                                        htmlFor="activation-email"
                                                        className="flex items-center gap-2 text-sm font-semibold text-fg"
                                                    >
                                                        <Mail className="size-4 text-accent" aria-hidden />
                                                        Correo electrónico
                                                    </label>
                                                    <Input
                                                        id="activation-email"
                                                        type="email"
                                                        value={act.email}
                                                        onChange={(e) =>
                                                            setAct((s) => ({
                                                                ...s,
                                                                email: e.target.value,
                                                            }))
                                                        }
                                                        className="mt-2 h-12 px-4"
                                                        placeholder="ejemplo@correo.com"
                                                        autoComplete="email"
                                                    />
                                                </div>

                                                <div>
                                                    <label
                                                        htmlFor="activation-phone"
                                                        className="flex items-center gap-2 text-sm font-semibold text-fg"
                                                    >
                                                        <Phone className="size-4 text-accent" aria-hidden />
                                                        Número de teléfono
                                                    </label>
                                                    <Input
                                                        id="activation-phone"
                                                        type="tel"
                                                        value={act.phone}
                                                        onChange={(e) =>
                                                            setAct((s) => ({
                                                                ...s,
                                                                phone: e.target.value,
                                                            }))
                                                        }
                                                        className="mt-2 h-12 px-4"
                                                        placeholder="+34 600 000 000"
                                                        autoComplete="tel"
                                                    />
                                                </div>
                                            </div>

                                            <div>
                                                <label
                                                    htmlFor="activation-country"
                                                    className="flex items-center gap-2 text-sm font-semibold text-fg"
                                                >
                                                    <MapPin className="size-4 text-accent" aria-hidden />
                                                    País
                                                </label>
                                                <Input
                                                    id="activation-country"
                                                    value={act.country}
                                                    onChange={(e) =>
                                                        setAct((s) => ({
                                                            ...s,
                                                            country: e.target.value,
                                                        }))
                                                    }
                                                    className="mt-2 h-12 px-4"
                                                    placeholder="España"
                                                    autoComplete="country-name"
                                                />
                                            </div>

                                            {err ? (
                                                <pre
                                                    className="whitespace-pre-wrap rounded-2xl border border-danger bg-danger-soft px-4 py-3 text-sm text-danger"
                                                    role="alert"
                                                >
                                                    {err}
                                                </pre>
                                            ) : null}

                                            <div className="grid gap-3 sm:grid-cols-[auto_1fr]">
                                                <Button
                                                    variant="secondary"
                                                    size="lg"
                                                    disabled={busy}
                                                    onClick={() =>
                                                        setAct({
                                                            licenseKey: "",
                                                            businessName: "",
                                                            legal_name: "",
                                                            display_name: "",
                                                            email: "",
                                                            phone: "",
                                                            country: "",
                                                        })
                                                    }
                                                >
                                                    Limpiar
                                                </Button>

                                                <Button
                                                    type="submit"
                                                    size="lg"
                                                    fullWidth
                                                    loading={busy}
                                                    disabled={!activationValid}
                                                    leftIcon={
                                                        <ShieldCheck
                                                            className="size-5"
                                                            aria-hidden
                                                        />
                                                    }
                                                >
                                                    Activar TPV
                                                </Button>
                                            </div>
                                        </form>
                                    </section>
                                </Card>
                            </div>
                        </div>
                    ) : !gate.allowed ? (
                        <BlockedScreen
                            reason={gate.reason}
                            onRetry={() => refreshGate(true)}
                            onClear={() => {
                                invoke("license_clear_state").finally(() => {
                                    refreshLicense().finally(() =>
                                        refreshGate(false),
                                    );
                                });
                            }}
                        />
                    ) : (
                        <RouterProvider router={router} />
                    )
                ) : (
                    <div className="min-h-full w-full bg-slate-100 p-6 font-sans">
                        Modo de dispositivo no válido. Reinicia la app.
                    </div>
                )}
            </div>
        </div>
    );
}
