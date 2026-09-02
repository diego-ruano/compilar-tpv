import { useEffect, useState } from "react";
import type { AppErrorDto, LocalBackupInfo } from "@tpv/contracts";
import { toAppError } from "@tpv/client";
import { open } from "@tauri-apps/plugin-dialog";
import {
    AlertTriangle,
    CheckCircle2,
    CloudDownload,
    DatabaseBackup,
    FolderOpen,
    HardDriveDownload,
    Loader2,
    ShieldAlert,
} from "lucide-react";
import {
    importarCopiaLocal,
    inicializarTenantVacio,
    listarCopiasLocales,
    recuperarDesdeCopiaLocal,
    recuperarDesdeNube,
    type BootstrapResultado,
} from "../../features/login/loginApi";
import { useEstadoSync } from "../../shared/stores/useEstadoSync";
import { Badge, Button, Card } from "../../shared/ui";
import Titlebar from "../layoutComponent/Titlebar";

type Origen = "local" | "cloud" | "empty";

function fechaCopia(ms: number): string {
    return new Intl.DateTimeFormat("es-ES", {
        dateStyle: "medium",
        timeStyle: "short",
    }).format(new Date(ms));
}

function textoFase(fase: string): string {
    switch (fase) {
        case "descargando":
            return "Trayendo los cambios posteriores a la copia…";
        case "subiendo":
            return "Guardando en la nube los cambios locales pendientes…";
        case "verificando":
            return "Comprobando que ambas bases de datos coinciden…";
        case "error":
            return "Se reintentará cuando la conexión vuelva a estar disponible.";
        case "bloqueada":
            return "La reconciliación no ha podido terminar por sí sola.";
        default:
            return "Esperando una conexión segura con la nube…";
    }
}

