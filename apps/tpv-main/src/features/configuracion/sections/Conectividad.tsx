import { commands } from "@tpv/client";
// src/features/configuracion/sections/Conectividad.tsx
import React from "react";

import { save } from "@tauri-apps/plugin-dialog";
import { toAppError } from "@tpv/client";
import type { JobStatus, LocalBackupInfo, SyncHealth } from "@tpv/contracts";

import { useToast } from "../../../shared/toast";
import { GhostButton, PrimaryButton } from "../ui/Buttons";
import { Panel } from "../ui/Panel";
import { cn } from "../utils";
import {
	useEstadoSync,
	type EstadoSync,
} from "../../../shared/stores/useEstadoSync";
import { useMode } from "../../../shared/stores/useMode";
import { useBackfillHistorico } from "../../../shared/lib/backfillQueries";
import { AvisoInterruptores } from "./AvisoInterruptores";
import { ImagenesPendientes } from "./ImagenesPendientes";

/**
 * SYNC-17: cómo se cuenta cada estado. Ya no hay nada que elegir aquí —la Main se conecta sola—,
 * así que este panel es informativo: dice qué está pasando y, cuando algo no va, qué significa.
 *
 * `tono` decide el color: `ok` verde, `neutro` gris (no pasa nada malo, simplemente no aplica),
 * `aviso` ámbar (transitorio, se está resolviendo) y `malo` rojo (no se va a arreglar solo).
 */
const ESTADO_TEXTO: Record<
	EstadoSync,
	{ titulo: string; desc: string; tono: "ok" | "neutro" | "aviso" | "malo" }
> = {
	conectado: {
		titulo: "Al día",
		desc: "Los cambios se guardan en la nube y los dispositivos Handy pueden trabajar.",
		tono: "ok",
	},
	conectando: {
		titulo: "Conectando…",
		desc: "Estableciendo la conexión con la nube.",
		tono: "aviso",
	},
	reintentando: {
		titulo: "Sin conexión",
		desc: "Este TPV sigue funcionando con normalidad y guarda todo lo que hagas; se subirá solo en cuanto vuelva la conexión. Los Handy no pueden trabajar mientras tanto.",
		tono: "aviso",
	},
	sin_identidad: {
		titulo: "Sin licencia activada",
		desc: "Todavía no hay una licencia activada en este dispositivo, así que no hay nada a lo que conectarse.",
		tono: "neutro",
	},
	rechazado: {
		titulo: "La nube ha rechazado la conexión",
		desc: "El servidor no acepta este dispositivo: normalmente es la licencia (caducada o anulada) o que la licencia se ha trasladado a otro equipo. Revisa la licencia; esto no se arregla solo.",
		tono: "malo",
	},
	pausada: {
		titulo: "Sincronización desactivada",
		desc: "Este dispositivo tiene la sincronización apagada a propósito. Todo se sigue guardando en local y se subirá si se vuelve a activar.",
		tono: "neutro",
	},
};

function desdeHace(ms: number): string {
	const d = Date.now() - ms;
	if (d < 60_000) return "hace un momento";
	const min = Math.floor(d / 60_000);
	if (min < 60) return `desde hace ${min} min`;
	const h = Math.floor(min / 60);
	if (h < 24) return `desde hace ${h} h`;
	return `desde hace ${Math.floor(h / 24)} d`;
}

// Estado real de la conexión. Sustituye al antiguo selector "offline/online": el usuario ya no
// decide si quiere conexión (una pregunta que no puede responder bien y cuya respuesta se queda
// vieja), solo ve la que hay.
function EstadoConexion({ darkMode }: { darkMode: boolean }) {
	const estado = useEstadoSync((s) => s.estado);
	const detalle = useEstadoSync((s) => s.detalle);
	const desde = useEstadoSync((s) => s.desde);

	// Repintado periódico: lo único que cambia solo es el "desde hace X".
	const [, setTick] = React.useState(0);
	React.useEffect(() => {
		const id = window.setInterval(() => setTick((t) => t + 1), 30_000);
		return () => window.clearInterval(id);
	}, []);

	const info = ESTADO_TEXTO[estado];
	const color =
		info.tono === "ok"
			? "bg-success"
			: info.tono === "aviso"
				? "bg-warning"
				: info.tono === "malo"
					? "bg-danger"
					: "bg-fg-muted";

	return (
		<Panel
			title="Conexión con la nube"
			subtitle="Este TPV se conecta solo. Aquí ves el estado real, no un ajuste."
		>
			<div
				className={cn(
					"rounded-2xl border p-4",
					info.tono === "malo"
						? "border-danger/40 bg-danger/10"
						: darkMode
							? "border-border bg-surface-2"
							: "border-border bg-surface",
				)}
			>
				<div className="flex items-center gap-2">
					<span className={cn("size-2.5 shrink-0 rounded-full", color)} />
					<div
						className={cn(
							"text-sm font-semibold",
							darkMode ? "text-white" : "text-fg",
						)}
					>
						{info.titulo}
					</div>
					<div className="text-[11px] text-fg-muted">{desdeHace(desde)}</div>
				</div>

				<div className="mt-2 text-xs text-fg-muted">{info.desc}</div>

				{detalle && estado !== "conectado" && (
					<div className="mt-2 text-[11px] text-fg-muted">Detalle: {detalle}</div>
				)}
			</div>
		</Panel>
	);
}

