// src/features/configuracion/sections/VincularHandy.tsx
import React, { useEffect, useMemo, useState } from "react";
import { Panel } from "../ui/Panel";
import { GhostButton, PrimaryButton } from "../ui/Buttons";
import { cn } from "../utils";
import { QRCodeCanvas } from "qrcode.react";
import { cloudPost } from "../../../shared/lib/cloudApi";
import { deviceFingerprint } from "../../../shared/lib/deviceFingerprint";

type PairPendingItem = {
	pairCode: string;
	status: string;
	createdAtMs: number;
	expiresAtMs: number;

	claimedAtMs: number | null;
	claimedDeviceId: string | null;
	claimedDeviceName: string | null;
	claimedDevicePubKeyB64: string | null;

	attempts: number;
	lastAttemptAtMs: number | null;

	// Calculada en el cliente a partir de claimedDevicePubKeyB64 (no viene del worker).
	fingerprint?: string;
};

type LinkedDevice = {
	deviceId: string;
	devicePubKeyB64: string | null;
	firstSeenAtMs: number;
	lastSeenAtMs: number;
	fingerprint?: string;
};

export function VincularHandy({
	darkMode,
	pairCode,
	pairSecret,
	expiresAtMs,
	loading,
	error,
	onRegenerate,
	onShowCode,
}: {
	darkMode: boolean;

	pairCode: string;
	pairSecret: string;
	expiresAtMs: number | null;

	loading: boolean;
	error: string | null;

	onRegenerate: () => void;
	onShowCode: () => void;
}) {
	const qrValue = useMemo(() => {
		if (!pairCode || !pairSecret) return "";
		return `tpv://pair?code=${encodeURIComponent(pairCode)}&secret=${encodeURIComponent(pairSecret)}`;
	}, [pairCode, pairSecret]);

	const expiresText = useMemo(() => {
		if (!expiresAtMs) return "";
		const d = new Date(expiresAtMs);
		return d.toLocaleString("es-ES");
	}, [expiresAtMs]);

	const [pending, setPending] = useState<PairPendingItem[]>([]);
	const [pendingErr, setPendingErr] = useState<string | null>(null);
	const [pendingBusy, setPendingBusy] = useState(false);

	const [linked, setLinked] = useState<LinkedDevice[]>([]);
	const [linkedErr, setLinkedErr] = useState<string | null>(null);
	const [revokingId, setRevokingId] = useState<string | null>(null);

	async function refreshLinked() {
		try {
			setLinkedErr(null);
			const r = (await cloudPost("tpv", "/v1/device/list", {})) as any;
			const items = (r.items || []) as LinkedDevice[];
			const withFp = await Promise.all(
				items.map(async (it) => ({
					...it,
					fingerprint: it.devicePubKeyB64
						? await deviceFingerprint(it.devicePubKeyB64)
						: "",
				})),
			);
			setLinked(withFp);
		} catch (e: any) {
			setLinkedErr(String(e?.message || e));
		}
	}

	async function revoke(deviceId: string) {
		if (
			!window.confirm(
				"¿Desvincular este dispositivo? Perderá el acceso y tendrá que volver a emparejarse.",
			)
		)
			return;
		setRevokingId(deviceId);
		try {
			await cloudPost("tpv", "/v1/device/revoke", { deviceId });
			await refreshLinked();
		} catch (e: any) {
			setLinkedErr(String(e?.message || e));
		} finally {
			setRevokingId(null);
		}
	}

	async function refreshPending() {
		try {
			setPendingErr(null);
			const r = (await cloudPost("tpv", "/v1/pair/pending", {})) as any;
			const items = (r.items || []) as PairPendingItem[];

			// Resolvemos la huella de cada dispositivo para que el operador pueda
			// compararla con la que muestra el Handy antes de aprobar.
			const withFp = await Promise.all(
				items.map(async (it) => ({
					...it,
					fingerprint: it.claimedDevicePubKeyB64
						? await deviceFingerprint(it.claimedDevicePubKeyB64)
						: "",
				})),
			);

			setPending(withFp);
		} catch (e: any) {
			setPendingErr(String(e?.message || e));
		}
	}

	useEffect(() => {
		refreshPending();
		refreshLinked();
		const id = window.setInterval(() => {
			refreshPending();
			refreshLinked();
		}, 5000);
		return () => window.clearInterval(id);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	async function approve(code: string) {
		setPendingBusy(true);

		try {
			await cloudPost("tpv", "/v1/pair/approve", { pairCode: code });
			await refreshPending();
			await refreshLinked();
		} catch (e: any) {
			setPendingErr(String(e?.message || e));
		} finally {
			setPendingBusy(false);
		}
	}

	return (
		<div className="flex flex-col gap-4">
			<Panel
				title="Vincular Handy"
				subtitle="Escanea este QR con el dispositivo que quieras emparejar."
				right={
					<GhostButton onClick={onRegenerate} disabled={loading}>
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
						Escanea este código QR
					</div>

					<div
						className={cn(
							"text-xs mt-1",
							darkMode ? "text-fg-muted" : "text-fg-muted",
						)}
					>
						En el Handy entra a Configuración → “Vincular dispositivo” y
						escanea.
					</div>

					{error ? (
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
										"mt-1 text-[11px]",
										darkMode ? "text-fg-subtle" : "text-fg-muted",
									)}
								>
									Caduca: {expiresText}
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
									<li>1) Abre la app en el Handy.</li>
									<li>2) Ve a Configuración → “Vincular dispositivo”.</li>
									<li>3) Escanea el QR o introduce el código manualmente.</li>
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
									<PrimaryButton onClick={onRegenerate} disabled={loading}>
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
									Se actualiza automáticamente cada 5 segundos.
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
											onClick={() => revoke(d.deviceId)}
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