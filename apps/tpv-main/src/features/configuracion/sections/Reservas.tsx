// src/features/configuracion/sections/Reservas.tsx
//
// RI-61: lo que dura una reserva que no elige su duración, y qué pasa cuando dos reservas de la
// misma mesa se pisan (o una se pisa con una comanda abierta en ella). Y cuándo una reserva a la que
// no ha llegado nadie pasa sola a «No vino» (el job `reservas_no_vino` de la Main). Se guarda solo,
// como el resto de los datos del negocio (`useBusinessSettings`). Debajo, en la Main, las reservas
// desde la web.
import { Panel } from "../ui/Panel";
import { Field } from "../ui/Field";
import { useBusinessSettings } from "../../../shared/stores/useBusinessSettings";
import { etiquetaDuracion, opcionesDuracion, opcionesNoVino } from "../../reservas/duracion";
import { ReservasWeb } from "./ReservasWeb";

export function Reservas({ inputTone, isMain }: { inputTone: string; isMain: boolean }) {
	const ready = useBusinessSettings((s) => s.ready);
	const duracion = useBusinessSettings((s) => s.reserva_duracion_min);
	const solape = useBusinessSettings((s) => s.reserva_solape);
	const noVino = useBusinessSettings((s) => s.reserva_no_vino_min);
	const setMany = useBusinessSettings((s) => s.setMany);

	return (
		<div className="flex flex-col gap-4">
			<Panel title="Reservas">
				{!ready ? (
					<div className="py-4 text-sm text-fg-muted">Cargando…</div>
				) : (
					<div className="grid grid-cols-1 gap-5">
						<Field
							label="Duración de una reserva"
							hint="Cada reserva puede elegir la suya"
						>
							<select
								value={duracion}
								onChange={(e) => setMany({ reserva_duracion_min: Number(e.target.value) })}
								className={`w-full rounded-xl border border-border bg-surface px-3 py-2 text-sm text-fg outline-none ${inputTone}`}
							>
								{opcionesDuracion(duracion).map((m) => (
									<option key={m} value={m}>
										{etiquetaDuracion(m)}
									</option>
								))}
							</select>
						</Field>

						<div>
							<div className="text-sm font-semibold text-fg">
								Si dos reservas de la misma mesa se pisan
							</div>
							<div className="mt-2 flex flex-col gap-2">
								{(
									[
										["avisar", "Avisar y dejar guardarla si se confirma"],
										["prohibir", "No dejar guardarla"],
									] as const
								).map(([valor, texto]) => (
									<label key={valor} className="flex cursor-pointer items-center gap-2 text-sm text-fg">
										<input
											type="radio"
											name="reserva-solape"
											checked={solape === valor}
											onChange={() => setMany({ reserva_solape: valor })}
											className="accent-accent"
										/>
										{texto}
									</label>
								))}
							</div>
							<p className="mt-2 text-xs text-fg-muted">
								Una reserva ocupa la mesa desde su hora durante su duración. Una mesa con una
								comanda abierta también cuenta como ocupada: desde que se abrió, durante la
								duración de arriba o hasta ahora si lleva más.
							</p>
						</div>

						<Field
							label="Si el cliente no llega"
							hint="La reserva pasa a «No vino» y deja libre la mesa"
						>
							<select
								value={noVino}
								onChange={(e) => setMany({ reserva_no_vino_min: Number(e.target.value) })}
								className={`w-full rounded-xl border border-border bg-surface px-3 py-2 text-sm text-fg outline-none ${inputTone}`}
							>
								<option value={0}>No marcarla sola: se queda por llegar</option>
								{opcionesNoVino(noVino).map((m) => (
									<option key={m} value={m}>
										Marcar «No vino» {etiquetaDuracion(m)} después de su hora
									</option>
								))}
							</select>
						</Field>
					</div>
				)}
			</Panel>

			{isMain ? <ReservasWeb inputTone={inputTone} /> : null}
		</div>
	);
}
