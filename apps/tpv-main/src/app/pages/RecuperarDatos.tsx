import { useState } from "react";
import {
    AlertTriangle,
    CheckCircle2,
    CloudDownload,
    DatabaseBackup,
    Loader2,
    ShieldAlert,
} from "lucide-react";
import { recuperarDesdeNube, type BootstrapResultado } from "../../features/login/loginApi";
import { Badge, Button, Card } from "../../shared/ui";
import Titlebar from "../layoutComponent/Titlebar";

/**
 * Recuperar la BD local desde la nube.
 *
 * Se llega aqui cuando `setup_pendiente` responde `requiere_recuperacion`: este equipo tiene
 * licencia activada pero su `data.db` no tiene ni un usuario. En una instalacion nueva eso es
 * imposible (el arranque siembra el admin), asi que la BD se ha perdido —borrada, corrupta,
 * restaurada a medias— y lo que hace falta NO es elegir un PIN nuevo.
 *
 * Esa distincion es el motivo de esta pantalla. Sembrar un admin aqui fabricaria una credencial
 * con el PIN publico del seed y, al completar el setup, la replicaria a la nube pisando la del
 * admin de verdad: perder la BD local pasaria a dejar sin entrar tambien a las Handy.
 */
export default function RecuperarDatos({ onRecuperado }: { onRecuperado?: () => void }) {
    const [estado, setEstado] = useState<"listo" | "trabajando" | "hecho">("listo");
    const [error, setError] = useState<string | null>(null);
    const [resultado, setResultado] = useState<BootstrapResultado | null>(null);

    const recuperar = async () => {
        setEstado("trabajando");
        setError(null);
        try {
            const r = await recuperarDesdeNube();
            setResultado(r);
            setEstado("hecho");
        } catch (e: any) {
            setError(
                typeof e === "string" ? e : e?.message ? String(e.message) : "No se pudo recuperar",
            );
            setEstado("listo");
        }
    };

    return (
        <div className="flex h-full min-h-0 w-full flex-col overflow-hidden bg-bg text-fg">
            <Titlebar />

            <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-y-auto p-4 sm:p-6 lg:p-10">
                <div
                    className="pointer-events-none absolute -left-24 -top-24 size-80 rounded-full bg-accent-soft blur-3xl"
                    aria-hidden
                />
                <div
                    className="pointer-events-none absolute -bottom-32 -right-16 size-96 rounded-full bg-accent-soft opacity-70 blur-3xl"
                    aria-hidden
                />

                <Card
                    padded={false}
                    className="relative w-full max-w-2xl overflow-hidden rounded-3xl shadow-xl"
                >
                    <section className="border-b border-border bg-surface-2 p-6 sm:p-8">
                        <div className="flex items-center justify-between gap-3">
                            <div className="grid size-14 place-items-center rounded-2xl bg-accent-soft text-accent">
                                <DatabaseBackup className="size-7" aria-hidden />
                            </div>
                            <Badge tone="accent">Recuperación</Badge>
                        </div>

                        <h1 className="mt-6 text-2xl font-bold tracking-tight text-fg sm:text-3xl">
                            Faltan los datos de este TPV
                        </h1>
                        <p className="mt-3 text-sm leading-relaxed text-fg-muted sm:text-base">
                            La licencia de este equipo está activa, pero su base de datos local está
                            vacía. No es una instalación nueva: los datos siguen en la nube y se
                            pueden traer de vuelta.
                        </p>
                    </section>

                    <section className="p-6 sm:p-8">
                        {estado === "hecho" && resultado ? (
                            <div className="grid gap-5">
                                <div className="flex gap-3 rounded-2xl border border-border bg-surface px-4 py-3">
                                    <CheckCircle2 className="size-5 shrink-0 text-success" aria-hidden />
                                    <div className="text-sm">
                                        <p className="font-semibold text-fg">Datos restaurados</p>
                                        <p className="mt-0.5 text-fg-muted">
                                            {resultado.filas_restauradas.toLocaleString("es-ES")}{" "}
                                            registros en {resultado.tablas_restauradas.length} tablas.
                                            Ya puedes iniciar sesión con tu PIN de siempre.
                                        </p>
                                    </div>
                                </div>

                                {/* El unico dato que la nube no puede devolver, dicho antes de que
                                    alguien lo descubra por su cuenta al abrir una ficha. */}
                                <div className="flex gap-3 rounded-2xl border border-border bg-surface px-4 py-3">
                                    <ShieldAlert className="size-5 shrink-0 text-warning" aria-hidden />
                                    <div className="text-sm">
                                        <p className="font-semibold text-fg">
                                            Revisa las fichas del personal
                                        </p>
                                        <p className="mt-0.5 text-fg-muted">
                                            El DNI, el IBAN y el número de la Seguridad Social se
                                            guardan cifrados y nunca salen de este equipo, así que la
                                            nube no los tenía. Habrá que volver a escribirlos.
                                        </p>
                                    </div>
                                </div>

                                {resultado.tablas_desconocidas.length > 0 && (
                                    <div className="flex gap-3 rounded-2xl border border-border bg-surface px-4 py-3">
                                        <AlertTriangle className="size-5 shrink-0 text-warning" aria-hidden />
                                        <div className="text-sm">
                                            <p className="font-semibold text-fg">
                                                Algunas tablas no se han restaurado
                                            </p>
                                            <p className="mt-0.5 text-fg-muted">
                                                Esta versión del TPV no las conoce:{" "}
                                                {resultado.tablas_desconocidas.join(", ")}. Actualiza
                                                la aplicación y vuelve a recuperar.
                                            </p>
                                        </div>
                                    </div>
                                )}

                                <Button onClick={() => onRecuperado?.()}>
                                    Ir al inicio de sesión
                                </Button>
                            </div>
                        ) : (
                            <div className="grid gap-5">
                                <div className="flex gap-3 rounded-2xl border border-border bg-surface px-4 py-3 text-sm text-fg-muted">
                                    <CloudDownload className="size-5 shrink-0 text-accent" aria-hidden />
                                    <span>
                                        Se descargará el estado actual del negocio (productos, mesas,
                                        clientes, personal y el histórico de ventas) y se reconstruirá
                                        la base de datos de este equipo. Puede tardar un rato; no
                                        cierres la aplicación.
                                    </span>
                                </div>

                                {error && (
                                    <div className="flex gap-3 rounded-2xl border border-danger bg-danger-soft px-4 py-3 text-sm">
                                        <AlertTriangle className="size-5 shrink-0 text-danger" aria-hidden />
                                        <span className="text-fg">{error}</span>
                                    </div>
                                )}

                                <Button onClick={recuperar} disabled={estado === "trabajando"}>
                                    {estado === "trabajando" ? (
                                        <>
                                            <Loader2 className="size-4 animate-spin" aria-hidden />
                                            Recuperando…
                                        </>
                                    ) : (
                                        "Recuperar mis datos"
                                    )}
                                </Button>

                                <p className="text-center text-xs text-fg-muted">
                                    Hace falta conexión a internet.
                                </p>
                            </div>
                        )}
                    </section>
                </Card>
            </div>
        </div>
    );
}
