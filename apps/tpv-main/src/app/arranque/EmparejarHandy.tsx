// src/app/arranque/EmparejarHandy.tsx
//
// La vinculación de un Handy con su Main: se escanea el QR con la cámara (en móvil), se pega su
// contenido o se escribe el código, y se espera a que la Main apruebe la solicitud.

import React, { useEffect, useRef, useState } from "react";
import { Camera, Fingerprint, Link2, QrCode, RotateCcw, ScanLine, ShieldCheck, Smartphone } from "lucide-react";

import { conAviso } from "../../shared/lib/conAviso";
import { Badge, Button, Card, Input } from "../../shared/ui";
import FondoDecorado from "./FondoDecorado";
import type { EmparejamientoHandy } from "./useEmparejamientoHandy";
import { avisoDelEscaneo, EscaneoQr, puedeEscanear } from "./escanearQr";

export default function EmparejarHandy({
	emparejamiento,
	volviendo,
	onVolver,
}: {
	emparejamiento: EmparejamientoHandy;
	volviendo: boolean;
	/** Al selector de modo, sin tocar el vínculo guardado (AUD-23). */
	onVolver: () => void;
}) {
	const { estado, ocupado, error, huella } = emparejamiento;
	const [contenidoQr, setContenidoQr] = useState("");
	const [codigoManual, setCodigoManual] = useState("");

	// El lector de QR con la cámara, sólo en móvil. Lo leído sigue el mismo camino que pegarlo.
	const conCamara = puedeEscanear();
	const escaneoRef = useRef<EscaneoQr | null>(null);
	const [escaneando, setEscaneando] = useState(false);
	const [avisoEscaneo, setAvisoEscaneo] = useState<string | null>(null);

	async function escanear() {
		setAvisoEscaneo(null);
		const escaneo = new EscaneoQr();
		escaneoRef.current = escaneo;
		const r = await escaneo.leer(() => setEscaneando(true));
		if (escaneoRef.current !== escaneo) return;
		escaneoRef.current = null;
		setEscaneando(false);
		if (r.tipo === "leido") {
			setContenidoQr(r.contenido);
			emparejamiento.vincular(r.contenido, "");
			return;
		}
		setAvisoEscaneo(avisoDelEscaneo(r));
	}

	// Si la pantalla se va a mitad de un escaneo, la cámara no se queda abierta detrás.
	useEffect(
		() => () => {
			const escaneo = escaneoRef.current;
			escaneoRef.current = null;
			if (escaneo) void escaneo.cancelar().catch(() => {});
		},
		[],
	);

	return (
		<div className="relative flex min-h-full w-full items-center justify-center overflow-y-auto bg-bg p-4 text-fg sm:p-6 lg:p-10">
			<FondoDecorado />

			{escaneando ? (
				// Mientras se escanea la aplicación no se pinta (`Global.css`, `escaneando-qr`): la cámara
				// está detrás. Sólo se ve esto.
				<div className="visor-qr fixed inset-0 z-50 flex flex-col items-center justify-between p-6" role="dialog" aria-label="Escanear el QR">
					<p className="rounded-xl bg-black/70 px-4 py-2 text-center text-sm font-semibold text-white">
						Apunta al QR que enseña el TPV principal
					</p>
					<div className="size-64 rounded-3xl border-4 border-white/90" aria-hidden />
					<Button
						variant="secondary"
						size="lg"
						onClick={() => {
							void escaneoRef.current?.cancelar().catch(() => {});
						}}
					>
						Cancelar
					</Button>
				</div>
			) : null}

			<div className="relative w-full max-w-5xl">
				<div className="mb-4 flex items-center justify-between gap-3">
					<Button variant="secondary" size="sm" disabled={volviendo || ocupado} onClick={conAviso(onVolver)}>
						← Volver
					</Button>
					<Badge>Modo Handy</Badge>
				</div>

				<Card padded={false} className="grid overflow-hidden rounded-3xl shadow-xl lg:grid-cols-[0.9fr_1.1fr]">
					<section className="flex flex-col justify-between border-b border-border bg-surface-2 p-6 sm:p-8 lg:border-b-0 lg:border-r">
						<div>
							<div className="flex items-center justify-between gap-3">
								<div className="grid size-14 place-items-center rounded-2xl bg-accent-soft text-accent">
									<Smartphone className="size-7" aria-hidden />
								</div>
								<Badge tone="accent">Vinculación segura</Badge>
							</div>

							<h1 className="mt-6 text-2xl font-bold tracking-tight text-fg sm:text-3xl">Conecta este Handy</h1>
							<p className="mt-3 text-sm leading-relaxed text-fg-muted sm:text-base">
								Genera una solicitud desde este dispositivo y
								apruébala en el TPV principal para empezar a
								trabajar en sala.
							</p>

							<div className="mt-7 space-y-4">
								<div className="flex gap-3">
									<div className="grid size-9 shrink-0 place-items-center rounded-xl bg-surface text-accent shadow-sm">
										<QrCode className="size-4" aria-hidden />
									</div>
									<div>
										<p className="text-sm font-semibold text-fg">Usa el QR del TPV</p>
										<p className="mt-0.5 text-xs leading-relaxed text-fg-muted">
											{conCamara
												? "Escanéalo con la cámara, o pega aquí su contenido."
												: "Pega aquí el contenido leído del código QR."}
										</p>
									</div>
								</div>

								<div className="flex gap-3">
									<div className="grid size-9 shrink-0 place-items-center rounded-xl bg-surface text-accent shadow-sm">
										<ShieldCheck className="size-4" aria-hidden />
									</div>
									<div>
										<p className="text-sm font-semibold text-fg">Aprueba en la Main</p>
										<p className="mt-0.5 text-xs leading-relaxed text-fg-muted">
											El TPV principal debe aceptar este dispositivo.
										</p>
									</div>
								</div>
							</div>
						</div>

						{huella ? (
							<div className="mt-8 rounded-2xl border border-border bg-surface p-4">
								<div className="flex items-center gap-2 text-xs font-semibold text-fg">
									<Fingerprint className="size-4 text-accent" aria-hidden />
									Huella del dispositivo
								</div>
								<p className="mt-2 break-all font-mono text-sm font-bold text-fg">{huella}</p>
								<p className="mt-2 text-xs leading-relaxed text-fg-muted">
									Si usas el código manual, comprueba que
									coincide con la huella mostrada en el TPV.
								</p>
							</div>
						) : null}
					</section>

					<section className="p-6 sm:p-8">
						<div className="flex items-center gap-3">
							<div className="grid size-10 place-items-center rounded-xl bg-accent-soft text-accent">
								<Link2 className="size-5" aria-hidden />
							</div>
							<div>
								<h2 className="text-lg font-bold text-fg">Datos de vinculación</h2>
								<p className="text-sm text-fg-muted">Utiliza una de las dos opciones.</p>
							</div>
						</div>

						<div className="mt-6 grid gap-5">
							<div>
								<label htmlFor="handy-qr-payload" className="flex items-center gap-2 text-sm font-semibold text-fg">
									<ScanLine className="size-4 text-accent" aria-hidden />
									Contenido del QR
								</label>
								<Input
									id="handy-qr-payload"
									value={contenidoQr}
									onChange={(e) => setContenidoQr(e.target.value)}
									disabled={ocupado}
									className="mt-2 h-12 px-4 font-mono"
									placeholder="tpv://pair?code=123456&secret=..."
									autoComplete="off"
								/>
								<p className="mt-2 text-xs text-fg-subtle">
									Pega la dirección completa obtenida al escanear el QR.
								</p>
								{conCamara ? (
									<Button
										variant="secondary"
										size="lg"
										fullWidth
										className="mt-3"
										disabled={ocupado || escaneando}
										leftIcon={<Camera className="size-5" aria-hidden />}
										onClick={conAviso(escanear)}
									>
										Escanear el QR
									</Button>
								) : null}
								{avisoEscaneo ? (
									<p role="status" className="mt-2 rounded-xl border border-warning bg-warning-soft px-3 py-2 text-xs text-fg">
										{avisoEscaneo}
									</p>
								) : null}
							</div>

							<div className="flex items-center gap-3">
								<div className="h-px flex-1 bg-border" />
								<span className="text-xs font-semibold uppercase tracking-wider text-fg-subtle">o</span>
								<div className="h-px flex-1 bg-border" />
							</div>

							<div>
								<label htmlFor="handy-pair-code" className="text-sm font-semibold text-fg">
									Código manual
								</label>
								<Input
									id="handy-pair-code"
									value={codigoManual}
									onChange={(e) => setCodigoManual(e.target.value.replace(/[^\d]/g, "").slice(0, 6))}
									disabled={ocupado}
									className="mt-2 h-14 px-4 text-center font-mono text-xl font-bold tracking-[0.35em]"
									placeholder="123456"
									inputMode="numeric"
									autoComplete="one-time-code"
									maxLength={6}
								/>
							</div>

							{estado.step === "waiting_approval" ? (
								<div
									className="flex items-center justify-between gap-3 rounded-2xl border border-warning bg-warning-soft px-4 py-3 text-sm text-fg"
									role="status"
								>
									<div>
										<p className="font-semibold">Esperando aprobación en el TPV…</p>
										<p className="mt-1 text-xs text-fg-muted">
											Código <span className="font-mono font-bold text-fg">{estado.pairCode}</span>
										</p>
									</div>
									{/* Sin esto, un código equivocado dejaba la pantalla esperando hasta que caducara. */}
									<Button variant="secondary" size="sm" onClick={emparejamiento.cancelar}>
										Cancelar
									</Button>
								</div>
							) : null}

							{estado.step === "paired" ? (
								<div className="rounded-2xl border border-success bg-success-soft px-4 py-3 text-sm text-success" role="status">
									Dispositivo vinculado correctamente.
								</div>
							) : null}

							{error ? (
								<div className="rounded-2xl border border-danger bg-danger-soft px-4 py-3 text-sm text-danger" role="alert">
									{error}
								</div>
							) : null}

							<div className="grid gap-3 sm:grid-cols-[1fr_auto]">
								<Button
									size="lg"
									fullWidth
									loading={ocupado}
									disabled={ocupado}
									leftIcon={<Link2 className="size-5" aria-hidden />}
									onClick={() => emparejamiento.vincular(contenidoQr, codigoManual)}
								>
									Vincular dispositivo
								</Button>

								<Button
									variant="secondary"
									size="lg"
									disabled={ocupado}
									leftIcon={<RotateCcw className="size-4" aria-hidden />}
									onClick={() => {
										setContenidoQr("");
										setCodigoManual("");
										emparejamiento.volverAVincular();
									}}
								>
									Limpiar
								</Button>
							</div>

							<p className="text-center text-xs text-fg-subtle">
								El Handy no podrá utilizarse hasta que el TPV
								principal apruebe la solicitud.
							</p>
						</div>
					</section>
				</Card>
			</div>
		</div>
	);
}
