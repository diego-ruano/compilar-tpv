import { commands, toAppError } from "@tpv/client";
// src/pages/Configuracion.tsx

import React, { useEffect, useMemo, useState } from "react";
import { useLocation } from "react-router-dom";
import { message as messageDialog } from "@tauri-apps/plugin-dialog";

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
import { useBorrador } from "../../features/configuracion/hooks/useBorrador";

// UI
import { Badge } from "../../features/configuracion/ui/Badge";

// Sections
import { Permisos } from "../../features/configuracion/sections/Permisos";
import { Negocio } from "../../features/configuracion/sections/Negocio";
import { Reservas } from "../../features/configuracion/sections/Reservas";
import { Ticket } from "../../features/configuracion/sections/Ticket";
import { Licencia } from "../../features/configuracion/sections/Licencia";
import { Conectividad } from "../../features/configuracion/sections/Conectividad";
import { Dispositivo } from "../../features/configuracion/sections/Dispositivo";
import { VincularHandy } from "../../features/configuracion/sections/VincularHandy";
import { Actualizaciones } from "../../features/configuracion/sections/Actualizaciones";
import { MSG_IVA } from "../../shared/lib/iva";
import { nifValido } from "../../shared/ticket/nif";


const CAMPOS_CORREO = ["contact_email"] as const;

