import { commands, toAppError } from "@tpv/client";
// src/features/configuracion/sections/Conectividad.tsx
import React from "react";

import type { JobStatus, SyncHealth } from "@tpv/contracts";

import { Button } from "../../../shared/ui";
import { useToast } from "../../../shared/toast";
import { useAuth } from "../../../shared/stores/useAuth";

import { Panel } from "../ui/Panel";
import { cn } from "../utils";
import { useEstadoSync } from "../../../shared/stores/useEstadoSync";
import { avisosDeSubida, textoDeConexion } from "./textoConexion";
import { useMode } from "../../../shared/stores/useMode";
import { useBackfillHistorico } from "../../../shared/lib/backfillQueries";
import { useSubidaNube } from "../../../shared/lib/subidaNubeQueries";
import { AvisoInterruptores } from "./AvisoInterruptores";
import { ImagenesPendientes } from "./ImagenesPendientes";
import { CORREO_SOPORTE } from "../../../shared/lib/soporte";
import { BotonDiagnostico } from "../../../shared/ui/BotonDiagnostico";

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
function EstadoConexion({ darkMode, porSubir }: { darkMode: boolean; porSubir: number | null }) {
	const estado = useEstadoSync((s) => s.estado);
	const detalle = useEstadoSync((s) => s.detalle);
	const desde = useEstadoSync((s) => s.desde);
	const handyRetenidas = useEstadoSync((s) => s.handyRetenidas);
	// DO-SUBIDA: con la nube restaurada, lo que dice la conexión mientras los Handy esperan.
	const { data: subida } = useSubidaNube();

	// Repintado periódico: lo único que cambia solo es el "desde hace X".
	const [, setTick] = React.useState(0);
	React.useEffect(() => {
		const id = window.setInterval(() => setTick((t) => t + 1), 30_000);
		return () => window.clearInterval(id);
	}, []);

	const info = textoDeConexion(estado, porSubir, handyRetenidas, subida ?? null);
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

/**
 * SYNC-14: la salud de la sincronización, releída cada 5 s. La leen el panel de salud y el estado
 * de la conexión (lo que queda por subir).
 */
function useSaludSync(activa: boolean): { health: SyncHealth | null; err: string | null } {
	const [health, setHealth] = React.useState<SyncHealth | null>(null);
	const [err, setErr] = React.useState<string | null>(null);

	React.useEffect(() => {
		if (!activa) return;
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
	}, [activa]);

	return { health, err };
}

// SYNC-14: panel de salud de la sincronización (profundidad de outbox, checkpoint y ops en
// cuarentena/fallando). Hace un fallo de convergencia VISIBLE en vez de invisible.
export function SaludSync({ darkMode }: { darkMode: boolean }) {
	const { health, err } = useSaludSync(true);
	return <PanelSaludSync darkMode={darkMode} health={health} err={err} />;
}

function PanelSaludSync({ darkMode, health, err }: { darkMode: boolean; health: SyncHealth | null; err: string | null }) {
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
					Hay {health.quarantined} cambio(s) de la nube que no se pudieron aplicar en este TPV
					tras varios intentos y se han apartado para no frenar al resto. Los datos de este TPV
					pueden diferir en esos registros y, mientras sigan apartados, la comprobación con la nube
					no corrige nada más. Esa comprobación (tras el cierre de caja, o una vez al día) intenta
					traerlos tal como están en la nube, y une en una las fichas de cliente o de proveedor que
					se dieron de alta a la vez aquí y en una Handy con el mismo correo (o, en los proveedores,
					el mismo CIF); si son dos fichas distintas, no las une y avisa para que se resuelva a mano.
					Lo que choca con algo que este TPV todavía no ha podido subir, o que esta versión no sabe
					guardar, se queda apartado; si a la semana sigue así, aquí se ofrece traer el estado de la
					nube.
				</div>
			)}

			{/* SYNC-36: lo que lleva una semana sin poder salir solo, con la salida. */}
			{health && health.bajada_atascada > 0 && <RecuperarDeLaNube health={health} />}

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
					automáticamente; contacta con soporte en {CORREO_SOPORTE}.
					{/* OPS-02: con el diagnóstico, que lleva el estado de la réplica de este equipo. */}
					<div className="mt-2">
						<BotonDiagnostico size="sm" />
					</div>
				</div>
			)}
		</Panel>
	);
}