// SYNC-14: tarjeta de un indicador de salud (una cifra + etiqueta; en ámbar si algo requiere ojo).
function HealthStat({
	label,
	value,
	warn,
	darkMode,
}: {
	label: string;
	value: number;
	warn?: boolean;
	darkMode: boolean;
}) {
	return (
		<div
			className={cn(
				"rounded-xl border p-3",
				warn
					? "border-warning/40 bg-warning/10"
					: darkMode
						? "border-border bg-surface-2"
						: "border-border bg-surface",
			)}
		>
			<div
				className={cn(
					"text-lg font-semibold tabular-nums",
					warn ? "text-warning" : darkMode ? "text-white" : "text-fg",
				)}
			>
				{value}
			</div>
			<div className="text-[11px] text-fg-muted mt-0.5">{label}</div>
		</div>
	);
}

// SYNC-14: panel de salud de la sincronización (profundidad de outbox, checkpoint y ops en
// cuarentena/fallando). Hace un fallo de convergencia VISIBLE en vez de invisible.
function SaludSync({ darkMode }: { darkMode: boolean }) {
	const [health, setHealth] = React.useState<SyncHealth | null>(null);
	const [err, setErr] = React.useState<string | null>(null);

	React.useEffect(() => {
		let cancelled = false;
		const tick = async () => {
			try {
				const h = await commands.syncHealth();
				if (!cancelled) {
					setHealth(h);
					setErr(null);
				}
			} catch (e) {
				if (!cancelled) setErr(String((e as any)?.message ?? e ?? ""));
			}
		};
		void tick();
		const timer = window.setInterval(() => void tick(), 5000);
		return () => {
			cancelled = true;
			clearInterval(timer);
		};
	}, []);

	return (
		<Panel
			title="Salud de la sincronización"
			subtitle="Estado de la cola de subida y del catch-up con la nube."
		>
			{err && (
				<div className="rounded-xl border border-danger/40 bg-danger/10 p-3 text-xs text-danger">
					No se pudo leer el estado de sincronización: {err}
				</div>
			)}

			{health && (
				<div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
					<HealthStat
						label="Pendientes de subir"
						value={health.outbox_pending}
						warn={health.outbox_pending > 100}
						darkMode={darkMode}
					/>
					<HealthStat
						label="Último cambio (seq)"
						value={health.last_seq}
						darkMode={darkMode}
					/>
					<HealthStat
						label="Reintentándose"
						value={health.failing}
						warn={health.failing > 0}
						darkMode={darkMode}
					/>
					<HealthStat
						label="En cuarentena"
						value={health.quarantined}
						warn={health.quarantined > 0}
						darkMode={darkMode}
					/>
				</div>
			)}

			{health && health.quarantined > 0 && (
				<div className="mt-3 rounded-xl border border-warning/40 bg-warning/10 p-3 text-xs text-warning">
					Hay {health.quarantined} operación(es) que no se pudieron aplicar tras varios
					intentos y se han saltado para no bloquear la sincronización del resto. Los datos de
					este dispositivo pueden diferir en esos registros; contacta con soporte.
				</div>
			)}

			{/*
			  SYNC-20 · el mismo aviso para la dirección contraria, que hasta ahora no tenía ninguno.
			  Se dice la CONSECUENCIA y no la causa: el `op_id` y el error de SQL no los puede usar
			  quien está delante del TPV, y lo que sí necesita saber es que hay algo suyo que la nube
			  no tiene — o sea, que una recuperación no lo devolvería. Quien puede arreglarlo se
			  entera por Sentry, sin que aquí nadie tenga que mirar nada (ver `useMainSocket`).
			*/}
			{health && health.subida_en_cuarentena > 0 && (
				<div className="mt-3 rounded-xl border border-danger/40 bg-danger/10 p-3 text-xs text-danger">
					Hay {health.subida_en_cuarentena} cambio(s) de este equipo que la nube ha rechazado y
					que ya no se van a subir. El resto sigue copiándose con normalidad, pero esos datos
					solo están aquí: si perdieras este equipo hoy, no volverían. Ya se ha avisado
					automáticamente; contacta con soporte.
				</div>
			)}
		</Panel>
	);
}

