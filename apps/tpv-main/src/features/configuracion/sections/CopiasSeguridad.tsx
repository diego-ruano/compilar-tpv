import { commands } from "@tpv/client";
// src/features/configuracion/sections/CopiasSeguridad.tsx
import React from "react";

import { save } from "@tauri-apps/plugin-dialog";
import { toAppError } from "@tpv/client";
import type { LocalBackupInfo } from "@tpv/contracts";

import { useToast } from "../../../shared/toast";
import { GhostButton, PrimaryButton } from "../ui/Buttons";
import { Panel } from "../ui/Panel";
import { cn } from "../utils";

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
 * una antes de algo delicado, ni de sacar una del equipo. Visibles y accionables ANTES de que hagan
 * falta, que es lo único que distingue un respaldo de una carpeta con ficheros dentro.
 *
 * Aquí NO se restaura: eso sigue viviendo sólo en la pantalla de recuperación, que es la única que
 * garantiza que nadie está vendiendo mientras se reemplaza la base.
 */
export function CopiasSeguridad({ darkMode }: { darkMode: boolean }) {
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
