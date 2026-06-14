// src/features/configuracion/sections/Conectividad.tsx
import React from "react";
import { Panel } from "../ui/Panel";
import { cn } from "../utils";
import {
	useConnectionMode,
	type ConnectionMode,
} from "../../../shared/stores/useConnectionMode";

type Option = {
	value: ConnectionMode;
	title: string;
	desc: string;
};

const OPTIONS: Option[] = [
	{
		value: "offline",
		title: "Sin conexión (local)",
		desc: "Solo este dispositivo. No se conecta a la nube ni permite dispositivos Handy. Máxima velocidad y funciona aunque no haya internet.",
	},
	{
		value: "online",
		title: "Con conexión (nube)",
		desc: "Además de trabajar en local, mantiene la conexión con el servidor para guardar una copia de seguridad de los datos y permitir dispositivos Handy.",
	},
];

export function Conectividad({ darkMode }: { darkMode: boolean }) {
	const mode = useConnectionMode((s) => s.mode);
	const setMode = useConnectionMode((s) => s.setMode);

	const [busy, setBusy] = React.useState(false);
	const [error, setError] = React.useState<string | null>(null);

	const onSelect = async (value: ConnectionMode) => {
		if (busy || value === mode) return;
		setError(null);
		setBusy(true);
		try {
			await setMode(value);
		} catch (e) {
			const msg = String((e as any)?.message ?? e ?? "");
			setError(
				msg.includes("licencia")
					? "No se pudo activar el modo online: la licencia no es válida o no se pudo verificar. Revisa tu licencia e inténtalo de nuevo."
					: `No se pudo cambiar de modo: ${msg}`,
			);
		} finally {
			setBusy(false);
		}
	};

	return (
		<div className="flex flex-col gap-4">
			<Panel
				title="Modo de funcionamiento"
				subtitle="Elige si este TPV trabaja solo en local o también sincroniza con la nube."
			>
				<div className="flex flex-col gap-3">
					{OPTIONS.map((opt) => {
						const selected = mode === opt.value;
						return (
							<button
								key={opt.value}
								type="button"
								disabled={busy}
								onClick={() => onSelect(opt.value)}
								className={cn(
									"text-left rounded-2xl border p-4 transition",
									busy && "opacity-60 cursor-wait",
									selected
										? "border-accent bg-accent-soft"
										: darkMode
											? "border-border bg-surface-2 hover:bg-surface"
											: "border-border bg-surface hover:bg-surface-2",
								)}
							>
								<div className="flex items-start gap-3">
									<span
										className={cn(
											"mt-0.5 grid size-5 shrink-0 place-items-center rounded-full border",
											selected
												? "border-accent"
												: "border-border",
										)}
									>
										{selected ? (
											<span className="size-2.5 rounded-full bg-accent" />
										) : null}
									</span>

									<div className="min-w-0">
										<div
											className={cn(
												"text-sm font-semibold",
												darkMode ? "text-white" : "text-fg",
											)}
										>
											{opt.title}
										</div>
										<div className="text-xs text-fg-muted mt-1">
											{opt.desc}
										</div>
									</div>
								</div>
							</button>
						);
					})}
				</div>

				{error && (
					<div className="mt-3 rounded-xl border border-danger/40 bg-danger/10 p-3 text-xs text-danger">
						{error}
					</div>
				)}

				<p className="mt-4 text-[11px] text-fg-muted">
					El modo se aplica solo en este dispositivo. En "Con conexión" la app sigue
					funcionando aunque internet se caiga puntualmente; solo se pausaría la
					sincronización hasta recuperar la conexión.
				</p>
			</Panel>
		</div>
	);
}