export default function Configuracion() {
    // ✅ stores (ya no “hydrate” aquí; el init se hace en AppBoot)
    const biz = useBusinessSettings();

    const ticket = useTicketSettings((s) => s.settings);
    const setSetting = useTicketSettings((s) => s.setSetting);
    const ticketListo = useTicketSettings((s) => s.ready);
    const ticketError = useTicketSettings((s) => s.error);
    const ticketInit = useTicketSettings((s) => s.init);

    const mode = useMode((s) => s.mode);
    const isMain = mode === "tpv";

    // El correo de contacto se edita en Negocio y se guarda con su mismo botón, aunque vive en otra
    // tabla (`Contact_Settings`). El teléfono de contacto ya no se enseña: Negocio tiene el suyo.
    const contact = useContactSettings();
    const contactReady = useContactSettings((s) => s.ready);
    const contactInit = useContactSettings((s) => s.init);
    const contactError = useContactSettings((s) => s.error);

    // CFG-INC-01: el correo, como el resto de Negocio, es un borrador sobre lo guardado.
    const correo = useBorrador({ contact_email: contact.contact_email }, CAMPOS_CORREO);
    const contact_email = correo.borrador.contact_email;
    const setContactEmail = (v: string) => correo.cambiar({ contact_email: v });
    const contactDirty = contactReady && correo.dirty;

    const darkMode = useTheme((s) => s.theme === "dark");

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

    // Carga lazy al entrar en la sección (cubre modo Handy y TPV sin AppBoot)
    useEffect(() => {
        if (section !== "NEGOCIO") return;
        if (contactReady) return;
        contactInit().catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [section, contactReady]);

    const [animKey, setAnimKey] = useState(0);
    useEffect(() => setAnimKey((k) => k + 1), [section]);

    const baseNavItems: NavItem[] = useMemo(() => [
        {
            key: "NEGOCIO",
            title: "Negocio",
            desc: "Identidad, datos fiscales y contacto",
        },
        {
            key: "RESERVAS",
            title: "Reservas",
            desc: "Duración, solapes y reservas desde la web",
        },
        {
            key: "TICKET",
            title: "Ticket",
            desc: "Opciones de impresión",
        },
        {
            key: "LICENCIA",
            // Las copias de seguridad son de la Main: la Handy trabaja contra la nube.
            title: isMain ? "Licencias y copias de seguridad" : "Licencia",
            desc: isMain ? "Estado, renovación y copias diarias" : "Estado y renovación",
        },
        {
            key: "ACTUALIZACIONES",
            title: "Actualizaciones",
            desc: "Versión instalada y novedades",
        },
    ], [isMain]);

    const navItems: NavItem[] = useMemo(() => {
        if (!isMain)
            return [
                ...baseNavItems,
                {
                    key: "DISPOSITIVO",
                    title: "Dispositivo",
                    desc: "Desvincular este equipo",
                },
            ];
        return [
            ...baseNavItems,
            { key: "PERMISOS", title: "Permisos", desc: "Acciones permitidas por rol" },
            {
                key: "CONECTIVIDAD",
                title: "Conectividad",
                desc: "Estado de la conexión con la nube y tareas de fondo",
            },
            {
                key: "VINCULAR_HANDY",
                title: "Vincular Handy",
                desc: "Emparejar otro dispositivo",
            },
        ];
    }, [isMain, baseNavItems]);

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

    // Draft + dirty (hook) (tu hook ya no depende de hydrate)
    const { draft, setDraft, base, dirty, cambios, choques, resetDraft, setIvaFromRaw, ivaTexto, ivaValido } =
        useBusinessDraft(biz);

    // Save negocio
    const [savingBiz, setSavingBiz] = useState(false);
    // En Negocio no sale el «Guardado» nativo: al guardar, el botón se apaga y desaparece el aviso de
    // los datos fiscales que faltaban. Los errores sí salen.
    const guardarNegocio = async (avisarGuardado: boolean) => {
        // RI-78: el borrador se guarda entero desde varias secciones. Con un IVA tecleado que no
        // vale, guardar el último válido sería guardar otro número sin decirlo.
        if (!ivaValido) {
            await messageDialog(`${MSG_IVA}. Corrígelo en la sección Ticket.`, { kind: "error" });
            return;
        }
        // CFG-INC-02: con una lectura fallida lo que hay en pantalla puede no ser lo guardado.
        if (biz.error || contactError) return;
        // Y lo mismo con el NIF, que también va en el borrador: guardar uno que no vale deja el TPV
        // sin poder cobrar.
        if (draft.cif.trim() && !nifValido(draft.cif)) {
            await messageDialog("El NIF no es válido. Corrígelo en la sección Negocio.", { kind: "error" });
            return;
        }
        try {
            setSavingBiz(true);
            // El correo va primero porque lo valida el backend: si no vale, no se guarda nada.
            if (contactDirty) await contact.guardar(correo.cambios);
            if (dirty) {
                // Logo anterior (para limpiar del bucket/disco si se reemplazó por otro del canal R2):
                // el que había cuando se tomó el borrador, que es el que se sustituye.
                const prevLogo = base.logo_data_url;
                // CFG-INC-01: sólo lo que se ha cambiado aquí. Mandarlo todo devolvía a su valor de
                // antes lo que otro equipo hubiera cambiado mientras tanto. Se espera a que esté
                // escrito: «Guardado» sólo sale si se ha guardado, y Fiscal vuelve a preguntar si
                // faltan los datos cuando ya están en la base.
                await biz.guardar(cambios);
                // Best-effort: si el logo anterior era una ruta relativa (canal R2) y cambió, borrarlo.
                if (
                    "logo_data_url" in cambios &&
                    prevLogo &&
                    prevLogo.startsWith("images/logo/") &&
                    prevLogo !== cambios.logo_data_url
                ) {
                    void commands.imagesDelete({ rel_path: prevLogo }).catch(() => {});
                }
            }
            if (avisarGuardado) await messageDialog("Guardado");
        } catch (e) {
            await messageDialog(`No se ha podido guardar: ${toAppError(e).message}`, {
                kind: "error",
            });
        } finally {
            setSavingBiz(false);
        }
    };
    const onSaveBusiness = () => guardarNegocio(true);
    const onSaveNegocio = () => guardarNegocio(false);

    const canSaveBusiness = dirty && !savingBiz && biz.error === null;

    const hayCambios = dirty || contactDirty;
    const descartarNegocio = () => {
        resetDraft();
        correo.descartar();
    };

    // El código de emparejamiento (y su ciclo de vida) vive en `usePairCode`: esta página se
    // desmonta al navegar, y con el estado aquí cada visita a "Vincular Handy" pedía un código
    // nuevo — el QR cambiaba delante de quien lo estaba escaneando.

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

                            {/* Sólo el aviso de cambios pendientes. Los distintivos permanentes
                                ("Sincronizado", "Modo: TPV") no decían nada que el usuario no
                                supiera ya y ocupaban la esquina que mira cuando busca un aviso. */}
                            {hayCambios ? (
                                <div className="flex flex-wrap items-center gap-2">
                                    <Badge tone="warn">Cambios sin guardar</Badge>
                                </div>
                            ) : null}
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
                            <div className="px-5 pt-5 pb-3">
                                <div className="text-xs font-semibold uppercase tracking-wider text-fg-muted">
                                    Secciones
                                </div>
                            </div>

                            <div className="px-2 pb-4 overflow-auto min-h-0">
                                <nav className="flex flex-col gap-1">
                                    {navItems.map((it) => {
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
                                        {draft.business_name || "TPV"}
                                    </div>
                                    <div
                                        className={cn(
                                            "text-xs truncate",
                                            darkMode
                                                ? "text-fg-muted"
                                                : "text-fg-muted",
                                        )}
                                    >
                                        {contact_email}
                                    </div>
                                </div>
                            </div>
                        </aside>

                        {/* Content. CFG-INC-03: columna flex. En estrecho lleva encima el selector de
                            secciones, y el scroll ocupa lo que queda (`flex-1 min-h-0`). Con `h-full`
                            medía el 100 % más el selector, y el `overflow-hidden` de fuera recortaba el final:
                            en Android «Guardar cambios» quedaba fuera de la pantalla. */}
                        <section
                            data-testid="cfg-contenido"
                            className={cn(
                                "flex-1 min-w-0 min-h-0 flex flex-col",
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

                                <div className="mt-3 overflow-auto">
                                    <div className="flex gap-2">
                                        {navItems.map((it) => {
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
                            <div data-testid="cfg-scroll" className="flex-1 min-h-0 overflow-auto px-4 md:px-6 py-5">
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
                                        {section === "PERMISOS" && isMain && <Permisos />}
                        {section === "NEGOCIO" ? (
                                            <Negocio
                                                darkMode={darkMode}
                                                inputTone={inputTone}
                                                draft={draft}
                                                setDraft={setDraft}
                                                choques={choques}
                                                choqueCorreo={correo.choques.contact_email}
                                                correo={contact_email}
                                                setCorreo={setContactEmail}
                                                correoCargando={!contactReady && contactError === null}
                                                correoError={contactError}
                                                onReintentarCorreo={contactInit}
                                                listo={biz.ready}
                                                error={biz.error}
                                                onReintentar={biz.init}
                                                dirty={hayCambios}
                                                saving={savingBiz}
                                                onSave={onSaveNegocio}
                                                onReset={descartarNegocio}
                                            />
                                        ) : null}

                                        {section === "RESERVAS" ? (
                                            <Reservas inputTone={inputTone} isMain={isMain} />
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
                                            <VincularHandy darkMode={darkMode} />
                                        ) : null}

                                        {section === "ACTUALIZACIONES" ? (
                                            <Actualizaciones darkMode={darkMode} />
                                        ) : null}

                                        {section === "TICKET" ? (
                                            <Ticket
                                                inputTone={inputTone}
                                                ivaTexto={ivaTexto}
                                                ivaValido={ivaValido}
                                                onIvaChange={setIvaFromRaw}
                                                // ✅ nuevo
                                                footerMessage={
                                                    draft.mensaje_footer
                                                }
                                                choqueIva={choques.iva_percent}
                                                choqueFooter={choques.mensaje_footer}
                                                onFooterMessageChange={(v) =>
                                                    setDraft((d) => ({
                                                        ...d,
                                                        mensaje_footer: v,
                                                    }))
                                                }
                                                ticket={ticket}
                                                ticketListo={ticketListo}
                                                ticketError={ticketError}
                                                onReintentarTicket={ticketInit}
                                                negocioListo={biz.ready}
                                                negocioError={biz.error}
                                                onReintentarNegocio={biz.init}
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
