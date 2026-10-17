// src/features/configuracion/sections/ReservasWeb.tsx
//
// Reservas desde la web (docs/estudios/reservas-web.md): el interruptor general y los días en que la
// web no acepta ninguna reserva. Qué mesas se pueden reservar y cuándo se elige en el editor del
// plano, mesa a mesa. Sólo en la Main: es configuración del negocio y la Handy no la escribe.
import { useCallback, useEffect, useState } from "react";
import { commands, toAppError } from "@tpv/client";
import type { CierreReservaWebDto } from "@tpv/contracts";
import { Panel } from "../ui/Panel";
import { Switch } from "../ui/Toggles";
import { TextInput } from "../ui/Inputs";
import { GhostButton, PrimaryButton } from "../ui/Buttons";
import { conAviso } from "../../../shared/lib/conAviso";
import { todayLocalYmd } from "../../login/fechaJornada";

/** `2026-12-24` → «jueves, 24 de diciembre de 2026». */
function fechaLarga(ymd: string): string {
	const [a, m, d] = ymd.split("-").map(Number);
	return new Date(a, m - 1, d).toLocaleDateString("es-ES", {
		weekday: "long",
		day: "numeric",
		month: "long",
		year: "numeric",
	});
}

export function ReservasWeb({ inputTone }: { inputTone: string }) {
	const [estado, setEstado] = useState<"cargando" | "listo" | "error">("cargando");
	const [error, setError] = useState("");
	const [activa, setActiva] = useState(false);
	const [cierres, setCierres] = useState<CierreReservaWebDto[]>([]);
	const [dia, setDia] = useState("");
	const [motivo, setMotivo] = useState("");
	const [guardando, setGuardando] = useState(false);
	const [cambiandoActiva, setCambiandoActiva] = useState(false);

	// Captura su propio error y lo enseña en el panel: por eso se puede lanzar con `void`.
	const cargar = useCallback(async () => {
		try {
			const ajustes = await commands.reservaWebAjustes();
			setActiva(ajustes.activa);
			setCierres(ajustes.cierres);
			setEstado("listo");
		} catch (e) {
			setError(toAppError(e).message);
			setEstado("error");
		}
	}, []);

	useEffect(() => {
		void cargar();
	}, [cargar]);

	// Una pulsación cada vez: hasta que no se guarda la anterior, el interruptor no acepta otra. Así
	// lo que queda en la base es la última elección, en el orden en que se hizo.
	async function cambiarActiva(valor: boolean) {
		setCambiandoActiva(true);
		setActiva(valor);
		try {
			await commands.reservaWebActivar({ activa: valor });
		} catch (e) {
			setActiva(!valor);
			throw e;
		} finally {
			setCambiandoActiva(false);
		}
	}

	async function cerrarDia() {
		if (!dia) return;
		setGuardando(true);
		try {
			await commands.reservaWebCerrarDia({ dia_ymd: dia, motivo: motivo.trim() || null });
			setDia("");
			setMotivo("");
			await cargar();
		} finally {
			setGuardando(false);
		}
	}

	async function quitarCierre(idCierre: string) {
		await commands.reservaWebQuitarCierre({ id_cierre: idCierre });
		await cargar();
	}

	return (
		<Panel
			title="Reservas desde la web"
			subtitle="Qué mesas se pueden reservar y cuándo se elige en el editor del plano, mesa a mesa."
		>
			{estado === "cargando" ? (
				<div className="py-4 text-sm text-fg-muted">Cargando…</div>
			) : estado === "error" ? (
				<div className="flex items-center justify-between gap-3">
					<span className="text-sm text-danger">{error}</span>
					<GhostButton
						onClick={() => {
							setEstado("cargando");
							void cargar();
						}}
					>
						Reintentar
					</GhostButton>
				</div>
			) : (
				<div className="grid grid-cols-1 gap-5">
					<Switch
						checked={activa}
						disabled={cambiandoActiva}
						onChange={conAviso(cambiarActiva, "No se ha podido cambiar la reserva desde la web")}
						label="Aceptar reservas desde la web"
						description="Apagado, no entra ninguna reserva desde la web."
					/>

					<div>
						<div className="text-sm font-semibold text-fg">Días cerrados</div>
						<p className="mt-1 text-xs text-fg-muted">
							Esos días la web no acepta ninguna reserva, aunque las mesas lo permitan.
						</p>

						<div className="mt-3 flex flex-col gap-2 sm:flex-row">
							<TextInput
								type="date"
								aria-label="Día que se cierra"
								value={dia}
								min={todayLocalYmd()}
								onChange={(e) => setDia(e.target.value)}
								className={`sm:w-48 ${inputTone}`}
							/>
							<TextInput
								aria-label="Motivo"
								placeholder="Motivo (opcional)"
								value={motivo}
								maxLength={100}
								onChange={(e) => setMotivo(e.target.value)}
								className={inputTone}
							/>
							<PrimaryButton
								onClick={conAviso(cerrarDia, "No se ha podido cerrar el día")}
								disabled={!dia || guardando}
							>
								Cerrar día
							</PrimaryButton>
						</div>

						{cierres.length === 0 ? (
							<p className="mt-3 text-sm text-fg-muted">No hay días cerrados.</p>
						) : (
							<ul className="mt-3 divide-y divide-border rounded-xl border border-border">
								{cierres.map((c) => (
									<li key={c.id_cierre} className="flex items-center justify-between gap-3 px-4 py-2.5">
										<div className="min-w-0">
											<div className="text-sm font-semibold text-fg first-letter:uppercase">
												{fechaLarga(c.dia_ymd)}
											</div>
											{c.motivo ? (
												<div className="truncate text-xs text-fg-muted">{c.motivo}</div>
											) : null}
										</div>
										<GhostButton
											onClick={conAviso(() => quitarCierre(c.id_cierre), "No se ha podido abrir el día")}
										>
											Quitar
										</GhostButton>
									</li>
								))}
							</ul>
						)}
					</div>
				</div>
			)}
		</Panel>
	);
}
