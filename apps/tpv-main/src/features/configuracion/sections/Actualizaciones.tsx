import { commands } from "@tpv/client";
// src/features/configuracion/sections/Actualizaciones.tsx
//
// Sección de Configuración para ver el estado de las actualizaciones: qué versión hay instalada,
// si el feed (`tpv-api`) sirve una más nueva y, en ese caso, instalarla.
//
// La DETECCIÓN es siempre del backend: `updater_status` consulta el feed de verdad (nada cacheado)
// y, si encuentra versión nueva, la anuncia igual que el tick automático (banner + notificación).
// Por eso "Buscar actualizaciones" no es solo cosmético: deja el aviso puesto para el resto de la
// app. La INSTALACIÓN nunca es automática: la dispara el usuario cuando le conviene (p. ej. al
// cerrar caja), porque reiniciar el TPV en mitad de un servicio sería peor que esperar.

import React, { useCallback, useEffect, useState } from "react";

import { confirm as confirmDialog } from "@tauri-apps/plugin-dialog";
import { DownloadCloud, RefreshCw } from "lucide-react";

import { Panel } from "../ui/Panel";
import { Badge } from "../ui/Badge";
import { GhostButton, PrimaryButton } from "../ui/Buttons";
import { cn } from "../utils";
import { BotonDiagnostico } from "../../../shared/ui/BotonDiagnostico";
import { CORREO_SOPORTE } from "../../../shared/lib/soporte";

/** Espejo de `UpdateInfo` (src-tauri/src/lib.rs). */
type UpdateInfo = {
	version: string;
	current_version: string;
	notes: string | null;
};

/** Espejo de `UpdateStatus` (src-tauri/src/lib.rs). Nunca falla: el fallo viaja en `error`. */
type UpdateStatus = {
	current_version: string;
	supported: boolean;
	update: UpdateInfo | null;
	error: string | null;
};

function horaCorta(d: Date): string {
	return d.toLocaleTimeString(undefined, {
		hour: "2-digit",
		minute: "2-digit",
	});
}

