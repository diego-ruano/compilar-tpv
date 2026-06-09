// src/features/configuracion/sections/VincularHandy.tsx
import React, { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Panel } from "../ui/Panel";
import { GhostButton, PrimaryButton } from "../ui/Buttons";
import { cn } from "../utils";
import { QRCodeCanvas } from "qrcode.react";

type PairPendingItem = {
	pairCode: string;
	status: string;
	createdAtMs: number;
	expiresAtMs: number;

	claimedAtMs: number | null;
	claimedDeviceId: string | null;
	claimedDeviceName: string | null;

	attempts: number;
	lastAttemptAtMs: number | null;
};

async function tpvApi(path: string, body: any) {
	return await invoke("tpv_server_post_json", {
		args: {
			mode: "tpv",
			path,
			body,
		},
	});
}

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

	async function refreshPending() {
		try {
			setPendingErr(null);
			const r = (await tpvApi("/v1/pair/pending", {})) as any;
			setPending((r.items || []) as PairPendingItem[]);
		} catch (e: any) {
			setPendingErr(String(e?.message || e));
		}
	}

	useEffect(() => {
		refreshPending();
		const id = window.setInterval(() => refreshPending(), 5000);
		return () => window.clearInterval(id);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	async function approve(code: string) {
		setPendingBusy(true);

		try {
			await tpvApi("/v1/pair/approve", { pairCode: code });
			await refreshPending();
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
		</div>
	);
}