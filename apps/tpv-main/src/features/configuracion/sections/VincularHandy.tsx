// src/features/configuracion/sections/VincularHandy.tsx
import React, { useEffect, useMemo, useState } from "react";
import { Panel } from "../ui/Panel";
import { GhostButton, PrimaryButton } from "../ui/Buttons";
import { cn } from "../utils";
import { QRCodeCanvas } from "qrcode.react";
import { confirm as confirmDialog, message as messageDialog } from "@tauri-apps/plugin-dialog";
import { toAppError } from "@tpv/client";
import { useEstadoSync } from "../../../shared/stores/useEstadoSync";
import { usePairCode } from "../../../shared/stores/usePairCode";
import {
	useAprobarHandy,
	useDispositivosVinculados,
	usePairPendientes,
	useRechazarHandy,
	useRevocarHandy,
} from "../pairingQueries";
import { conAviso } from "../../../shared/lib/conAviso";

export function VincularHandy({ darkMode }: { darkMode: boolean }) {
	// SYNC-17: la sección ya no se tapa (antes exigía el modo "online", que ya no existe). Vincular
	// es una petición REST al worker: lo que hace falta es que HAYA conexión ahora mismo. Sin ella
	// se dice claramente —el código se pide a la nube y sin ella no hay código válido que teclear—,
	// en vez de soltar el error crudo de red.
	const hayNube = useEstadoSync((s) => s.estado) === "conectado";

	// El código vive en un store, no aquí: salir de Configuración y volver no debe cambiar el QR
	// que alguien está intentando escanear (ver `shared/stores/usePairCode`).
	const pairCode = usePairCode((s) => s.code);
	const pairSecret = usePairCode((s) => s.secret);
	const expiresAtMs = usePairCode((s) => s.expiresAtMs);
	const loading = usePairCode((s) => s.loading);
	const error = usePairCode((s) => s.error);
	const asegurarCodigo = usePairCode((s) => s.asegurar);
	const regenerarCodigo = usePairCode((s) => s.regenerar);

	const qrValue = useMemo(() => {
		if (!pairCode || !pairSecret) return "";
		return `tpv://pair?code=${encodeURIComponent(pairCode)}&secret=${encodeURIComponent(pairSecret)}`;
	}, [pairCode, pairSecret]);

	const expiresText = useMemo(() => {
		if (!expiresAtMs) return "";
		const d = new Date(expiresAtMs);
		return d.toLocaleString("es-ES");
	}, [expiresAtMs]);

	// Cuenta atrás. Se guarda el instante actual y los segundos se DERIVAN en el render: con un
	// `secsLeft` en estado, el primer pintado tras recibir un código nuevo usaba todavía el 0 del
	// estado anterior y la línea salía un frame en rojo de "caduca ya" antes de corregirse.
	const [ahora, setAhora] = useState<number>(() => Date.now());

	useEffect(() => {
		const id = window.setInterval(() => setAhora(Date.now()), 1000);
		return () => window.clearInterval(id);
	}, []);

	const secsLeft = expiresAtMs
		? Math.max(0, Math.round((expiresAtMs - ahora) / 1000))
		: 0;

	const codigoCaducado = secsLeft <= 0;

	// Un código al entrar, y otro cuando el anterior caduca. El store decide si hace falta
	// pedirlo de verdad; aquí sólo se le pregunta. Sin conexión NO se intenta: lo emite el
	// worker, así que insistir sería un bucle de fallos contra la nube.
	useEffect(() => {
		if (!hayNube) return;
		void asegurarCodigo();
	}, [hayNube, codigoCaducado, asegurarCodigo]);

	const countdownText = useMemo(() => {
		if (!expiresAtMs || secsLeft <= 0) return "";
		const m = Math.floor(secsLeft / 60);
		const s = secsLeft % 60;
		return `${m}:${String(s).padStart(2, "0")}`;
	}, [secsLeft, expiresAtMs]);

	const onRegenerate = () => void regenerarCodigo();
	// CFG-INC-04: el código lo emite la nube. Sin conexión los dos botones se apagan y dicen por qué:
	// antes se podían pulsar, el fallo no salía (el aviso de «Necesitas conexión» tapa el error) y
	// parecía que no hacían nada.
	const sinNubeTitle = hayNube ? undefined : "Sin conexión a internet no se puede pedir un código nuevo.";
	const onShowCode = () => void messageDialog(`Código: ${pairCode}`);

	const pendientes = usePairPendientes();
	const vinculados = useDispositivosVinculados();
	const aprobar = useAprobarHandy();
	const rechazar = useRechazarHandy();
	const revocar = useRevocarHandy();

	const pending = pendientes.data ?? [];

	// OBS-01: en cuanto una Handy reclama el código que se enseña, ya no le sirve a otra aunque le
	// quede tiempo. Se cambia por uno nuevo; la solicitud sigue en pendientes con el suyo.
	const gastarCodigo = usePairCode((s) => s.gastado);
	const solicitudes = pendientes.data;
	useEffect(() => {
		if (pairCode && solicitudes?.some((p) => p.pairCode === pairCode)) void gastarCodigo(pairCode);
	}, [solicitudes, pairCode, gastarCodigo]);
	const linked = vinculados.data ?? [];

	// El cartel rojo sale cuando la consulta está EN error (React Query ya ha reintentado): un
	// tropiezo suelto no debe pintar un error que se va solo, porque enseña a ignorarlos. Lo que
	// sí se enseña siempre es el fallo de una acción del usuario —aprobar, rechazar o
	// desvincular—, que pulsó él y necesita saber si salió.
	const pendingErr = pendientes.isError
		? toAppError(pendientes.error).message
		: aprobar.isError
			? toAppError(aprobar.error).message
			: rechazar.isError
				? toAppError(rechazar.error).message
				: null;

	const linkedErr = vinculados.isError
		? toAppError(vinculados.error).message
		: revocar.isError
			? toAppError(revocar.error).message
			: null;

	const pendingBusy = aprobar.isPending || rechazar.isPending;
	const revokingId = revocar.isPending ? revocar.variables : null;

	function approve(code: string) {
		// `mutate` (no `mutateAsync`) porque aquí nadie espera el resultado: el fallo queda en
		// `aprobar.error` y de ahí sale el cartel.
		aprobar.mutate(code);
	}

	async function revoke(deviceId: string) {
		if (
			!(await confirmDialog(
				"¿Desvincular este dispositivo? Perderá el acceso y tendrá que volver a emparejarse.",
				{ title: "Desvincular Handy", kind: "warning" },
			))
		)
			return;

		revocar.mutate(deviceId);
	}

	return (
		<div className="relative flex flex-col gap-4">
			<Panel
				title="Vincular Handy"
				subtitle="Da al Handy este código para que pida la vinculación, y apruébala aquí."
				right={
					<GhostButton onClick={onRegenerate} disabled={loading || !hayNube} title={sinNubeTitle}>
						{loading ? "Generando..." : "Generar nuevo"}
					</GhostButton>
				}
			>
				<div
					className={cn(
						"rounded-2xl border p-5",
						darkMode
							? "border-border bg-surface-2"
							: "border-border bg-surface",
					)}
				>
					<div
						className={cn(
							"text-sm font-semibold",
							darkMode ? "text-white" : "text-fg",
						)}
					>
						Código de vinculación
					</div>

					<div
						className={cn(
							"text-xs mt-1",
							darkMode ? "text-fg-muted" : "text-fg-muted",
						)}
					>
						En el Handy, abre la app y elige «Handy» (si ya estaba vinculado, pulsa
						«← Vinculación»). En «Conecta este Handy», pega el contenido de este QR o
						escribe el código.
					</div>

					{/* Sin conexión no hay código que dar. Se dice así, y NO se enseña el error de red
					    debajo (sería el mismo problema contado dos veces, una de ellas en jerga). */}
					{!hayNube ? (
						<div className="mt-3 rounded-xl border border-warning/40 bg-warning/10 px-3 py-2 text-sm text-warning">
							<span className="font-semibold">Necesitas conexión a internet</span> para
							vincular un Handy. Este TPV sigue funcionando con normalidad; en cuanto
							recupere la conexión, vuelve aquí y el código se generará solo.
						</div>
					) : error ? (
						<div
							className={cn(
								"mt-3 text-sm rounded-xl border px-3 py-2",
								darkMode
									? "border-danger/30 bg-danger-soft text-danger"
									: "border-danger/30 bg-danger-soft text-danger",
							)}
						>
							{error}
						</div>
					) : null}

					<div className="mt-5 grid grid-cols-1 md:grid-cols-[240px_1fr] gap-5 items-start">
						<div
							className={cn(
								"rounded-2xl border p-4 grid place-items-center",
								darkMode
									? "border-border bg-surface-2"
									: "border-border bg-surface-2",
							)}
						>
							<div
								className={cn(
									"h-[200px] w-[200px] rounded-xl border grid place-items-center",
									darkMode
										? "border-border bg-surface-2"
										: "border-border bg-surface",
								)}
							>
								{qrValue && !loading ? (
									<QRCodeCanvas value={qrValue} size={172} includeMargin />
								) : (
									<div
										className={cn(
											"text-xs",
											darkMode ? "text-fg-muted" : "text-fg-muted",
										)}
									>
										{loading ? "Generando QR..." : "Sin código"}
									</div>
								)}
							</div>

							<div
								className={cn(
									"mt-3 text-xs font-semibold",
									darkMode ? "text-fg-muted" : "text-fg-muted",
								)}
							>
								Código: <span className="font-mono">{pairCode || "—"}</span>
							</div>

							{expiresAtMs ? (
								<div
									className={cn(
										"mt-1 text-[11px] font-mono",
										secsLeft <= 30
											? "text-danger font-semibold"
											: darkMode
												? "text-fg-subtle"
												: "text-fg-muted",
									)}
								>
									{secsLeft > 0
										? `Caduca en ${countdownText}`
										: `Caduca: ${expiresText}`}
								</div>
							) : null}
						</div>

						<div className="min-w-0">
							<div
								className={cn(
									"rounded-2xl border p-4",
									darkMode
										? "border-border bg-surface-2"
										: "border-border bg-surface",
								)}
							>
								<div
									className={cn(
										"text-sm font-semibold",
										darkMode ? "text-white" : "text-fg",
									)}
								>
									Pasos
								</div>

								<ol
									className={cn(
										"mt-2 text-sm space-y-1",
										darkMode ? "text-fg-muted" : "text-fg-muted",
									)}
								>
									<li>1) Abre la app en el Handy y elige «Handy». Si ya estaba vinculado, pulsa «← Vinculación».</li>
									<li>2) En «Conecta este Handy», pega el contenido del QR o escribe el código de 6 cifras y pulsa «Vincular dispositivo».</li>
									<li>3) Acepta aquí la solicitud, después de comprobar que la huella es la que enseña el Handy.</li>
								</ol>

								<div
									className={cn(
										"mt-4 text-xs",
										darkMode ? "text-fg-subtle" : "text-fg-muted",
									)}
								>
									Si el QR no funciona, usa el botón “Mostrar código” y escribe
									el código en el Handy.
								</div>

								<div className="mt-4 flex flex-wrap items-center gap-2">
									<PrimaryButton onClick={onRegenerate} disabled={loading || !hayNube} title={sinNubeTitle}>
										{loading ? "Generando..." : "Regenerar código"}
									</PrimaryButton>

									<GhostButton onClick={onShowCode} disabled={!pairCode}>
										Mostrar código
									</GhostButton>
								</div>
							</div>

							<div
								className={cn(
									"mt-4 rounded-2xl border p-4",
									darkMode
										? "border-border bg-surface-2"
										: "border-border bg-surface",
								)}
							>
								<div
									className={cn(
										"text-sm font-semibold",
										darkMode ? "text-white" : "text-fg",
									)}
								>
									Solicitudes de emparejamiento
								</div>

								{pendingErr ? (
									<div
										className={cn(
											"mt-3 text-sm rounded-xl border px-3 py-2",
											darkMode
												? "border-danger/30 bg-danger-soft text-danger"
												: "border-danger/30 bg-danger-soft text-danger",
										)}
									>
										{pendingErr}
									</div>
								) : null}

								{pending.length === 0 ? (
									<div
										className={cn(
											"mt-2 text-xs",
											darkMode ? "text-fg-subtle" : "text-fg-muted",
										)}
									>
										No hay solicitudes pendientes.
									</div>
								) : (
									<div className="mt-3 space-y-2">
										{pending.map((p) => {
											const claimedName = p.claimedDeviceName || "Handy";
											const claimedId = p.claimedDeviceId || "—";
											const claimedAt = p.claimedAtMs
												? new Date(p.claimedAtMs).toLocaleString("es-ES")
												: "—";
											const exp = p.expiresAtMs
												? new Date(p.expiresAtMs).toLocaleString("es-ES")
												: "—";

											return (
												<div
													key={p.pairCode}
													className={cn(
														"rounded-xl border p-3 flex flex-col gap-2",
														darkMode
															? "border-border bg-surface-2"
															: "border-border bg-surface-2",
													)}
												>
													<div className="flex items-start justify-between gap-3">
														<div className="min-w-0">
															<div
																className={cn(
																	"text-sm font-semibold truncate",
																	darkMode
																		? "text-white"
																		: "text-fg",
																)}
															>
																{claimedName}{" "}
																<span
																	className={cn(
																		"text-xs font-mono",
																		darkMode
																			? "text-fg-subtle"
																			: "text-fg-muted",
																	)}
																>
																	({claimedId})
																</span>
															</div>

															<div
																className={cn(
																	"text-xs mt-0.5",
																	darkMode
																		? "text-fg-subtle"
																		: "text-fg-muted",
																)}
															>
																Código:{" "}
																<span className="font-mono">
																	{p.pairCode}
																</span>{" "}
																· Solicitado: {claimedAt} · Caduca: {exp}
															</div>

															<div
																className={cn(
																	"text-xs mt-1",
																	darkMode
																		? "text-fg-subtle"
																		: "text-fg-muted",
																)}
															>
																Huella:{" "}
																<span className="font-mono font-semibold">
																	{p.fingerprint || "—"}
																</span>{" "}
																<span className="text-[11px]">
																	(verifícala contra la que muestra el Handy)
																</span>
															</div>
														</div>

														<div className="flex gap-2 shrink-0">
															<GhostButton
																disabled={pendingBusy}
																onClick={() => rechazar.mutate(p.pairCode)}
															>
																Rechazar
															</GhostButton>
															<PrimaryButton
																disabled={pendingBusy}
																onClick={() => approve(p.pairCode)}
															>
																{pendingBusy ? "..." : "Aceptar"}
															</PrimaryButton>
														</div>
													</div>

													<div
														className={cn(
															"text-[11px]",
															darkMode ? "text-fg-muted" : "text-fg-muted",
														)}
													>
														Intentos:{" "}
														<span className="font-mono">{p.attempts}</span>
													</div>
												</div>
											);
										})}
									</div>
								)}

								<div
									className={cn(
										"mt-3 text-[11px]",
										darkMode ? "text-fg-muted" : "text-fg-muted",
									)}
								>
									Las solicitudes aparecen solas en cuanto el Handy las envía.
								</div>
							</div>
						</div>
					</div>
				</div>
			</Panel>

			<Panel
				title="Dispositivos vinculados"
				subtitle="Handys con acceso ahora mismo. Puedes desvincular cualquiera."
			>
				{linkedErr ? (
					<div className="mb-3 text-sm rounded-xl border border-danger/30 bg-danger-soft px-3 py-2 text-danger">
						{linkedErr}
					</div>
				) : null}

				{linked.length === 0 ? (
					<div className="text-xs text-fg-muted">
						No hay dispositivos vinculados.
					</div>
				) : (
					<div className="space-y-2">
						{linked.map((d) => {
							const lastSeen = d.lastSeenAtMs
								? new Date(d.lastSeenAtMs).toLocaleString("es-ES")
								: "—";
							return (
								<div
									key={d.deviceId}
									className={cn(
										"rounded-xl border p-3 flex items-center justify-between gap-3",
										darkMode
											? "border-border bg-surface-2"
											: "border-border bg-surface-2",
									)}
								>
									<div className="min-w-0">
										<div
											className={cn(
												"text-sm font-semibold",
												darkMode ? "text-white" : "text-fg",
											)}
										>
											Handy{" "}
											<span className="font-mono font-semibold text-xs">
												{d.fingerprint || "—"}
											</span>
										</div>
										<div className="text-xs text-fg-muted mt-0.5 truncate">
											ID:{" "}
											<span className="font-mono">
												{d.deviceId.slice(0, 12)}…
											</span>{" "}
											· Visto: {lastSeen}
										</div>
									</div>

									<div className="shrink-0">
										<GhostButton
											onClick={conAviso(() => revoke(d.deviceId))}
											disabled={revokingId === d.deviceId}
										>
											{revokingId === d.deviceId
												? "Desvinculando..."
												: "Desvincular"}
										</GhostButton>
									</div>
								</div>
							);
						})}
					</div>
				)}
			</Panel>

		</div>
	);
}