/**
 * SYNC-36 · Lo que la nube ha cambiado (casi siempre, desde una Handy) y lleva una semana sin
 * poder escribirse en este TPV: un cambio en cuarentena que no sale, mientras el contraste diario
 * con la nube no repara nada, o (SYNC-38) filas que había que traer de la nube y no entran, que el
 * contraste no toca. Lo arregla traer el estado actual de la nube, que sustituye la base de este TPV.
 *
 * Sólo se ofrece cuando es seguro: sin nada de este TPV por subir (ni pendiente ni rechazado por la
 * nube), que se perdería al sustituir la base; el backend lo vuelve a comprobar dentro de la misma
 * transacción que sustituye. Pide confirmación, porque mientras se trae no se puede vender. Al
 * terminar se cierra la sesión y la pantalla de recuperación enseña cómo va, como cualquier otra
 * recuperación.
 */
function RecuperarDeLaNube({ health }: { health: SyncHealth }) {
	const toast = useToast();
	const [confirmando, setConfirmando] = React.useState(false);
	const [trayendo, setTrayendo] = React.useState(false);
	const porSubir = health.outbox_pending;
	const rechazados = health.subida_en_cuarentena;

	async function traer() {
		setTrayendo(true);
		try {
			await commands.syncBootstrapDesdeNube();
		} catch (e) {
			// Se queda como estaba (la base no se ha tocado): se dice por qué y se puede reintentar.
			toast.error("No se pudo traer el estado de la nube", toAppError(e).message);
			setTrayendo(false);
			setConfirmando(false);
			return;
		}
		// La base ya es la de la nube y queda por comprobar contra ella: lo hace la pantalla de
		// recuperación, sin sesión, como tras cualquier otra recuperación.
		useEstadoSync.getState().iniciarReconciliacion();
		useAuth.getState().logout();
	}

	return (
		<div className="mt-3 grid gap-3 rounded-xl border border-danger/40 bg-danger/10 p-3 text-xs text-fg">
			<div>
				<p className="font-semibold text-danger">
					Hay cambios hechos desde las Handy que este TPV no ha podido aplicar
				</p>
				<p className="mt-1">
					Hace más de una semana que no se pueden aplicar: este TPV puede enseñar datos
					distintos de los de las Handy, y las comprobaciones diarias con la nube no lo pueden
					arreglar. Se arregla trayendo el estado actual de la nube: los datos de este TPV se
					sustituyen por los de la nube, que ya tiene esos cambios.
				</p>
			</div>

			{porSubir > 0 ? (
				<p>
					Antes tiene que subir a la nube lo que este TPV tiene pendiente ({porSubir}). Espera a
					que se sincronice y vuelve aquí.
				</p>
			) : rechazados > 0 ? (
				<div className="grid gap-2">
					<p>
						Este TPV tiene {rechazados} cambio(s) que la nube no ha aceptado y que sólo están
						aquí: traer la nube los borraría. Contacta con soporte en {CORREO_SOPORTE}.
					</p>
					{/* OPS-02 */}
					<div>
						<BotonDiagnostico size="sm" />
					</div>
				</div>
			) : confirmando ? (
				<div className="grid gap-2">
					<p>
						Durante unos minutos no se podrá vender en este TPV ni en las Handy: se cierra la
						sesión, se traen los datos de la nube y se comprueban. No se pierde nada, porque
						este TPV no tiene nada pendiente de subir. Hace falta conexión a internet.
					</p>
					<div className="flex flex-wrap gap-2">
						<Button variant="danger" disabled={trayendo} onClick={() => void traer()}>
							{trayendo ? "Trayendo los datos…" : "Sí, recuperar ahora"}
						</Button>
						<Button variant="secondary" disabled={trayendo} onClick={() => setConfirmando(false)}>
							Cancelar
						</Button>
					</div>
				</div>
			) : (
				<div>
					<Button variant="secondary" onClick={() => setConfirmando(true)}>
						Recuperar el estado actual de la nube
					</Button>
				</div>
			)}
		</div>
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
	bajada_atascada: "Aviso de cambios de la nube sin aplicar",
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

/** DO-SUBIDA · Lo que se lee de cada fase de la subida completa. */
const FASE_DE_SUBIDA: Record<string, string> = {
	empezando: "preparando",
	vivos: "lo que está abierto",
	imprescindible: "lo imprescindible",
	reciente: "los últimos días",
	historico: "el histórico",
	revisando: "revisando lo que no entró",
	contrastando: "comprobando que cuadra",
};

/**
 * DO-SUBIDA · Progreso de la subida completa de la base a una nube devuelta (una copia o una base
 * vacía). Sólo aparece mientras dura; en un equipo cuya nube nunca se ha restaurado no existe.
 */
function SubidaNube({ darkMode }: { darkMode: boolean }) {
	const { data } = useSubidaNube();
	if (!data) return null;

	const pct = data.filas_total > 0 ? Math.min(100, Math.round((data.filas_leidas / data.filas_total) * 100)) : 0;
	const fase = FASE_DE_SUBIDA[data.fase] ?? data.fase;

	return (
		<Panel
			title="Subiendo los datos a la nube"
			subtitle="La nube del negocio se ha restaurado y este TPV le está devolviendo lo que tiene. Puedes seguir trabajando."
		>
			<div className="grid gap-3">
				{data.estado === "subiendo" && (
					<div className="h-2 w-full overflow-hidden rounded-full bg-surface-2">
						<div className="h-full rounded-full bg-accent transition-[width] duration-500" style={{ width: `${pct}%` }} />
					</div>
				)}
				<div className={cn("flex flex-wrap items-center justify-between gap-2 text-xs", darkMode ? "text-fg-muted" : "text-fg-muted")}>
					<span>Ahora: {fase}</span>
					<span className="tabular-nums">
						{data.filas_leidas.toLocaleString("es-ES")} registros revisados
						{data.tablas_pendientes > 0 ? ` · quedan ${data.tablas_pendientes} apartados` : ""}
					</span>
				</div>
				{avisosDeSubida(data).map((a) =>
					a.tono === "info" ? (
						<div key={a.texto} className="text-[11px] text-fg-muted">
							{a.texto}
						</div>
					) : (
						<div key={a.texto} className="rounded-xl border border-warning/40 bg-warning/10 p-3 text-[11px] text-warning">
							{a.texto}
						</div>
					),
				)}
			</div>
		</Panel>
	);
}

export function Conectividad({ darkMode }: { darkMode: boolean }) {
	const deviceMode = useMode((s) => s.mode);
	const salud = useSaludSync(deviceMode === "tpv");

	return (
		<div className="flex flex-col gap-4">
			<ImagenesPendientes />
			{/* SYNC-17: estado real de la conexión (antes aquí vivía el selector offline/online). */}
			{deviceMode === "tpv" && <EstadoConexion darkMode={darkMode} porSubir={salud.health?.outbox_pending ?? null} />}

			{/* PROD-06: lo que soporte ha pausado desde la nube. Sólo se pinta si hay algo. */}
			{deviceMode === "tpv" && <AvisoInterruptores />}

			{/* SYNC-14: salud de la sincronización. Se muestra siempre en la Main: la cola de subida
			    importa sobre todo cuando NO hay conexión, que es justo cuando antes se ocultaba. */}
			{deviceMode === "tpv" && <PanelSaludSync darkMode={darkMode} health={salud.health} err={salud.err} />}

			{/* SYNC-19: sólo se pinta si hay una recuperación completándose de fondo. */}
			{deviceMode === "tpv" && <HistoricoPendiente darkMode={darkMode} />}
			{deviceMode === "tpv" && <SubidaNube darkMode={darkMode} />}

			{/* Runner de jobs: corre haya conexión o no (licencia con gracia, avisos), así que solo
			    depende de que esta sea la Main. */}
			{deviceMode === "tpv" && <TareasFondo darkMode={darkMode} />}
		</div>
	);
}