/** Recuperación bloqueante: el login sólo aparece después de reconciliar la copia con la nube. */
export default function RecuperarDatos({ onRecuperado }: { onRecuperado?: () => void }) {
    const [backups, setBackups] = useState<LocalBackupInfo[]>([]);
    const [cargandoBackups, setCargandoBackups] = useState(true);
    const [operacion, setOperacion] = useState<Origen | null>(null);
    const [error, setError] = useState<AppErrorDto | null>(null);
    const [resultado, setResultado] = useState<BootstrapResultado | null>(null);
    const [origen, setOrigen] = useState<Origen | null>(null);

    const reconciliacionPendiente = useEstadoSync((s) => s.reconciliacionPendiente);
    const fase = useEstadoSync((s) => s.faseRecuperacion);
    const errorReconciliacion = useEstadoSync((s) => s.errorRecuperacion);
    const iniciarReconciliacion = useEstadoSync((s) => s.iniciarReconciliacion);
    const reintentarRecuperacion = useEstadoSync((s) => s.reintentarRecuperacion);

    useEffect(() => {
        let vivo = true;
        listarCopiasLocales()
            .then((items) => {
                if (vivo) setBackups(items);
            })
            .catch((e) => {
                if (vivo) setError(toAppError(e));
            })
            .finally(() => {
                if (vivo) setCargandoBackups(false);
            });
        return () => {
            vivo = false;
        };
    }, []);

    /**
     * Copia guardada fuera del equipo (un USB). Es la única salida cuando el disco ha muerto: las
     * copias diarias viven en el mismo disco que protegen, y la nube no guarda la PII del personal.
     * Se importa al almacén local y se restaura por el MISMO camino que las demás, con sus mismas
     * guardias, en vez de abrir una segunda vía de restauración.
     */
    async function restaurarDesdeArchivo() {
        let elegido: string | string[] | null = null;
        try {
            elegido = await open({
                multiple: false,
                directory: false,
                title: "Elige una copia de seguridad",
                filters: [{ name: "Copia de seguridad", extensions: ["db"] }],
            });
        } catch (e) {
            setError(toAppError(e));
            return;
        }
        if (typeof elegido !== "string") return;

        const ruta = elegido;
        await ejecutar("local", async () => {
            const copia = await importarCopiaLocal(ruta);
            return recuperarDesdeCopiaLocal(copia.id);
        });
    }

    async function ejecutar(origenNuevo: Origen, fn: () => Promise<unknown>) {
        setOperacion(origenNuevo);
        setError(null);
        try {
            const r = await fn();
            if (origenNuevo !== "local") setResultado(r as BootstrapResultado);
            setOrigen(origenNuevo);
            // La restauración ya dejó la marca persistente en SQLite. Esto permite abrir el WS,
            // pero mantiene esta pantalla hasta que el protocolo confirme la convergencia.
            iniciarReconciliacion();
        } catch (e) {
            setError(toAppError(e));
        } finally {
            setOperacion(null);
        }
    }

    // Bloqueada = la reconciliación agotó sus reintentos. Se sale del modo "en curso" a propósito:
    // lo que hace falta ahora es una decisión (reintentar, otra copia, la nube), y esas opciones
    // viven en la pantalla de elección.
    const bloqueada = fase === "bloqueada";
    const trabajando = operacion !== null || (reconciliacionPendiente && !bloqueada);
    const completada = fase === "completada";
    const puedeCrearVacia = error?.code === "tenant_db_not_provisioned";

    return (
        <div className="flex h-full min-h-0 w-full flex-col overflow-hidden bg-bg text-fg">
            <Titlebar />
            <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-y-auto p-4 sm:p-6 lg:p-10">
                <Card padded={false} className="relative w-full max-w-2xl overflow-hidden rounded-3xl shadow-xl">
                    <section className="border-b border-border bg-surface-2 p-6 sm:p-8">
                        <div className="flex items-center justify-between gap-3">
                            <div className="grid size-14 place-items-center rounded-2xl bg-accent-soft text-accent">
                                <DatabaseBackup className="size-7" aria-hidden />
                            </div>
                            <Badge tone="accent">Recuperación</Badge>
                        </div>
                        <h1 className="mt-6 text-2xl font-bold tracking-tight sm:text-3xl">
                            Recuperar los datos de este TPV
                        </h1>
                        <p className="mt-3 text-sm leading-relaxed text-fg-muted sm:text-base">
                            Puedes usar una copia diaria de este ordenador o descargar el estado
                            actual de la nube. Después se comprobarán ambos lados antes de permitir
                            trabajar de nuevo.
                        </p>
                    </section>

                    <section className="grid gap-5 p-6 sm:p-8">
                        {completada ? (
                            <>
                                <div className="flex gap-3 rounded-2xl border border-border bg-surface px-4 py-3">
                                    <CheckCircle2 className="size-5 shrink-0 text-success" aria-hidden />
                                    <div className="text-sm">
                                        <p className="font-semibold">Datos recuperados y sincronizados</p>
                                        <p className="mt-0.5 text-fg-muted">
                                            La copia local y la nube ya están reconciliadas. Puedes
                                            iniciar sesión con tu PIN habitual.
                                        </p>
                                    </div>
                                </div>

                                {origen === "cloud" && (
                                    <div className="flex gap-3 rounded-2xl border border-border bg-surface px-4 py-3 text-sm">
                                        <ShieldAlert className="size-5 shrink-0 text-warning" aria-hidden />
                                        <span className="text-fg-muted">
                                            Revisa el DNI, IBAN y número de la Seguridad Social del
                                            personal: están cifrados sólo en este equipo y no forman
                                            parte de la copia de la nube.
                                        </span>
                                    </div>
                                )}

                                {resultado && resultado.tablas_desconocidas.length > 0 && (
                                    <div className="flex gap-3 rounded-2xl border border-border bg-surface px-4 py-3 text-sm">
                                        <AlertTriangle className="size-5 shrink-0 text-warning" aria-hidden />
                                        <span className="text-fg-muted">
                                            Esta versión no reconoce: {resultado.tablas_desconocidas.join(", ")}.
                                        </span>
                                    </div>
                                )}

                                <Button onClick={() => onRecuperado?.()}>Ir al inicio de sesión</Button>
                            </>
                        ) : trabajando || fase === "error" ? (
                            <div className="grid gap-4">
                                <div className="flex gap-3 rounded-2xl border border-border bg-surface px-4 py-4">
                                    <Loader2 className="size-5 shrink-0 animate-spin text-accent" aria-hidden />
                                    <div className="text-sm">
                                        <p className="font-semibold">Recuperación en curso</p>
                                        <p className="mt-1 text-fg-muted">{textoFase(fase)}</p>
                                    </div>
                                </div>
                                {errorReconciliacion && (
                                    <div className="rounded-2xl border border-danger bg-danger-soft px-4 py-3 text-sm text-fg">
                                        {errorReconciliacion}
                                    </div>
                                )}
                                <p className="text-center text-xs text-fg-muted">
                                    No cierres la aplicación. Hace falta conexión a internet para terminar.
                                </p>
                            </div>
                        ) : (
                            <>
                                {bloqueada && (
                                    <div className="grid gap-3 rounded-2xl border border-danger bg-danger-soft px-4 py-3 text-sm">
                                        <div className="flex gap-3">
                                            <AlertTriangle className="size-5 shrink-0 text-danger" aria-hidden />
                                            <div>
                                                <p className="font-semibold">
                                                    La recuperación no ha podido completarse
                                                </p>
                                                <p className="mt-0.5 text-fg-muted">
                                                    {errorReconciliacion ??
                                                        "La nube no confirmó que ambos lados coincidan."}
                                                </p>
                                            </div>
                                        </div>
                                        <Button
                                            variant="secondary"
                                            onClick={() => reintentarRecuperacion()}
                                        >
                                            Reintentar la sincronización
                                        </Button>
                                        <p className="text-xs text-fg-muted">
                                            Si vuelve a fallar, prueba con otra copia o con el estado de
                                            la nube. Los datos de esta base que aún no habían subido se
                                            perderían al reemplazarla.
                                        </p>
                                    </div>
                                )}

                                <div>
                                    <h2 className="text-sm font-semibold">Copias de este ordenador</h2>
                                    <div className="mt-3 grid gap-2">
                                        {cargandoBackups ? (
                                            <p className="text-sm text-fg-muted">Buscando copias…</p>
                                        ) : backups.length === 0 ? (
                                            <p className="rounded-xl border border-border bg-surface px-4 py-3 text-sm text-fg-muted">
                                                Todavía no hay ninguna copia local disponible.
                                            </p>
                                        ) : (
                                            backups.map((backup, index) => (
                                                <Button
                                                    key={backup.id}
                                                    variant="secondary"
                                                    disabled={operacion !== null}
                                                    onClick={() =>
                                                        void ejecutar("local", () => recuperarDesdeCopiaLocal(backup.id))
                                                    }
                                                >
                                                    <HardDriveDownload className="size-4" aria-hidden />
                                                    {backup.importada
                                                        ? "Copia importada"
                                                        : index === 0
                                                          ? "Última copia"
                                                          : "Copia"}
                                                    : {fechaCopia(backup.created_at_ms)}
                                                </Button>
                                            ))
                                        )}

                                        <Button
                                            variant="secondary"
                                            disabled={operacion !== null}
                                            onClick={() => void restaurarDesdeArchivo()}
                                        >
                                            <FolderOpen className="size-4" aria-hidden />
                                            Restaurar desde un archivo…
                                        </Button>
                                        <p className="text-xs text-fg-muted">
                                            Para una copia guardada en un USB o en una carpeta de red.
                                            Tiene que ser una copia de <strong>este mismo TPV</strong>.
                                        </p>
                                    </div>
                                </div>

                                <div className="border-t border-border pt-5">
                                    <Button
                                        disabled={operacion !== null}
                                        onClick={() => void ejecutar("cloud", recuperarDesdeNube)}
                                    >
                                        <CloudDownload className="size-4" aria-hidden />
                                        Recuperar el estado actual de la nube
                                    </Button>
                                </div>

                                {error && (
                                    <div className="grid gap-3 rounded-2xl border border-danger bg-danger-soft px-4 py-3 text-sm">
                                        <div className="flex gap-3">
                                            <AlertTriangle className="size-5 shrink-0 text-danger" aria-hidden />
                                            <span>{error.message}</span>
                                        </div>
                                        {puedeCrearVacia && (
                                            <Button
                                                variant="secondary"
                                                onClick={() => void ejecutar("empty", inicializarTenantVacio)}
                                            >
                                                Crear una base de datos nueva y vacía
                                            </Button>
                                        )}
                                    </div>
                                )}

                                <p className="text-center text-xs text-fg-muted">
                                    Un error de conexión nunca se interpreta como “no hay datos”. La
                                    opción de empezar de cero sólo aparece si el servidor lo confirma.
                                </p>
                            </>
                        )}
                    </section>
                </Card>
            </div>
        </div>
    );
}