export function Actualizaciones({ darkMode }: { darkMode: boolean }) {
	const [status, setStatus] = useState<UpdateStatus | null>(null);
	const [checking, setChecking] = useState(true);
	const [checkedAt, setCheckedAt] = useState<Date | null>(null);
	const [installing, setInstalling] = useState(false);
	const [installError, setInstallError] = useState<string | null>(null);

	const check = useCallback(async () => {
		setChecking(true);
		setInstallError(null);
		try {
			const s = await commands.updaterStatus();
			setStatus(s);
			setCheckedAt(new Date());
		} catch (e) {
			// `updater_status` no debería fallar (los errores de feed vienen dentro); si falla, se
			// trata como "no se pudo comprobar".
			setStatus({
				current_version: "",
				supported: true,
				update: null,
				error: String((e as any)?.message ?? e ?? ""),
			});
			setCheckedAt(new Date());
		} finally {
			setChecking(false);
		}
	}, []);

	// Comprobación al entrar en la sección: el usuario que abre esta pantalla quiere el dato de
	// ahora, no el de hace horas.
	useEffect(() => {
		void check();
	}, [check]);

	async function install() {
		if (!status?.update) return;
		const ok = await confirmDialog(
			`Se descargará e instalará la versión ${status.update.version} y la aplicación se reiniciará. Asegúrate de no tener ninguna venta a medias.`,
			{ title: "Actualizar ahora", kind: "warning" },
		);
		if (!ok) return;

		setInstalling(true);
		setInstallError(null);
		try {
			// Descarga + verifica firma + instala + reinicia. Si va bien, la app se reinicia sola:
			// por eso no hay estado de "éxito" que pintar aquí.
			await commands.updaterInstall();
		} catch (e) {
			setInstallError(String((e as any)?.message ?? e ?? ""));
			setInstalling(false);
		}
	}

	const update = status?.update ?? null;
	const feedError = status?.error ?? null;
	const soportado = status?.supported ?? true;

	const estado = checking
		? { tone: "default" as const, text: "Comprobando…" }
		: !soportado
			? { tone: "default" as const, text: "Gestionadas por el instalador" }
			: feedError
				? { tone: "warn" as const, text: "No se pudo comprobar" }
				: update
					? { tone: "warn" as const, text: "Actualización disponible" }
					: { tone: "good" as const, text: "Estás al día" };

	return (
		<div className="flex flex-col gap-4">
			<Panel
				title="Versión de la aplicación"
				subtitle="Estado de este dispositivo respecto a la última versión publicada."
				right={<Badge tone={estado.tone}>{estado.text}</Badge>}
			>
				<div className="flex flex-wrap items-end gap-x-8 gap-y-4">
					<div>
						<div className="text-xs font-semibold uppercase tracking-wider text-fg-muted">
							Versión instalada
						</div>
						<div
							className={cn(
								"mt-1 text-2xl font-bold tabular-nums",
								darkMode ? "text-white" : "text-fg",
							)}
						>
							{status?.current_version || "—"}
						</div>
					</div>

					{update ? (
						<div>
							<div className="text-xs font-semibold uppercase tracking-wider text-fg-muted">
								Última publicada
							</div>
							<div className="mt-1 text-2xl font-bold tabular-nums text-accent">
								{update.version}
							</div>
						</div>
					) : null}

					<div>
						<div className="text-xs font-semibold uppercase tracking-wider text-fg-muted">
							Última comprobación
						</div>
						<div className="mt-1 text-sm text-fg-muted">
							{checking
								? "En curso…"
								: checkedAt
									? `Hoy a las ${horaCorta(checkedAt)}`
									: "—"}
						</div>
					</div>
				</div>

				{feedError && soportado ? (
					<div className="mt-4 rounded-xl border border-warning/40 bg-warning/10 p-3 text-xs text-warning">
						No se pudo contactar con el servidor de actualizaciones. Suele ser falta de
						internet: la aplicación sigue funcionando con normalidad y se reintenta
						automáticamente. Detalle: {feedError}
					</div>
				) : null}

				{!soportado ? (
					<div className="mt-4 rounded-xl border border-border bg-surface-2 p-3 text-xs text-fg-muted">
						Este dispositivo no usa el actualizador automático: se actualiza instalando
						la aplicación de nuevo.
					</div>
				) : null}

				{soportado ? (
					<div className="mt-5 flex flex-wrap items-center gap-2">
						<GhostButton onClick={() => void check()} disabled={checking || installing}>
							<span className="inline-flex items-center gap-2">
								<RefreshCw
									className={cn("size-4", checking && "animate-spin")}
									aria-hidden
								/>
								{checking ? "Comprobando…" : "Buscar actualizaciones"}
							</span>
						</GhostButton>

						{update ? (
							<PrimaryButton onClick={() => void install()} disabled={installing}>
								<span className="inline-flex items-center gap-2">
									<DownloadCloud className="size-4" aria-hidden />
									{installing ? "Actualizando…" : "Actualizar y reiniciar"}
								</span>
							</PrimaryButton>
						) : null}
					</div>
				) : null}

				{installError ? (
					<div className="mt-3 rounded-xl border border-danger/40 bg-danger/10 p-3 text-xs text-danger">
						No se pudo instalar la actualización: {installError}
					</div>
				) : null}
			</Panel>

			{update?.notes ? (
				<Panel title="Novedades" subtitle={`Cambios de la versión ${update.version}.`}>
					<div className="max-h-64 overflow-y-auto whitespace-pre-wrap text-sm text-fg-muted">
						{update.notes}
					</div>
				</Panel>
			) : null}

			{/* OPS-02: lo que se manda a soporte cuando algo no va bien, también sin internet. */}
			<Panel title="Soporte" subtitle={`Si algo no va bien, escribe a ${CORREO_SOPORTE}.`}>
				<p className="text-sm text-fg-muted">
					Guarda un diagnóstico de este equipo y mándalo con tu correo: dice qué versión
					tiene, cómo va la copia a la nube, las tareas de fondo y lo último que ha
					registrado. Sirve también sin internet. No lleva datos de clientes, personal ni
					ventas, ni claves: es un texto que puedes abrir y leer antes de mandarlo.
				</p>
				<div className="mt-4">
					<BotonDiagnostico />
				</div>
			</Panel>
		</div>
	);
}
