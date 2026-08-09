// src/pages/Configuracion.tsx

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import { message as messageDialog } from "@tauri-apps/plugin-dialog";
import { invokeClient } from "@tpv/client";
import type { PairCreateResult } from "@tpv/contracts";
import { useBusinessSettings } from "../../shared/stores/useBusinessSettings";
import { useTicketSettings } from "../../shared/stores/useTicketSettings";
import { useMode } from "../../shared/stores/useMode";
import { useContactSettings } from "../../shared/stores/useContactSettings";
import { useTheme } from "../../shared/stores/useTheme";

import { Settings } from "lucide-react";
import { cn } from "../../features/configuracion/utils";
import type {
    NavItem,
    SectionKey,
} from "../../features/configuracion/types";
import { useBusinessDraft } from "../../features/configuracion/hooks/useBusinessDraft";

// UI
import { Badge } from "../../features/configuracion/ui/Badge";
import { TextInput } from "../../features/configuracion/ui/Inputs";

// Sections
import { Negocio } from "../../features/configuracion/sections/Negocio";
import { Contacto } from "../../features/configuracion/sections/Contacto";
import { Ticket } from "../../features/configuracion/sections/Ticket";
import { Licencia } from "../../features/configuracion/sections/Licencia";
import { Apariencia } from "../../features/configuracion/sections/Apariencia";
import { Conectividad } from "../../features/configuracion/sections/Conectividad";
import { Dispositivo } from "../../features/configuracion/sections/Dispositivo";
import { VincularHandy } from "../../features/configuracion/sections/VincularHandy";
import { EmailConfig } from "../../features/configuracion/sections/EmailConfig";
import { Actualizaciones } from "../../features/configuracion/sections/Actualizaciones";


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

    // Datos de contacto — store + draft local
    const contact = useContactSettings();
    const contactReady = useContactSettings((s) => s.ready);
    const contactInit = useContactSettings((s) => s.init);

    const [recoveryEmail, setRecoveryEmail] = useState("");
    const [contactEmail, setContactEmail] = useState("");
    const [contactPhone, setContactPhone] = useState("");
    const [savingContact, setSavingContact] = useState(false);

    // Conectado al tema global real: el switch de Apariencia cambia toda la app.
    const darkMode = useTheme((s) => s.theme === "dark");
    const setDarkMode = useCallback(
        (v: boolean) => useTheme.getState().setTheme(v ? "dark" : "light"),
        [],
    );

    // Sección de arranque. Se puede pedir una concreta al navegar
    // (`navigate("/Configuracion", { state: { seccion: "LICENCIA" } })`); lo usan las
    // notificaciones con acción para caer directamente en la pantalla que resuelve el aviso.
    const location = useLocation();
    const seccionSolicitada = (location.state as { seccion?: SectionKey } | null)
        ?.seccion;
    const [section, setSection] = useState<SectionKey>(
        seccionSolicitada ?? "NEGOCIO",
    );

    // Si ya estábamos en Configuración, un `navigate` nuevo no remonta: hay que reaccionar aquí.
    useEffect(() => {
        if (seccionSolicitada) setSection(seccionSolicitada);
    }, [seccionSolicitada]);

    // Sincroniza el draft con el store la primera vez que carga
    const contactSyncedRef = useRef(false);
    useEffect(() => {
        if (!contactReady || contactSyncedRef.current) return;
        contactSyncedRef.current = true;
        setRecoveryEmail(contact.recoveryEmail);
        setContactEmail(contact.contactEmail);
        setContactPhone(contact.contactPhone);
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [contactReady]);

    // Carga lazy al entrar en la sección (cubre modo Handy y TPV sin AppBoot)
    useEffect(() => {
        if (section !== "CONTACTO") return;
        if (contactReady) return;
        contactInit().catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [section, contactReady]);
    const [navQuery, setNavQuery] = useState("");

    const [animKey, setAnimKey] = useState(0);
    useEffect(() => setAnimKey((k) => k + 1), [section]);

    const baseNavItems: NavItem[] = useMemo(() => [
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
        {
            key: "EMAIL_CONFIG",
            title: "Correos automatizados",
            desc: "Envío de pedidos a proveedores",
            keywords: ["email", "correo", "smtp", "pedidos", "proveedor", "cloudflare"],
        },
        {
            key: "ACTUALIZACIONES",
            title: "Actualizaciones",
            desc: "Versión instalada y novedades",
            keywords: [
                "actualizacion",
                "actualizaciones",
                "update",
                "versión",
                "version",
                "novedades",
                "instalar",
            ],
        },
    ], []);

    const navItems: NavItem[] = useMemo(() => {
        if (!isMain)
            return [
                ...baseNavItems,
                {
                    key: "DISPOSITIVO",
                    title: "Dispositivo",
                    desc: "Desvincular este equipo",
                    keywords: [
                        "desvincular",
                        "dispositivo",
                        "handy",
                        "salir",
                        "reset",
                    ],
                },
            ];
        return [
            ...baseNavItems,
            {
                key: "CONECTIVIDAD",
                title: "Modo de funcionamiento",
                desc: "Local o sincronizado con la nube",
                keywords: [
                    "modo",
                    "conexión",
                    "online",
                    "offline",
                    "nube",
                    "internet",
                    "copia",
                    "backup",
                ],
            },
            {
                key: "VINCULAR_HANDY",
                title: "Vincular Handy",
                desc: "Emparejar otro dispositivo",
                keywords: ["handy", "vincular", "emparejar", "qr", "pair"],
            },
        ];
    }, [isMain, baseNavItems]);

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
                ? "bg-surface-2 border-border text-white placeholder:text-fg-muted"
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
            bizInit().catch((e: unknown) => console.warn("[Configuracion] bizInit error:", e));
        }
        if (typeof ticketInit === "function" && !ticketHydrated) {
            ticketInit().catch((e: unknown) => console.warn("[Configuracion] ticketInit error:", e));
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
            // Logo anterior (para limpiar del bucket/disco si se reemplazó por otro del canal R2).
            const prevLogo = biz.logoDataUrl;
            await (biz as any).setMany({
                businessName: draft.businessName,
                logoDataUrl: draft.logoDataUrl,
                direccion: draft.direccion,
                telefono: draft.telefono,
                cif: draft.cif,
                mensajeFooter: draft.mensajeFooter,
                ivaPercent: draft.ivaPercent,
            });
            // Best-effort: si el logo anterior era una ruta relativa (canal R2) y cambió, borrarlo.
            if (
                prevLogo &&
                prevLogo.startsWith("images/logo/") &&
                prevLogo !== draft.logoDataUrl
            ) {
                void invokeClient("images_delete", {
                    args: { rel_path: prevLogo },
                }).catch(() => {});
            }
            await messageDialog("Guardado");
        } catch {
            await messageDialog("No se pudo guardar. Revisa la consola.", {
                kind: "error",
            });
        } finally {
            setSavingBiz(false);
        }
    };

    const canSaveBusiness = dirty && !savingBiz && bizHydrated;

    const onSaveContact = async () => {
        try {
            setSavingContact(true);
            contact.setMany({ recoveryEmail, contactEmail, contactPhone });
            await messageDialog("Guardado");
        } catch {
            await messageDialog("No se pudo guardar. Revisa la consola.", {
                kind: "error",
            });
        } finally {
            setSavingContact(false);
        }
    };

    // ✅ Vincular handy (REAL con invoke->Rust)
    const [pairCode, setPairCode] = useState("");
    const [pairSecret, setPairSecret] = useState("");
    const [pairExpiresAtMs, setPairExpiresAtMs] = useState<number | null>(null);
    const [pairLoading, setPairLoading] = useState(false);
    const [pairError, setPairError] = useState<string | null>(null);

    const generatePair = async () => {
        try {
            setPairError(null);
            setPairLoading(true);

            // Comando hexagonal dedicado: pide al worker un código nuevo (firma device-proof
            // en modo TPV) y devuelve el DTO tipado generado desde Rust.
            const j = await invokeClient<PairCreateResult>("pair_create");

            setPairCode(String(j.pairCode || ""));
            setPairSecret(String(j.pairSecret || ""));
            setPairExpiresAtMs(
                typeof j.expiresAtMs === "number" ? j.expiresAtMs : null,
            );
        } catch (e: any) {
            setPairError(String(e?.message || e));
        } finally {
            setPairLoading(false);
        }
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

    // Si cambia a handy, fuera de las secciones solo-Main
    useEffect(() => {
        if (mode === "loading") return;
        if (
            !isMain &&
            (section === "VINCULAR_HANDY" || section === "CONECTIVIDAD")
        )
            setSection("LICENCIA");
        if (isMain && section === "DISPOSITIVO") setSection("LICENCIA");
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isMain, mode]);

    return (
        <div className="w-full h-full overflow-hidden bg-bg">
            {/* `.cfg-animate` vive en Global.css: un <style> inline aquí lo bloquearía la CSP
                del build de producción (ver features/estadisticas/apexBase.ts). */}
            <div className="h-full w-full p-3 sm:p-4 lg:px-10 lg:py-5">
                <div className="flex h-full w-full flex-col overflow-hidden rounded-3xl border border-border bg-surface shadow-sm">
                    {/* Header */}
                    <div
                        className={cn(
                            "flex-none px-5 md:px-6 py-4 border-b",
                            darkMode
                                ? "border-border bg-surface-2"
                                : "border-border bg-surface",
                        )}
                    >
                        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                            <div className="flex min-w-0 items-center gap-3">
                                <div className="grid size-11 shrink-0 place-items-center rounded-2xl bg-accent-soft text-accent">
                                    <Settings className="size-6" aria-hidden />
                                </div>
                                <div className="min-w-0">
                                    <h1 className="text-xl font-bold tracking-tight text-fg md:text-2xl">
                                        Configuración
                                    </h1>
                                    <p className="mt-0.5 text-sm text-fg-muted">
                                        Secciones a la izquierda + contenido a la derecha.
                                    </p>
                                </div>
                            </div>

                            <div className="flex flex-wrap items-center gap-2">
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
                                    ? "border-border bg-surface-2"
                                    : "border-border bg-surface",
                            )}
                        >
                            <div className="px-4 pt-4">
                                <div
                                    className={cn(
                                        "text-xs font-semibold uppercase tracking-wider",
                                        darkMode
                                            ? "text-fg-muted"
                                            : "text-fg-muted",
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
                                                ? "bg-surface-2"
                                                : "bg-surface-2",
                                        )}
                                    />
                                </div>
                            </div>

                            <div className="px-4 pt-5">
                                <div
                                    className={cn(
                                        "text-xs font-semibold uppercase tracking-wider",
                                        darkMode
                                            ? "text-fg-muted"
                                            : "text-fg-muted",
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
                                                    "w-full text-left rounded-2xl px-3 py-3 border transition-colors duration-150",
                                                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-surface",
                                                    active
                                                        ? "bg-accent-soft border-accent/30"
                                                        : "bg-transparent border-transparent hover:bg-surface-2 hover:border-border",
                                                )}
                                                aria-current={
                                                    active ? "page" : undefined
                                                }
                                            >
                                                <div
                                                    className={cn(
                                                        "text-sm font-semibold",
                                                        darkMode
                                                            ? "text-white"
                                                            : "text-fg",
                                                    )}
                                                >
                                                    {it.title}
                                                </div>
                                                <div
                                                    className={cn(
                                                        "text-xs mt-0.5",
                                                        darkMode
                                                            ? "text-fg-muted"
                                                            : "text-fg-muted",
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
                                                    ? "border-border text-fg-muted"
                                                    : "border-border text-fg-muted",
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
                                        ? "border-border"
                                        : "border-border",
                                )}
                            >
                                <div className="min-w-0">
                                    <div
                                        className={cn(
                                            "text-sm font-semibold truncate",
                                            darkMode
                                                ? "text-white"
                                                : "text-fg",
                                        )}
                                    >
                                        {draft.businessName || "TPV"}
                                    </div>
                                    <div
                                        className={cn(
                                            "text-xs truncate",
                                            darkMode
                                                ? "text-fg-muted"
                                                : "text-fg-muted",
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
                                darkMode ? "bg-surface-2" : "bg-surface",
                            )}
                        >
                            {/* Mobile selector */}
                            <div
                                className={cn(
                                    "md:hidden border-b px-4 py-3",
                                    darkMode
                                        ? "border-border bg-surface-2"
                                        : "border-border bg-surface",
                                )}
                            >
                                <div
                                    className={cn(
                                        "text-sm font-semibold",
                                        darkMode
                                            ? "text-white"
                                            : "text-fg",
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
                                                ? "bg-surface-2"
                                                : "bg-surface-2",
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
                                                            ? "bg-surface-2 border-border text-white"
                                                            : darkMode
                                                                ? "bg-surface-2 border-border text-fg-muted"
                                                                : "bg-surface border-border text-fg",
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
                                <div className="w-full">
                                    <div className="mb-4">
                                        <div
                                            className={cn(
                                                "text-xs font-semibold uppercase tracking-wider",
                                                darkMode
                                                    ? "text-fg-muted"
                                                    : "text-fg-muted",
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
                                                        : "text-fg",
                                                )}
                                            >
                                                {PageTitle}
                                            </h2>

                                            {renderAnchors ? (
                                                <div
                                                    className={cn(
                                                        "hidden md:flex items-center gap-2 text-xs",
                                                        darkMode
                                                            ? "text-fg-muted"
                                                            : "text-fg-muted",
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
                                                                            ? "border-border bg-surface-2 hover:bg-surface-2 text-fg-muted"
                                                                            : "border-border bg-surface hover:bg-surface-2 text-fg",
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
                                                setRecoveryEmail={setRecoveryEmail}
                                                contactEmail={contactEmail}
                                                setContactEmail={setContactEmail}
                                                contactPhone={contactPhone}
                                                setContactPhone={setContactPhone}
                                                loading={!contactReady}
                                                saving={savingContact}
                                                onSave={onSaveContact}
                                            />
                                        ) : null}

                                        {section === "APARIENCIA" ? (
                                            <Apariencia
                                                darkMode={darkMode}
                                                setDarkMode={setDarkMode}
                                            />
                                        ) : null}

                                        {section === "CONECTIVIDAD" &&
                                            isMain ? (
                                            <Conectividad darkMode={darkMode} />
                                        ) : null}

                                        {section === "DISPOSITIVO" &&
                                            !isMain ? (
                                            <Dispositivo darkMode={darkMode} />
                                        ) : null}

                                        {section === "LICENCIA" ? (
                                            <Licencia darkMode={darkMode} />
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
                                                onShowCode={() => {
                                                    void messageDialog(
                                                        `Código: ${pairCode}`,
                                                    );
                                                }}
                                            />
                                        ) : null}

                                        {section === "EMAIL_CONFIG" ? (
                                            <EmailConfig darkMode={darkMode} />
                                        ) : null}

                                        {section === "ACTUALIZACIONES" ? (
                                            <Actualizaciones darkMode={darkMode} />
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
