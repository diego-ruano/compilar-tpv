import type { BootstrapResultado } from "@tpv/contracts";
import { commands } from "@tpv/client";
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
} from "lucide-react";

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

const DIA_MS = 24 * 60 * 60 * 1000;

/**
 * AUD-19: la nube purga los cambios de más de 7 días. Con una copia más antigua puede faltar lo que
 * pasó en medio, y entonces la reconciliación no termina con ella. Se avisa antes de elegir, sin
 * impedirlo: si la nube aún lo guarda todo, la copia vale.
 */
const DIAS_QUE_GUARDA_LA_NUBE = 7;

function antiguedadCopia(ms: number, ahora: number): { texto: string; vieja: boolean } {
    const dias = Math.floor((ahora - ms) / DIA_MS);
    const texto = dias < 1 ? "hace menos de un día" : dias === 1 ? "hace 1 día" : `hace ${dias} días`;
    return { texto, vieja: ahora - ms > DIAS_QUE_GUARDA_LA_NUBE * DIA_MS };
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
    // La antigüedad de las copias se cuenta desde que se abre la pantalla.
    const [ahora] = useState(() => Date.now());

    const reconciliacionPendiente = useEstadoSync((s) => s.reconciliacionPendiente);
    // La licencia viene de otro equipo: lo de este ordenador es de antes, copias incluidas, así que
    // sólo se ofrece la nube (el backend también rechaza restaurar una copia local en este estado).
    const trasladoPendiente = useEstadoSync((s) => s.trasladoPendiente);
    const fase = useEstadoSync((s) => s.faseRecuperacion);
    const errorReconciliacion = useEstadoSync((s) => s.errorRecuperacion);
    const iniciarReconciliacion = useEstadoSync((s) => s.iniciarReconciliacion);
    const reintentarRecuperacion = useEstadoSync((s) => s.reintentarRecuperacion);

    useEffect(() => {
        let vivo = true;
        commands.recoveryListBackups()
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
     * Copia guardada fuera del equipo (un USB). Cuando el disco ha muerto es la única forma de
     * recuperar lo que no llegó a subir a la nube: las copias diarias viven en el mismo disco que
     * protegen. (La PII del personal sí vuelve de la nube, cifrada: RI-41, TRAB-03.)
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
                // La que saca «Guardar fuera…» va comprimida (`.db.gz`); una `.db` tal cual (una
                // copia antigua, o la base rescatada de otro equipo) también vale.
                filters: [{ name: "Copia de seguridad", extensions: ["gz", "db"] }],
            });
        } catch (e) {
            setError(toAppError(e));
            return;
        }
        if (typeof elegido !== "string") return;

        const ruta = elegido;
        await ejecutar("local", async () => {
            const copia = await commands.recoveryImportBackup(ruta);
            return commands.recoveryRestoreBackup(copia.id);
        });
    }

    async function ejecutar(origenNuevo: Origen, fn: () => Promise<unknown>) {
        setOperacion(origenNuevo);
        setError(null);
        try {
            const r = await fn();
            if (origenNuevo !== "local") setResultado(r as BootstrapResultado);
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
    // DO-02: la descarga de la nube tiene un tope, y la nube se encoge hasta lo imprescindible para
    // trabajar (la carta, el personal, los clientes, las reservas y lo que sigue abierto) antes de
    // decir que no cabe. Si ni eso cabe, éste es el único momento en que alguien lo descubre: el día
    // que ha perdido su base. Un "ha fallado" genérico deja al dueño sin saber que la salida está
    // justo encima, en la lista de copias de este ordenador.
    const volcadoDemasiadoGrande = error?.code === "bootstrap_too_large";

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
                            {trasladoPendiente
                                ? "La licencia se ha pasado a este ordenador desde otro equipo. Los datos que tenga este ordenador son de antes, así que hay que traer los actuales de la nube. Lo que hubiera aquí se guarda aparte, sin borrarlo."
                                : "Puedes usar una copia diaria de este ordenador o descargar el estado actual de la nube. Después se comprobarán ambos lados antes de permitir trabajar de nuevo."}
                        </p>
                        {/* Se dice ANTES de elegir, no al fallar: con una copia local la gente da
                            por hecho que no hace falta red, y la comprobación contra la nube (que
                            es lo que desbloquea el login) sí la necesita. */}
                        <p className="mt-4 rounded-xl border border-border bg-surface px-4 py-3 text-sm text-fg">
                            {trasladoPendiente
                                ? "Hace falta conexión a internet para traer los datos."
                                : "Hace falta conexión a internet para completar la recuperación, también si eliges una copia de este ordenador."}
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
                                            Este ordenador y la nube ya tienen los mismos datos.
                                            Puedes iniciar sesión con tu PIN habitual; si la
                                            licencia es nueva, antes elegirás uno.
                                        </p>
                                    </div>
                                </div>

                {/* Aquí hubo un aviso de que el DNI, el IBAN y el nº de la Seguridad Social del
                    personal no volvían de la nube. Era falso: se cifran ANTES de construir la
                    sentencia, así que el outbox replica el texto cifrado, el volcado lo devuelve
                    (`SELECT *`, sin filtrar) y la DEK sigue estando (keyring local y, si el equipo
                    es nuevo, reentregada al activar la licencia). Pedía rellenar a mano datos que
                    ya estaban. No lo vuelvas a añadir sin cambiar antes la replicación. */}

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

                                {!trasladoPendiente && (
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
                                            backups.map((backup, index) => {
                                                const edad = antiguedadCopia(backup.created_at_ms, ahora);
                                                return (
                                                    <div key={backup.id} className="grid gap-1">
                                                        <Button
                                                            variant="secondary"
                                                            disabled={operacion !== null}
                                                            onClick={() =>
                                                                void ejecutar("local", () => commands.recoveryRestoreBackup(backup.id))
                                                            }
                                                        >
                                                            <HardDriveDownload className="size-4" aria-hidden />
                                                            {backup.importada
                                                                ? "Copia importada"
                                                                : index === 0
                                                                  ? "Última copia"
                                                                  : "Copia"}
                                                            : {fechaCopia(backup.created_at_ms)} ({edad.texto})
                                                        </Button>
                                                        {edad.vieja && (
                                                            <p className="flex gap-2 px-1 text-xs text-fg-muted">
                                                                <AlertTriangle className="size-4 shrink-0 text-warning" aria-hidden />
                                                                <span>
                                                                    Tiene más de {DIAS_QUE_GUARDA_LA_NUBE} días: puede que la nube
                                                                    ya no guarde todo lo que pasó después. Si es así, la
                                                                    recuperación no terminará con esta copia y habrá que
                                                                    recuperar el estado actual de la nube.
                                                                </span>
                                                            </p>
                                                        )}
                                                    </div>
                                                );
                                            })
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
                                )}

                                <div className={trasladoPendiente ? "" : "border-t border-border pt-5"}>
                                    <Button
                                        disabled={operacion !== null}
                                        onClick={() => void ejecutar("cloud", commands.syncBootstrapDesdeNube)}
                                    >
                                        <CloudDownload className="size-4" aria-hidden />
                                        Recuperar el estado actual de la nube
                                    </Button>
                                </div>

                                {error && (
                                    <div className="grid gap-3 rounded-2xl border border-danger bg-danger-soft px-4 py-3 text-sm">
                                        <div className="flex gap-3">
                                            <AlertTriangle className="size-5 shrink-0 text-danger" aria-hidden />
                                            <span>
                                                {volcadoDemasiadoGrande
                                                    ? trasladoPendiente
                                                        ? "No se pueden traer los datos de la nube: lo imprescindible para volver a trabajar (la carta, el personal, los clientes, las reservas y lo que sigue abierto) ocupa más de lo que se puede descargar de una vez. Contacta con soporte."
                                                        : "No se pueden traer los datos de la nube: lo imprescindible para volver a trabajar (la carta, el personal, los clientes, las reservas y lo que sigue abierto) ocupa más de lo que se puede descargar de una vez. Restaura una copia de este ordenador (arriba) y después se completará sola con lo que falte; si no tienes ninguna, contacta con soporte."
                                                    : error.message}
                                            </span>
                                        </div>
                                        {puedeCrearVacia && (
                                            <Button
                                                variant="secondary"
                                                onClick={() => void ejecutar("empty", commands.syncInicializarTenantVacio)}
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