/** Nombre legible de cada job (el `nombre` que llega de Rust es el identificador estable). */
const JOB_ETIQUETA: Record<string, string> = {
	licencia: "Comprobación de licencia",
	avisos: "Avisos de tareas y reservas",
	updater: "Búsqueda de actualizaciones",
	imagenes: "Subida de imágenes pendientes",
	purga_sync: "Limpieza de registros de sincronización",
	backup_local: "Copia de seguridad diaria",
	reconciliacion: "Reconciliación con la nube",
	cifrado_pii: "Cifrado de los datos del personal",
	caja_sin_cerrar: "Aviso de caja sin cerrar",
	stock_negativo: "Aviso de stock negativo",
	fichajes_colgados: "Cierre de jornadas sin fichar la salida",
	backfill_historico: "Descarga del histórico pendiente",
	interruptores: "Pausas de emergencia de soporte",
	verificar_nube: "Contraste con la nube",
};

function cadaTexto(secs: number): string {
	if (secs % 3600 === 0) return `cada ${secs / 3600} h`;
	if (secs % 60 === 0) return `cada ${secs / 60} min`;
	return `cada ${secs} s`;
}

function haceCuanto(ms: number | null): string {
	if (ms == null) return "nunca";
	const d = Date.now() - ms;
	if (d < 60_000) return "hace un momento";
	const min = Math.floor(d / 60_000);
	if (min < 60) return `hace ${min} min`;
	const h = Math.floor(min / 60);
	if (h < 24) return `hace ${h} h`;
	return `hace ${Math.floor(h / 24)} d`;
}

function tamanoTexto(bytes: number): string {
	if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
	return `${bytes} B`;
}

function fechaCopia(ms: number): string {
	return new Intl.DateTimeFormat("es-ES", {
		dateStyle: "medium",
		timeStyle: "short",
	}).format(new Date(ms));
}

/**
 * Las copias existían pero no se veían por ningún sitio hasta que hacían falta, o sea hasta la
 * pantalla de recuperación: no había forma de comprobar que se estuvieran haciendo, ni de forzar
 * una antes de algo delicado, ni de sacar una del equipo.
 *
 * Aquí NO se restaura: eso sigue viviendo sólo en la pantalla de recuperación, que es la única que
 * garantiza que nadie está vendiendo mientras se reemplaza la base.
 */
