// src/AppBoot.tsx
import React, { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { RouterProvider } from "react-router-dom";
import { getCurrentWindow } from "@tauri-apps/api/window";

import { useMode, type DeviceMode } from "../shared/stores/useMode";
import { useBusinessSettings } from "../shared/stores/useBusinessSettings";
import { useTicketSettings } from "../shared/stores/useTicketSettings";

import LogoAltaria from "../assets/img/logo.png";
import CerrarVentana from "../assets/svg/CerrarVentana.svg";
import MinimizarVentana from "../assets/svg/MinimizarVentana.svg";
import PantallaCompleta from "../assets/svg/PantallaCompleta.svg";

/* =========================
   API helper (Rust proxy)
========================= */

async function apiPost(
    mode: "anon" | "tpv" | "handy",
    path: string,
    body: any,
) {
    return await invoke("tpv_server_post_json", {
        args: {
            mode,
            path,
            body,
        },
    });
}

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

function Field({
    label,
    hint,
    children,
}: {
    label: string;
    hint?: string;
    children: React.ReactNode;
}) {
    return (
        <label className="block">
            <div className="flex items-center justify-between gap-3">
                <span className="text-sm font-semibold text-slate-900">
                    {label}
                </span>
                {hint ? (
                    <span className="text-xs font-medium text-slate-400">
                        {hint}
                    </span>
                ) : null}
            </div>
            <div className="mt-2">{children}</div>
        </label>
    );
}

function TextInput(props: React.InputHTMLAttributes<HTMLInputElement>) {
    return (
        <input
            {...props}
            className={cn(
                "w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 outline-none",
                "placeholder:text-slate-400 focus:border-slate-300",
                props.className,
            )}
        />
    );
}

function PrimaryButton({
    children,
    type = "button",
    onClick,
    disabled,
}: {
    children: React.ReactNode;
    type?: "button" | "submit";
    onClick?: () => void;
    disabled?: boolean;
}) {
    return (
        <button
            type={type}
            onClick={onClick}
            disabled={disabled}
            className={cn(
                "h-10 px-4 rounded-xl border border-slate-900 bg-slate-900 text-sm font-bold text-white shadow-sm transition",
                "hover:bg-slate-800 active:scale-[0.98]",
                disabled
                    ? "opacity-50 cursor-not-allowed hover:bg-slate-900 active:scale-100"
                    : "",
            )}
        >
            {children}
        </button>
    );
}

function GhostButton({
    children,
    onClick,
    disabled,
}: {
    children: React.ReactNode;
    onClick?: () => void;
    disabled?: boolean;
}) {
    return (
        <button
            type="button"
            onClick={onClick}
            disabled={disabled}
            className={cn(
                "h-10 px-4 rounded-xl border border-slate-200 bg-white text-sm font-semibold text-slate-800 shadow-sm transition",
                "hover:bg-slate-50 active:scale-[0.98]",
                disabled
                    ? "opacity-50 cursor-not-allowed hover:bg-white active:scale-100"
                    : "",
            )}
        >
            {children}
        </button>
    );
}

function Panel({
    title,
    subtitle,
    right,
    children,
}: {
    title: string;
    subtitle?: string;
    right?: React.ReactNode;
    children: React.ReactNode;
}) {
    return (
        <section className="rounded-2xl border border-slate-200 bg-white shadow-sm">
            <div className="px-5 py-4 border-b border-slate-200">
                <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                        <h2 className="text-base font-semibold text-slate-900 truncate">
                            {title}
                        </h2>
                        {subtitle ? (
                            <p className="text-sm text-slate-600 mt-0.5">
                                {subtitle}
                            </p>
                        ) : null}
                    </div>
                    {right ? <div className="shrink-0">{right}</div> : null}
                </div>
            </div>
            <div className="px-5 py-5">{children}</div>
        </section>
    );
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
    const ventana = getCurrentWindow();

    const businessName = useBusinessSettings((s) => s.businessName);
    const logoDataUrl = useBusinessSettings((s) => s.logoDataUrl);

    const bizInit = useBusinessSettings((s) => s.init);
    const ticketInit = useTicketSettings((s) => s.init);

    const mode = useMode((s) => s.mode);
    const setMode = useMode((s) => s.setMode);

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

    async function handyStartPair(pairCode: string, pairSecret: string) {
        setHandyPairBusy(true);
        setHandyPairErr(null);

        try {
            const ident = await handyGetIdentity();

            const claim = (await apiPost("anon", "/v1/pair/claim", {
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

                const ts = Date.now();
                const msg = `${ts}\nPAIR_FETCH\n${pairCode}\n${nonceB64}\n${ident.deviceId}`;
                const sigB64 = await handySignB64(msg);

                try {
                    const ft = (await apiPost("anon", "/v1/pair/fetch-token", {
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

            throw new Error("pair_timeout_waiting_approval");
        } catch (e: any) {
            setHandyPairErr(String(e?.message || e));
            setHandyPair({ step: "idle" });
        } finally {
            setHandyPairBusy(false);
        }
    }

    // Local-First puro: se elimina toda la capa de sync (outbox / healthcheck /
    // cloudSync / realtime). El emparejamiento Handy se conserva (no usa net/*).

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
    }, [mode, bizInit, ticketInit]);

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

            if (m === "tpv") {
                await refreshGate(false);
            }
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

    const isMainAppReady = mode === "tpv" && gate !== "loading" && gate.allowed;
    const showBootTopBar = !isMainAppReady;

    const TopBar = (
        <div className="w-full flex justify-between shrink-0 overflow-hidden">
            <div
                className="flex bg-white w-full p-1.5 items-center gap-3"
                data-tauri-drag-region
            >
                <img
                    src={logoDataUrl ?? LogoAltaria}
                    className="size-5 rounded-sm object-cover"
                    data-tauri-drag-region
                    alt="logo"
                />
                <p data-tauri-drag-region className="truncate max-w-60 text-sm">
                    {businessName || "TPV"}
                </p>
            </div>

            <div className="flex gap-4 w-fit p-1 px-2 bg-white">
                <button
                    data-tauri-drag-region
                    className="hover:scale-140 transition-all cursor-pointer"
                    onClick={() => ventana.minimize()}
                    type="button"
                >
                    <img
                        src={MinimizarVentana}
                        className="size-8"
                        alt="minimizar"
                    />
                </button>
                <button
                    data-tauri-drag-region
                    className="hover:scale-140 transition-all cursor-pointer"
                    onClick={() => ventana.toggleMaximize()}
                    type="button"
                >
                    <img
                        src={PantallaCompleta}
                        className="size-5"
                        alt="maximizar"
                    />
                </button>
                <button
                    data-tauri-drag-region
                    className="hover:scale-140 transition-all cursor-pointer"
                    onClick={() => ventana.close()}
                    type="button"
                >
                    <img src={CerrarVentana} className="size-8" alt="cerrar" />
                </button>
            </div>
        </div>
    );

    const handyIsReady = mode === "handy" && handyPair.step === "paired";

    return (
        <div className="w-screen h-screen flex flex-col overflow-hidden">
            {showBootTopBar ? TopBar : null}

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
                    <div className="min-h-full w-full bg-slate-100 p-6 font-sans flex items-center justify-center">
                        <div className="w-full max-w-lg rounded-2xl bg-white shadow-sm border border-slate-200 p-6">
                            <h2 className="text-2xl font-semibold text-slate-900">
                                Selecciona modo
                            </h2>
                            <p className="text-sm text-slate-600 mt-1">
                                Esto solo se elige la primera vez.
                            </p>

                            <div className="flex gap-3 mt-5">
                                <button
                                    disabled={busy}
                                    onClick={() => choose("tpv")}
                                    className="flex-1 rounded-xl bg-indigo-600 text-white py-3 font-semibold hover:bg-indigo-700 disabled:opacity-50"
                                >
                                    TPV (punto de venta principal)
                                </button>

                                <button
                                    disabled={busy}
                                    onClick={() => choose("handy")}
                                    className="flex-1 rounded-xl border border-slate-300 bg-white py-3 font-semibold text-slate-800 hover:bg-slate-50 disabled:opacity-50"
                                >
                                    Handy (camarero)
                                </button>
                            </div>

                            {err && (
                                <pre className="mt-4 text-sm text-red-600 bg-red-50 border border-red-200 rounded-xl p-3 whitespace-pre-wrap">
                                    {err}
                                </pre>
                            )}
                        </div>
                    </div>
                ) : mode === "handy" ? (
                    handyIsReady ? (
                        <RouterProvider router={router} />
                    ) : (
                        <div className="min-h-full w-full bg-slate-100">
                            <div className="p-4 flex items-center justify-between gap-3">
                                <button
                                    type="button"
                                    onClick={goBackToModePicker}
                                    disabled={busy}
                                    className="rounded-xl border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-800 hover:bg-slate-50 disabled:opacity-50"
                                >
                                    ← Volver
                                </button>

                                <span className="text-xs text-slate-500">
                                    Handy (camarero)
                                </span>
                            </div>

                            <div className="px-4 pb-4">
                                <Panel
                                    title="Vincular Handy"
                                    subtitle="Pega el QR o introduce el código y solicita vinculación."
                                >
                                    <div className="flex flex-col gap-3">
                                        <div className="rounded-xl border border-slate-200 bg-white p-4">
                                            <div className="text-sm font-semibold text-slate-900">
                                                Vincular dispositivo
                                            </div>
                                            <div className="text-xs text-slate-600 mt-1">
                                                Escanea el QR (pega el contenido
                                                aquí) o introduce el código
                                                manual.
                                            </div>

                                            <div className="mt-3 grid grid-cols-1 md:grid-cols-2 gap-3">
                                                <div>
                                                    <div className="text-xs font-semibold text-slate-700">
                                                        QR payload
                                                    </div>
                                                    <input
                                                        className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm"
                                                        value={handyUriInput}
                                                        onChange={(e) =>
                                                            setHandyUriInput(
                                                                e.target.value,
                                                            )
                                                        }
                                                        placeholder="tpv://pair?code=123456&secret=..."
                                                    />
                                                </div>

                                                <div>
                                                    <div className="text-xs font-semibold text-slate-700">
                                                        Código manual
                                                    </div>
                                                    <input
                                                        className="mt-1 w-full rounded-xl border border-slate-200 px-3 py-2 text-sm"
                                                        value={handyCodeInput}
                                                        onChange={(e) =>
                                                            setHandyCodeInput(
                                                                e.target.value
                                                                    .replace(
                                                                        /[^\d]/g,
                                                                        "",
                                                                    )
                                                                    .slice(
                                                                        0,
                                                                        6,
                                                                    ),
                                                            )
                                                        }
                                                        placeholder="123456"
                                                    />
                                                </div>
                                            </div>

                                            <div className="mt-3 flex flex-wrap gap-2">
                                                <PrimaryButton
                                                    disabled={handyPairBusy}
                                                    onClick={() => {
                                                        const parsed =
                                                            parsePairUri(
                                                                handyUriInput,
                                                            ) ||
                                                            (handyCodeInput
                                                                ? parsePairUri(
                                                                    handyCodeInput,
                                                                )
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
                                                    {handyPairBusy
                                                        ? "Vinculando..."
                                                        : "Vincular"}
                                                </PrimaryButton>

                                                <GhostButton
                                                    disabled={handyPairBusy}
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
                                                </GhostButton>
                                            </div>

                                            {handyPair.step ===
                                                "waiting_approval" ? (
                                                <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
                                                    Pendiente de aprobación en
                                                    el TPV… (código{" "}
                                                    <span className="font-mono">
                                                        {handyPair.pairCode}
                                                    </span>
                                                    )
                                                </div>
                                            ) : null}

                                            {handyPair.step === "paired" ? (
                                                <div className="mt-3 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-900">
                                                    Vinculado ✅ Tenant:{" "}
                                                    <span className="font-mono">
                                                        {handyPair.tenantId}
                                                    </span>
                                                </div>
                                            ) : null}

                                            {handyPairErr ? (
                                                <div className="mt-3 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                                                    {handyPairErr}
                                                </div>
                                            ) : null}
                                        </div>

                                        <div className="text-xs text-slate-500">
                                            Nota: el TPV debe aprobar la
                                            solicitud para que el Handy reciba
                                            el token.
                                        </div>
                                    </div>
                                </Panel>
                            </div>
                        </div>
                    )
                ) : mode === "tpv" ? (
                    gate === "loading" ? (
                        <div className="min-h-full w-full bg-slate-100 p-6 font-sans">
                            Comprobando licencia...
                        </div>
                    ) : !gate.allowed && gate.reason === "needs_activation" ? (
                        <div className="min-h-full w-full bg-slate-100 flex items-center justify-center p-6 relative">
                            <div className="fixed left-3 top-[52px] z-50">
                                <button
                                    type="button"
                                    onClick={goBackToModePicker}
                                    disabled={busy}
                                    className="rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-slate-800 hover:bg-slate-50 disabled:opacity-50 shadow-sm"
                                >
                                    ← Volver
                                </button>
                            </div>

                            <div className="w-full max-w-3xl">
                                <Panel
                                    title="Activación"
                                    subtitle="Introduce la licencia y los datos del negocio."
                                    right={
                                        <span
                                            className={cn(
                                                "inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium",
                                                activationValid
                                                    ? "border-emerald-200 bg-emerald-50 text-emerald-800"
                                                    : "border-amber-200 bg-amber-50 text-amber-900",
                                            )}
                                        >
                                            {activationValid
                                                ? "Completo"
                                                : "Faltan datos"}
                                        </span>
                                    }
                                >
                                    <form
                                        onSubmit={submitActivation}
                                        className="flex flex-col gap-4"
                                    >
                                        <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
                                            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                                <div className="md:col-span-2">
                                                    <Field
                                                        label="Clave de la Licencia"
                                                        hint="Obligatorio"
                                                    >
                                                        <TextInput
                                                            autoFocus
                                                            value={
                                                                act.licenseKey
                                                            }
                                                            onChange={(e) =>
                                                                setAct((s) => ({
                                                                    ...s,
                                                                    licenseKey:
                                                                        e.target
                                                                            .value,
                                                                }))
                                                            }
                                                            placeholder="XXXX-XXXX-XXXX"
                                                        />
                                                    </Field>
                                                </div>

                                                <Field
                                                    label="Nombre legal"
                                                    hint="Obligatorio"
                                                >
                                                    <TextInput
                                                        value={act.legal_name}
                                                        onChange={(e) =>
                                                            setAct((s) => ({
                                                                ...s,
                                                                legal_name:
                                                                    e.target
                                                                        .value,
                                                            }))
                                                        }
                                                        placeholder="Ej: ALTARIA LIGHTS S.L."
                                                    />
                                                </Field>

                                                <Field
                                                    label="Nombre del negocio"
                                                    hint="Obligatorio"
                                                >
                                                    <TextInput
                                                        value={act.display_name}
                                                        onChange={(e) =>
                                                            setAct((s) => ({
                                                                ...s,
                                                                display_name:
                                                                    e.target
                                                                        .value,
                                                            }))
                                                        }
                                                        placeholder="Ej: Bar La Plaza"
                                                    />
                                                </Field>

                                                <Field
                                                    label="Correo electrónico"
                                                    hint="Obligatorio"
                                                >
                                                    <TextInput
                                                        type="email"
                                                        value={act.email}
                                                        onChange={(e) =>
                                                            setAct((s) => ({
                                                                ...s,
                                                                email: e.target
                                                                    .value,
                                                            }))
                                                        }
                                                        placeholder="ejemplo@correo.com"
                                                    />
                                                </Field>

                                                <Field
                                                    label="Número de teléfono"
                                                    hint="Obligatorio"
                                                >
                                                    <TextInput
                                                        value={act.phone}
                                                        onChange={(e) =>
                                                            setAct((s) => ({
                                                                ...s,
                                                                phone: e.target
                                                                    .value,
                                                            }))
                                                        }
                                                        placeholder="+34 600 000 000"
                                                    />
                                                </Field>

                                                <div className="md:col-span-2">
                                                    <Field
                                                        label="País"
                                                        hint="Obligatorio"
                                                    >
                                                        <TextInput
                                                            value={act.country}
                                                            onChange={(e) =>
                                                                setAct((s) => ({
                                                                    ...s,
                                                                    country:
                                                                        e.target
                                                                            .value,
                                                                }))
                                                            }
                                                            placeholder="España"
                                                        />
                                                    </Field>
                                                </div>
                                            </div>
                                        </div>

                                        <div className="flex items-center justify-between gap-2">
                                            <GhostButton
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
                                            </GhostButton>

                                            <PrimaryButton
                                                type="submit"
                                                disabled={
                                                    busy || !activationValid
                                                }
                                            >
                                                {busy
                                                    ? "Activando…"
                                                    : "Activar"}
                                            </PrimaryButton>
                                        </div>

                                        {err && (
                                            <pre className="mt-1 text-sm text-red-600 bg-red-50 border border-red-200 rounded-xl p-3 whitespace-pre-wrap">
                                                {err}
                                            </pre>
                                        )}
                                    </form>
                                </Panel>
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