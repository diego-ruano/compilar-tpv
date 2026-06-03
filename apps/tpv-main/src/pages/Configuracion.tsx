// src/pages/Configuracion.tsx

// AQUÍ HAY QUE ARREGLAR LA PARTE DE LA OBTENCIÓN DEL CÓDIGO, ANTES SE HACÍA POR UNA PETICIÓN QUE
// MANEJABA UN ARCHIVO LEGACY QUE NO TENÍA MÁS UTILIDAD QUE ESA, SE QUEDAN LAS COSAS
// SE QUEDA COMENTADA LA PARTE QUE HAY QUE ARREGLAR PARA QUE COMPILE, PERO NO FUNCIONA AHORA MISMO ESTE ARCHIVO
import React, { useEffect, useMemo, useState } from "react";
import { useBusinessSettings } from "../shared/stores/useBusinessSettings";
import { useTicketSettings } from "../shared/stores/useTicketSettings";
import { useMode } from "../shared/stores/useMode";

import { cn } from "../features/configuracion/utils";
import type {
    LicenseInfo,
    NavItem,
    SectionKey,
} from "../features/configuracion/types";
import { useBusinessDraft } from "../features/configuracion/hooks/useBusinessDraft";

// UI
import { Badge } from "../features/configuracion/ui/Badge";
import { TextInput } from "../features/configuracion/ui/Inputs";

// Sections
import { Negocio } from "../features/configuracion/sections/Negocio";
import { Contacto } from "../features/configuracion/sections/Contacto";
import { Ticket } from "../features/configuracion/sections/Ticket";
import { Licencia } from "../features/configuracion/sections/Licencia";
import { Apariencia } from "../features/configuracion/sections/Apariencia";
import { VincularHandy } from "../features/configuracion/sections/VincularHandy";