function CopiasSeguridad({ darkMode }: { darkMode: boolean }) {
	const toast = useToast();
	const [copias, setCopias] = React.useState<LocalBackupInfo[] | null>(null);
	const [err, setErr] = React.useState<string | null>(null);
	const [ocupado, setOcupado] = React.useState(false);

	const recargar = React.useCallback(async () => {
		try {
			setCopias(await commands.recoveryListBackups());
			setErr(null);
		} catch (e) {
			setErr(toAppError(e).message);
		}
	}, []);

	React.useEffect(() => {
		void recargar();
	}, [recargar]);

	async function crear() {
		setOcupado(true);
		try {
			const copia = await commands.recoveryCreateBackup();
			toast.success("Copia creada", fechaCopia(copia.created_at_ms));
			await recargar();
		} catch (e) {
			toast.error("Copia de seguridad", toAppError(e).message);
		} finally {
			setOcupado(false);
		}
	}

	async function guardarFuera(copia: LocalBackupInfo) {
		setOcupado(true);
		try {
			const destino = await save({
				title: "Guardar la copia fuera de este equipo",
				defaultPath: copia.id,
				// Sale tal como está guardada: comprimida (`.db.gz`), salvo una de antes de RI-41.
				filters: [
					{ name: "Copia de seguridad", extensions: [copia.id.endsWith(".gz") ? "gz" : "db"] },
				],
			});
			if (!destino) return;
			await commands.recoveryExportBackup(copia.id, destino);
			toast.success("Copia guardada", "Ya tienes un respaldo fuera de este ordenador.");
		} catch (e) {
			toast.error("No se pudo guardar la copia", toAppError(e).message);
		} finally {
			setOcupado(false);
		}
	}

	return (
		<Panel
			title="Copias de seguridad"
			subtitle="Copias completas de este ordenador. Se hace una al día y se conservan las siete últimas."
			right={
				<PrimaryButton onClick={() => void crear()} disabled={ocupado}>
					Crear copia ahora
				</PrimaryButton>
			}
		>
			<div className="flex flex-col gap-3">
				<div className="rounded-xl border border-warning/40 bg-warning/10 p-3 text-xs text-fg">
					Estas copias viven en el mismo disco que protegen: cubren un borrado o una
					corrupción, no una avería del disco ni un robo. Guarda una fuera del equipo
					de vez en cuando.
				</div>

				{err && (
					<div className="rounded-xl border border-danger/40 bg-danger/10 p-3 text-xs text-danger">
						No se pudo leer la lista de copias: {err}
					</div>
				)}

				{copias && copias.length === 0 && (
					<div className="rounded-xl border border-border bg-surface-2 p-3 text-xs text-fg-muted">
						Todavía no hay ninguna copia. La primera se hace sola a los pocos minutos de
						arrancar; si acabas de instalar, dale a «Crear copia ahora».
					</div>
				)}

				{copias && copias.length > 0 && (
					<div className="flex flex-col gap-2">
						{copias.map((c) => (
							<div
								key={c.id}
								className={cn(
									"flex items-center justify-between gap-3 rounded-xl border border-border p-3",
									darkMode ? "bg-surface-2" : "bg-surface",
								)}
							>
								<div className="min-w-0">
									<div
										className={cn(
											"truncate text-sm font-semibold",
											darkMode ? "text-white" : "text-fg",
										)}
									>
										{fechaCopia(c.created_at_ms)}
									</div>
									<div className="text-[11px] tabular-nums text-fg-muted">
										{tamanoTexto(c.size_bytes)}
										{c.importada ? " · importada de otro soporte" : ""}
									</div>
								</div>
								<GhostButton onClick={() => void guardarFuera(c)} disabled={ocupado}>
									Guardar fuera…
								</GhostButton>
							</div>
						))}
					</div>
				)}

				<p className="text-[11px] text-fg-muted">
					Para restaurar una copia hay que reiniciar la aplicación: la pantalla de
					recuperación es el único sitio desde el que se hace, porque reemplazar la base
					mientras se está vendiendo perdería lo que aún no se haya subido.
				</p>
			</div>
		</Panel>
	);
}

// Panel de diagnóstico del runner de jobs: hace visible una tarea de fondo que lleva tiempo
// fallando (licencia sin verificar, feed caído…) en vez de dejarla enterrada en los logs.
function TareasFondo({ darkMode }: { darkMode: boolean }) {
	const [jobs, setJobs] = React.useState<JobStatus[] | null>(null);
	const [err, setErr] = React.useState<string | null>(null);

	React.useEffect(() => {
		let cancelled = false;
		const tick = async () => {
			try {
				const j = await commands.jobsStatus();
				if (!cancelled) {
					setJobs(j);
					setErr(null);
				}
			} catch (e) {
				if (!cancelled) setErr(String((e as any)?.message ?? e ?? ""));
			}
		};
		void tick();
		// Los jobs se mueven despacio (minutos u horas): no hace falta refrescar más a menudo.
		const timer = window.setInterval(() => void tick(), 30000);
		return () => {
			cancelled = true;
			clearInterval(timer);
		};
	}, []);

	return (
		<Panel
			title="Tareas en segundo plano"
			subtitle="Comprobaciones periódicas que la app hace por su cuenta."
		>
			{err && (
				<div className="rounded-xl border border-danger/40 bg-danger/10 p-3 text-xs text-danger">
					No se pudo leer el estado de las tareas: {err}
				</div>
			)}

			{jobs && jobs.length > 0 && (
				<div className="flex flex-col gap-2">
					{jobs.map((j) => {
						const fallando = j.fallos > 0;
						return (
							<div
								key={j.nombre}
								className={cn(
									"rounded-xl border p-3",
									fallando
										? "border-warning/40 bg-warning/10"
										: darkMode
											? "border-border bg-surface-2"
											: "border-border bg-surface",
								)}
							>
								<div className="flex items-center justify-between gap-3">
									<div
										className={cn(
											"text-sm font-semibold",
											darkMode ? "text-white" : "text-fg",
										)}
									>
										{JOB_ETIQUETA[j.nombre] ?? j.nombre}
									</div>
									<div
										className={cn(
											"text-[11px] tabular-nums",
											fallando ? "text-warning" : "text-fg-muted",
										)}
									>
										{cadaTexto(j.cada_secs)} · última {haceCuanto(j.last_ok_ms)}
									</div>
								</div>

								{fallando && (
									<div className="mt-2 text-[11px] text-warning">
										{j.fallos} intento(s) fallido(s) seguidos
										{j.last_error ? `: ${j.last_error}` : ""}. Se sigue
										reintentando cada vez más espaciado.
									</div>
								)}
							</div>
						);
					})}
				</div>
			)}
		</Panel>
	);
}