export default function Configuracion() {
    // ✅ stores (ya no “hydrate” aquí; el init se hace en AppBoot)
    const biz = useBusinessSettings();

    const ticket = useTicketSettings((s) => s.settings);
    const setSetting = useTicketSettings((s) => s.setSetting);

    // compat: si en tu store mantienes hydrated/ready, lo usamos; si no, asumimos true
    const bizHydrated = useBusinessSettings((s: any) =>
        typeof s.hydrated === "boolean" ? s.hydrated : true,
    );
    const ticketHydrated = useTicketSettings((s: any) =>
        typeof s.hydrated === "boolean" ? s.hydrated : true,
    );

    // opcional: si existe init() en stores, lo llamamos al entrar (por seguridad)
    const bizInit = useBusinessSettings((s: any) => s.init);
    const ticketInit = useTicketSettings((s: any) => s.init);

    const mode = useMode((s) => s.mode);
    const isMain = mode === "tpv";

    const [recoveryEmail, setRecoveryEmail] = useState(
        "recuperacion@altaria.dev",
    );
    const [contactEmail, setContactEmail] = useState("soporte@altaria.dev");
    const [contactPhone, setContactPhone] = useState("+34 600 000 000");

    const [darkMode, setDarkMode] = useState(false);

    const [license] = useState<LicenseInfo>({
        plan: "PRO",
        status: "ACTIVA",
        nextPaymentDate: "2026-02-15",
        seats: 3,
        devices: 5,
    });

    const [section, setSection] = useState<SectionKey>("NEGOCIO");
    const [navQuery, setNavQuery] = useState("");

    const [animKey, setAnimKey] = useState(0);
    useEffect(() => setAnimKey((k) => k + 1), [section]);

    const statusTone = useMemo(() => {
        if (license.status === "ACTIVA") return "good";
        if (license.status === "EN_GRACIA") return "warn";
        return "bad";
    }, [license.status]);

    const baseNavItems: NavItem[] = [
        {
            key: "NEGOCIO",
            title: "Negocio",
            desc: "Identidad y datos fiscales",
            keywords: [
                "logo",
                "nombre",
                "direccion",
                "teléfono",
                "cif",
                "iva",
                "footer",
            ],
        },
        {
            key: "CONTACTO",
            title: "Contacto",
            desc: "Recuperación y soporte",
            keywords: ["email", "correo", "teléfono", "soporte"],
        },
        {
            key: "TICKET",
            title: "Ticket",
            desc: "Opciones de impresión",
            keywords: ["ticket", "impresión", "iva", "footer"],
        },
        {
            key: "LICENCIA",
            title: "Licencia",
            desc: "Plan, estado y pago",
            keywords: ["licencia", "plan", "pago", "dispositivos"],
        },
        {
            key: "APARIENCIA",
            title: "Apariencia",
            desc: "Tema / modo oscuro",
            keywords: ["tema", "oscuro", "apariencia"],
        },
    ];

    const navItems: NavItem[] = useMemo(() => {
        if (!isMain) return baseNavItems;
        return [
            ...baseNavItems,
            {
                key: "VINCULAR_HANDY",
                title: "Vincular Handy",
                desc: "Emparejar otro dispositivo",
                keywords: ["handy", "vincular", "emparejar", "qr", "pair"],
            },
        ];
    }, [isMain]);

    const filteredNav = useMemo(() => {
        const q = navQuery.trim().toLowerCase();
        if (!q) return navItems;
        return navItems.filter((it) =>
            [it.title, it.desc, ...it.keywords]
                .join(" ")
                .toLowerCase()
                .includes(q),
        );
    }, [navQuery, navItems]);

    const PageTitle = useMemo(
        () => navItems.find((n) => n.key === section)?.title ?? "Configuración",
        [navItems, section],
    );

    const inputTone = useMemo(
        () =>
            darkMode
                ? "bg-slate-950/40 border-slate-800 text-white placeholder:text-slate-500"
                : "",
        [darkMode],
    );

    // Anchors (solo Ticket)
    const ticketAnchors = useMemo(
        () => [
            { id: "ticket-elementos", label: "Elementos" },
            { id: "ticket-fiscal", label: "IVA" },
        ],
        [],
    );
    const renderAnchors = section === "TICKET";
    const jumpTo = (id: string) => {
        const el = document.getElementById(id);
        if (!el) return;
        el.scrollIntoView({ behavior: "smooth", block: "start" });
    };

    // ✅ Seguridad extra: si existen init() y todavía no está listo, inicializa aquí también (solo MAIN)
    useEffect(() => {
        if (!isMain) return;

        if (typeof bizInit === "function" && !bizHydrated) {
            bizInit().catch(() => { });
        }
        if (typeof ticketInit === "function" && !ticketHydrated) {
            ticketInit().catch(() => { });
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isMain]);

    // Draft + dirty (hook) (tu hook ya no depende de hydrate)
    const { draft, setDraft, dirty, resetDraft, setIvaFromRaw } =
        useBusinessDraft(biz);

    // Save negocio
    const [savingBiz, setSavingBiz] = useState(false);
    const onSaveBusiness = async () => {
        try {
            setSavingBiz(true);
            await (biz as any).setMany({
                businessName: draft.businessName,
                logoDataUrl: draft.logoDataUrl,
                direccion: draft.direccion,
                telefono: draft.telefono,
                cif: draft.cif,
                mensajeFooter: draft.mensajeFooter,
                ivaPercent: draft.ivaPercent,
            });
            alert("Guardado");
        } catch {
            alert("No se pudo guardar. Revisa la consola.");
        } finally {
            setSavingBiz(false);
        }
    };

    const canSaveBusiness = dirty && !savingBiz && bizHydrated;

    // ✅ Vincular handy (REAL con invoke->Rust)
    const [pairCode, setPairCode] = useState("");
    const [pairSecret, setPairSecret] = useState("");
    const [pairExpiresAtMs, setPairExpiresAtMs] = useState<number | null>(null);
    const [pairLoading, setPairLoading] = useState(false);
    const [pairError, setPairError] = useState<string | null>(null);

    const generatePair = async () => {
        // try {
        //     setPairError(null);
        //     setPairLoading(true);

        //     const j = await tpvPost<{
        //         ok: true;
        //         pairCode: string;
        //         pairSecret: string;
        //         expiresAtMs: number;
        //     }>("/v1/pair/create", {});

        //     setPairCode(String(j.pairCode || ""));
        //     setPairSecret(String(j.pairSecret || ""));
        //     setPairExpiresAtMs(
        //         typeof j.expiresAtMs === "number" ? j.expiresAtMs : null,
        //     );
        // } catch (e: any) {
        //     setPairError(String(e?.message || e));
        // } finally {
        //     setPairLoading(false);
        // }
    };

    // Autogenerar al entrar en sección (solo MAIN)
    useEffect(() => {
        if (!isMain) return;
        if (section !== "VINCULAR_HANDY") return;
        if (pairLoading) return;
        if (pairCode) return;

        generatePair().catch(() => { });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [section, isMain]);

    // Si cambia a handy, fuera de esta sección
    useEffect(() => {
        if (!isMain && section === "VINCULAR_HANDY") setSection("LICENCIA");
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isMain]);

    return (
        <div className="w-full h-full overflow-hidden bg-transparent">
            <style>{`
        @keyframes cfgFadeSlide { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: translateY(0); } }
        .cfg-animate { animation: cfgFadeSlide 180ms ease-out; }
        @media (prefers-reduced-motion: reduce) { .cfg-animate { animation: none; } }
      `}</style>

            <div className="h-full w-full px-4 md:px-6 py-4 md:py-6">
                <div className="h-full w-full max-w-[1320px] mx-auto rounded-3xl border border-slate-200 bg-white shadow-sm overflow-hidden flex flex-col">
                    {/* Header */}
                    <div
                        className={cn(
                            "flex-none px-5 md:px-6 py-4 border-b",
                            darkMode
                                ? "border-slate-800 bg-slate-950"
                                : "border-slate-200 bg-white",
                        )}
                    >
                        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                            <div className="min-w-0">
                                <h1
                                    className={cn(
                                        "text-xl md:text-2xl font-semibold tracking-tight",
                                        darkMode
                                            ? "text-white"
                                            : "text-slate-900",
                                    )}
                                >
                                    Configuración
                                </h1>
                                <p
                                    className={cn(
                                        "text-sm mt-0.5",
                                        darkMode
                                            ? "text-slate-300"
                                            : "text-slate-600",
                                    )}
                                >
                                    Secciones a la izquierda + contenido a la
                                    derecha.
                                </p>
                            </div>

                            <div className="flex flex-wrap items-center gap-2">
                                <Badge>
                                    Plan:{" "}
                                    <span className="font-bold ml-1">
                                        {license.plan}
                                    </span>
                                </Badge>
                                <Badge tone={statusTone}>
                                    Estado:{" "}
                                    <span className="font-bold ml-1">
                                        {license.status}
                                    </span>
                                </Badge>
                                <Badge>
                                    Próximo pago:{" "}
                                    <span className="font-bold ml-1">
                                        {license.nextPaymentDate}
                                    </span>
                                </Badge>
                                {dirty ? (
                                    <Badge tone="warn">
                                        Cambios sin guardar
                                    </Badge>
                                ) : (
                                    <Badge tone="good">Sincronizado</Badge>
                                )}

                                {mode !== "loading" ? (
                                    <Badge>
                                        Modo:{" "}
                                        <span className="font-bold ml-1">
                                            {mode === "tpv" ? "TPV" : "Handy"}
                                        </span>
                                    </Badge>
                                ) : null}
                            </div>
                        </div>
                    </div>

                    {/* Body */}
                    <div className="flex-1 min-h-0 flex">
                        {/* Sidebar */}
                        <aside
                            className={cn(
                                "w-[300px] shrink-0 border-r hidden md:flex flex-col min-h-0",
                                darkMode
                                    ? "border-slate-800 bg-slate-950"
                                    : "border-slate-200 bg-white",
                            )}
                        >
                            <div className="px-4 pt-4">
                                <div
                                    className={cn(
                                        "text-xs font-semibold uppercase tracking-wider",
                                        darkMode
                                            ? "text-slate-300"
                                            : "text-slate-600",
                                    )}
                                >
                                    Buscar
                                </div>
                                <div className="mt-2">
                                    <TextInput
                                        value={navQuery}
                                        onChange={(e) =>
                                            setNavQuery(e.target.value)
                                        }
                                        placeholder="Ej: ticket, logo, pago…"
                                        className={cn(
                                            inputTone,
                                            darkMode
                                                ? "bg-slate-950/40"
                                                : "bg-slate-50",
                                        )}
                                    />
                                </div>
                            </div>

                            <div className="px-4 pt-5">
                                <div
                                    className={cn(
                                        "text-xs font-semibold uppercase tracking-wider",
                                        darkMode
                                            ? "text-slate-300"
                                            : "text-slate-600",
                                    )}
                                >
                                    Secciones
                                </div>
                            </div>

                            <div className="px-2 pb-4 overflow-auto min-h-0">
                                <nav className="flex flex-col gap-1">
                                    {filteredNav.map((it) => {
                                        const active = it.key === section;
                                        return (
                                            <button
                                                key={it.key}
                                                type="button"
                                                onClick={() =>
                                                    setSection(it.key)
                                                }
                                                className={cn(
                                                    "w-full text-left rounded-2xl px-3 py-3 transition border",
                                                    active
                                                        ? darkMode
                                                            ? "bg-slate-900 border-slate-800"
                                                            : "bg-slate-50 border-slate-200"
                                                        : darkMode
                                                            ? "bg-transparent border-transparent hover:bg-slate-900/50"
                                                            : "bg-transparent border-transparent hover:bg-slate-50",
                                                )}
                                            >
                                                <div
                                                    className={cn(
                                                        "text-sm font-semibold",
                                                        darkMode
                                                            ? "text-white"
                                                            : "text-slate-900",
                                                    )}
                                                >
                                                    {it.title}
                                                </div>
                                                <div
                                                    className={cn(
                                                        "text-xs mt-0.5",
                                                        darkMode
                                                            ? "text-slate-300"
                                                            : "text-slate-600",
                                                    )}
                                                >
                                                    {it.desc}
                                                </div>
                                            </button>
                                        );
                                    })}

                                    {filteredNav.length === 0 ? (
                                        <div
                                            className={cn(
                                                "px-3 py-3 text-sm rounded-2xl border",
                                                darkMode
                                                    ? "border-slate-800 text-slate-300"
                                                    : "border-slate-200 text-slate-600",
                                            )}
                                        >
                                            No hay resultados para “{navQuery}”.
                                        </div>
                                    ) : null}
                                </nav>
                            </div>

                            <div
                                className={cn(
                                    "mt-auto border-t px-4 py-4",
                                    darkMode
                                        ? "border-slate-800"
                                        : "border-slate-200",
                                )}
                            >
                                <div className="min-w-0">
                                    <div
                                        className={cn(
                                            "text-sm font-semibold truncate",
                                            darkMode
                                                ? "text-white"
                                                : "text-slate-900",
                                        )}
                                    >
                                        {draft.businessName || "TPV"}
                                    </div>
                                    <div
                                        className={cn(
                                            "text-xs truncate",
                                            darkMode
                                                ? "text-slate-300"
                                                : "text-slate-600",
                                        )}
                                    >
                                        {contactEmail}
                                    </div>
                                </div>
                            </div>
                        </aside>

                        {/* Content */}
                        <section
                            className={cn(
                                "flex-1 min-w-0 min-h-0",
                                darkMode ? "bg-slate-950" : "bg-white",
                            )}
                        >
                            {/* Mobile selector */}
                            <div
                                className={cn(
                                    "md:hidden border-b px-4 py-3",
                                    darkMode
                                        ? "border-slate-800 bg-slate-950"
                                        : "border-slate-200 bg-white",
                                )}
                            >
                                <div
                                    className={cn(
                                        "text-sm font-semibold",
                                        darkMode
                                            ? "text-white"
                                            : "text-slate-900",
                                    )}
                                >
                                    {PageTitle}
                                </div>

                                <div className="mt-3">
                                    <TextInput
                                        value={navQuery}
                                        onChange={(e) =>
                                            setNavQuery(e.target.value)
                                        }
                                        placeholder="Buscar sección…"
                                        className={cn(
                                            inputTone,
                                            darkMode
                                                ? "bg-slate-950/40"
                                                : "bg-slate-50",
                                        )}
                                    />
                                </div>

                                <div className="mt-3 overflow-auto">
                                    <div className="flex gap-2">
                                        {filteredNav.map((it) => {
                                            const active = it.key === section;
                                            return (
                                                <button
                                                    key={it.key}
                                                    type="button"
                                                    onClick={() =>
                                                        setSection(it.key)
                                                    }
                                                    className={cn(
                                                        "shrink-0 px-3 py-2 rounded-full border text-sm font-semibold",
                                                        active
                                                            ? "bg-slate-900 border-slate-900 text-white"
                                                            : darkMode
                                                                ? "bg-slate-950 border-slate-800 text-slate-200"
                                                                : "bg-white border-slate-200 text-slate-800",
                                                    )}
                                                >
                                                    {it.title}
                                                </button>
                                            );
                                        })}
                                    </div>
                                </div>
                            </div>

                            {/* Scroll interno */}
                            <div className="h-full min-h-0 overflow-auto px-4 md:px-6 py-5">
                                <div className="max-w-[980px]">
                                    <div className="mb-4">
                                        <div
                                            className={cn(
                                                "text-xs font-semibold uppercase tracking-wider",
                                                darkMode
                                                    ? "text-slate-300"
                                                    : "text-slate-600",
                                            )}
                                        >
                                            Configuración / {PageTitle}
                                        </div>

                                        <div className="flex items-start justify-between gap-3 mt-1">
                                            <h2
                                                className={cn(
                                                    "text-xl font-semibold",
                                                    darkMode
                                                        ? "text-white"
                                                        : "text-slate-900",
                                                )}
                                            >
                                                {PageTitle}
                                            </h2>

                                            {renderAnchors ? (
                                                <div
                                                    className={cn(
                                                        "hidden md:flex items-center gap-2 text-xs",
                                                        darkMode
                                                            ? "text-slate-300"
                                                            : "text-slate-600",
                                                    )}
                                                >
                                                    <span className="font-semibold">
                                                        En esta página:
                                                    </span>
                                                    <div className="flex flex-wrap gap-2">
                                                        {ticketAnchors.map(
                                                            (a) => (
                                                                <button
                                                                    key={a.id}
                                                                    type="button"
                                                                    onClick={() =>
                                                                        jumpTo(
                                                                            a.id,
                                                                        )
                                                                    }
                                                                    className={cn(
                                                                        "px-2 py-1 rounded-full border transition",
                                                                        darkMode
                                                                            ? "border-slate-800 bg-slate-950/40 hover:bg-slate-900 text-slate-200"
                                                                            : "border-slate-200 bg-white hover:bg-slate-50 text-slate-800",
                                                                    )}
                                                                >
                                                                    {a.label}
                                                                </button>
                                                            ),
                                                        )}
                                                    </div>
                                                </div>
                                            ) : null}
                                        </div>
                                    </div>

                                    <div key={animKey} className="cfg-animate">
                                        {section === "NEGOCIO" ? (
                                            <Negocio
                                                darkMode={darkMode}
                                                inputTone={inputTone}
                                                bizHydrated={bizHydrated}
                                                draft={draft}
                                                setDraft={setDraft}
                                                dirty={dirty}
                                                saving={savingBiz}
                                                onSave={onSaveBusiness}
                                                onReset={resetDraft}
                                            />
                                        ) : null}

                                        {section === "CONTACTO" ? (
                                            <Contacto
                                                inputTone={inputTone}
                                                recoveryEmail={recoveryEmail}
                                                setRecoveryEmail={
                                                    setRecoveryEmail
                                                }
                                                contactEmail={contactEmail}
                                                setContactEmail={
                                                    setContactEmail
                                                }
                                                contactPhone={contactPhone}
                                                setContactPhone={
                                                    setContactPhone
                                                }
                                            />
                                        ) : null}

                                        {section === "APARIENCIA" ? (
                                            <Apariencia
                                                darkMode={darkMode}
                                                setDarkMode={setDarkMode}
                                            />
                                        ) : null}

                                        {section === "LICENCIA" ? (
                                            <Licencia
                                                darkMode={darkMode}
                                                license={license}
                                            />
                                        ) : null}

                                        {section === "VINCULAR_HANDY" &&
                                            isMain ? (
                                            <VincularHandy
                                                darkMode={darkMode}
                                                pairCode={pairCode}
                                                pairSecret={pairSecret}
                                                expiresAtMs={pairExpiresAtMs}
                                                loading={pairLoading}
                                                error={pairError}
                                                onRegenerate={generatePair}
                                                onShowCode={() =>
                                                    alert(`Código: ${pairCode}`)
                                                }
                                            />
                                        ) : null}

                                        {section === "TICKET" ? (
                                            <Ticket
                                                inputTone={inputTone}
                                                draftIvaPercent={
                                                    draft.ivaPercent
                                                }
                                                onIvaChange={setIvaFromRaw}
                                                // ✅ nuevo
                                                footerMessage={
                                                    draft.mensajeFooter
                                                }
                                                onFooterMessageChange={(v) =>
                                                    setDraft((d) => ({
                                                        ...d,
                                                        mensajeFooter: v,
                                                    }))
                                                }
                                                ticket={ticket}
                                                setSetting={setSetting}
                                                onSaveBusiness={onSaveBusiness}
                                                savingBiz={savingBiz}
                                                canSaveBusiness={
                                                    canSaveBusiness
                                                }
                                            />
                                        ) : null}
                                    </div>
                                </div>
                            </div>
                        </section>
                    </div>
                </div>
            </div>
        </div>
    );
}