/**
 * SYNC-19 · Progreso de la fase 2 de una recuperación.
 *
 * Sólo aparece cuando de verdad hay histórico bajando. En un equipo que nunca ha perdido su base
 * este panel no existe, y ese es el punto: no es un indicador permanente, es la explicación de por
 * qué durante unas horas los totales de rango largo van creciendo.
 */
function HistoricoPendiente({ darkMode }: { darkMode: boolean }) {
	const { data } = useBackfillHistorico();
	if (!data || data.tablas_pendientes === 0) return null;

	const total = data.tablas_pendientes + data.tablas_completadas;
	const pct = total > 0 ? Math.round((data.tablas_completadas / total) * 100) : 0;

	return (
		<Panel
			title="Descargando el histórico"
			subtitle="Se está completando lo que no cabía en la recuperación. Puedes seguir trabajando."
		>
			<div className="grid gap-3">
				<div className="h-2 w-full overflow-hidden rounded-full bg-surface-2">
					<div
						className="h-full rounded-full bg-accent transition-[width] duration-500"
						style={{ width: `${pct}%` }}
					/>
				</div>
				<div
					className={cn(
						"flex flex-wrap items-center justify-between gap-2 text-xs",
						darkMode ? "text-fg-muted" : "text-fg-muted",
					)}
				>
					<span>
						{data.tablas_completadas} de {total} apartados · {pct} %
					</span>
					<span className="tabular-nums">
						{data.filas_traidas.toLocaleString("es-ES")} registros traídos
						{data.tabla_actual ? ` · ahora: ${data.tabla_actual}` : ""}
					</span>
				</div>

				{/* Se dice para que un histórico que tarda no se confunda con uno que no avanza. El
				    job reintenta solo, con espera creciente, así que no hay nada que pulsar. */}
				{data.ultimo_error && (
					<div className="rounded-xl border border-warning/40 bg-warning/10 p-3 text-[11px] text-warning">
						El último intento falló ({data.ultimo_error}). Se reintenta solo en cuanto
						vuelva la conexión.
					</div>
				)}
			</div>
		</Panel>
	);
}

export function Conectividad({ darkMode }: { darkMode: boolean }) {
	const deviceMode = useMode((s) => s.mode);

	return (
		<div className="flex flex-col gap-4">
			<ImagenesPendientes />
			{/* SYNC-17: estado real de la conexión (antes aquí vivía el selector offline/online). */}
			{deviceMode === "tpv" && <EstadoConexion darkMode={darkMode} />}

			{/* PROD-06: lo que soporte ha pausado desde la nube. Sólo se pinta si hay algo. */}
			{deviceMode === "tpv" && <AvisoInterruptores />}

			{/* SYNC-14: salud de la sincronización. Se muestra siempre en la Main: la cola de subida
			    importa sobre todo cuando NO hay conexión, que es justo cuando antes se ocultaba. */}
			{deviceMode === "tpv" && <SaludSync darkMode={darkMode} />}

			{/* SYNC-19: sólo se pinta si hay una recuperación completándose de fondo. */}
			{deviceMode === "tpv" && <HistoricoPendiente darkMode={darkMode} />}

			{/* Runner de jobs: corre haya conexión o no (licencia con gracia, avisos), así que solo
			    depende de que esta sea la Main. */}
			{deviceMode === "tpv" && <TareasFondo darkMode={darkMode} />}

			{/* Las copias locales: visibles y accionables ANTES de que hagan falta, que es lo
			    único que distingue un respaldo de una carpeta con ficheros dentro. */}
			{deviceMode === "tpv" && <CopiasSeguridad darkMode={darkMode} />}
		</div>
	);
}
