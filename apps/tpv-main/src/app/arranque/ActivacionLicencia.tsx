import { commands } from "@tpv/client";
// src/app/arranque/ActivacionLicencia.tsx
//
// Activar la licencia de la Main: la clave, los datos del negocio y, si la licencia ya está en otro
// equipo, el código que llega al correo para moverla.

import React, { useState } from "react";
import { toAppError } from "@tpv/client";
import type { LicenseActivateOutcome_Serialize as LicenseActivateOutcome } from "@tpv/contracts";
import { Building2, KeyRound, MapPin, Phone, ShieldCheck, Store } from "lucide-react";

import { conAviso } from "../../shared/lib/conAviso";
import { limpiarSesionLocal } from "../../shared/stores/useAuth";
import { Badge, Button, Card, Input } from "../../shared/ui";
import { activacionCompleta, estadoDelFormulario, FORMULARIO_VACIO } from "./activacion";
import { avisoDeClave, EJEMPLO_CLAVE } from "../../shared/lib/claveLicencia";
import FondoDecorado from "./FondoDecorado";
import { textoRechazoPrevio } from "./textosLicencia";

/**
 * Por qué se está aquí, cuando no es un primer arranque. Un rechazo del servidor borra el estado
 * local a propósito, así que tras reiniciar esta pantalla es idéntica a la de un TPV recién instalado
 * — y quien llega no sabe si le han anulado la licencia, si se la han movido a otro equipo, o si tocó
 * algo.
 */
function RechazoPrevio({ motivo }: { motivo: string | null }) {
	const aviso = textoRechazoPrevio(motivo);
	if (!aviso) return null;

	return (
		<div className="mt-4 rounded-2xl border border-warning bg-warning/10 px-4 py-3">
			<p className="text-sm font-semibold text-fg">{aviso.titulo}</p>
			<p className="mt-1 text-xs leading-relaxed text-fg-muted">{aviso.cuerpo}</p>
		</div>
	);
}

/** AUD-06 · Lo que se enseña antes de que el TPV se reinicie por una licencia de otro negocio. */
export const AVISO_DE_REINICIO =
	"Esta licencia es de otro negocio. Guardamos aparte los datos del anterior y el TPV se reinicia.";

export default function ActivacionLicencia({
	rechazoPrevio,
	volviendo,
	errorAlVolver,
	onOlvidarErrorAlVolver,
	onVolver,
	onActivada,
}: {
	rechazoPrevio: string | null;
	volviendo: boolean;
	errorAlVolver: string | null;
	/** El error de «Volver» es de la pantalla de arranque: «Limpiar» le pide que lo quite. */
	onOlvidarErrorAlVolver: () => void;
	onVolver: () => Promise<void>;
	/** La licencia ya está activa: la Main vuelve a leerla y a pedir el veredicto del gate. */
	onActivada: () => Promise<void>;
}) {
	const [act, setAct] = useState(FORMULARIO_VACIO);
	// LIC-INC-02: una clave mal escrita se avisa al dejar el campo, sin esperar a pulsar «Activar».
	const [claveTerminada, setClaveTerminada] = useState(false);
	const [enviando, setEnviando] = useState(false);
	const [error, setError] = useState<string | null>(null);

	// REV-13: el código no ha estrenado nada, le ha sumado tiempo a la licencia que ya había. Se
	// enseña y se espera a que pulsen, en vez de seguir de largo: quien acaba de pagar tiene que
	// ver que los meses han entrado — si la pantalla pasara sola, no sabría si se aplicó.
	const [sumado, setSumado] = useState<string | null>(null);

	// AUD-06: la licencia es de otro negocio que los datos de este ordenador. Ha quedado pendiente:
	// el backend se reinicia solo en unos segundos y, al arrancar, guarda aparte los datos del
	// anterior y la aplica. Aquí sólo se avisa: no se sigue a ninguna pantalla con lo que hay ahora.
	const [reiniciando, setReiniciando] = useState(false);

	// Cambio de dispositivo: si la licencia ya está en otro equipo, el servidor pide un
	// código de 6 dígitos que le llega al email. `hint` (p. ej. `a***@bar.com`) != null significa
	// que estamos en ese paso.
	const [deviceChangeHint, setDeviceChangeHint] = useState<string | null>(null);
	const [deviceChangeCode, setDeviceChangeCode] = useState("");
	const [otpSending, setOtpSending] = useState(false);

	const enDeviceChange = deviceChangeHint !== null;
	const ocupado = enviando || volviendo;

	const estadoFormulario = {
		formulario: act,
		enCambioDeEquipo: enDeviceChange,
		codigoCambio: deviceChangeCode,
	};
	const activationValid = activacionCompleta(estadoFormulario);
	const avisoClave = avisoDeClave(act.licenseKey, claveTerminada);

	// Pide (o reenvía) el código de cambio de dispositivo al email de la licencia.
	async function requestDeviceChangeCode() {
		setOtpSending(true);
		setError(null);
		try {
			await commands.licenseRequestDeviceChange({ activation_key: act.licenseKey });
		} catch (e: any) {
			setError(toAppError(e).message);
		} finally {
			setOtpSending(false);
		}
	}

	async function submitActivation(e: React.FormEvent) {
		e.preventDefault();

		if (enviando) return;

		setEnviando(true);
		setError(null);

		try {
			const outcome = await commands.licenseActivate({
					activation_key: act.licenseKey,
					business_name: act.business_name,
					legal_name: act.legal_name,
					phone: act.phone,
					country: act.country,
					device_change_code: enDeviceChange ? deviceChangeCode.trim() : undefined,
				});

			// La licencia ya está en otro equipo: entramos en el paso de cambio de dispositivo y
			// disparamos el envío del código al email de la licencia.
			if (outcome.outcome === "device_change_required") {
				setDeviceChangeHint(outcome.email_hint ?? "");
				await requestDeviceChangeCode();
				return;
			}

			setDeviceChangeHint(null);
			setDeviceChangeCode("");

			// AUD-06: la base del equipo deja de ser la que había (es de otro negocio, o de antes de un
			// traslado). Se retira la sesión de la pantalla y lo que tenga en caché, que se leyó de esa
			// base. La del backend, si la hay, acaba con el reinicio o con la reconstrucción.
			if (outcome.cambio_de_equipo) limpiarSesionLocal();

			if (outcome.reinicia) {
				setReiniciando(true);
				return;
			}

			if (outcome.tiempo_sumado) {
				// No hay nada que configurar: el negocio, el PIN y el correo son los de siempre.
				setSumado(outcome.state?.expires_at ?? null);
				return;
			}

			await onActivada();
		} catch (e: any) {
			setError(toAppError(e).message);
		} finally {
			setEnviando(false);
		}
	}

	const errorVisible = error ?? errorAlVolver;

	if (reiniciando) {
		return (
			<div className="relative flex min-h-full w-full items-center justify-center bg-bg p-4 text-fg sm:p-6 lg:p-10">
				<FondoDecorado />
				<div role="status" className="relative w-full max-w-md rounded-2xl border border-border bg-bg-elev p-6 text-center shadow-lg">
					<p className="text-lg font-semibold text-fg">{AVISO_DE_REINICIO}</p>
					<p className="mt-2 text-sm leading-relaxed text-fg-muted">
						No apagues el ordenador. Al volver, el TPV trae de la nube los datos de esta licencia.
					</p>
				</div>
			</div>
		);
	}

	if (sumado !== null) {
		const hasta = (() => {
			const d = new Date(sumado);
			return Number.isNaN(d.getTime())
				? null
				: d.toLocaleDateString("es-ES", { day: "numeric", month: "long", year: "numeric" });
		})();

		return (
			<div className="relative flex min-h-full w-full items-center justify-center bg-bg p-4 text-fg sm:p-6 lg:p-10">
				<FondoDecorado />
				<div className="relative w-full max-w-md rounded-2xl border border-border bg-bg-elev p-6 text-center shadow-lg">
					<p className="text-lg font-semibold text-fg">Tiempo añadido</p>
					<p className="mt-2 text-sm leading-relaxed text-fg-muted">
						El código se ha sumado a la licencia que ya tenías.
						{hasta ? <> Ahora vence el <strong className="text-fg">{hasta}</strong>.</> : null}
					</p>
					<p className="mt-2 text-xs leading-relaxed text-fg-muted">
						No cambia nada más: tus datos, tu PIN y tus dispositivos siguen igual.
					</p>
					<Button className="mt-5 w-full" onClick={conAviso(onActivada)}>
						Continuar
					</Button>
				</div>
			</div>
		);
	}

	return (
		<div className="relative flex min-h-full w-full items-center justify-center overflow-hidden bg-bg p-4 text-fg sm:p-6 lg:p-10">
			<FondoDecorado />

			<div className="relative w-full max-w-6xl">
				<div className="mb-4 flex items-center justify-between gap-3">
					<Button variant="secondary" size="sm" disabled={ocupado} onClick={conAviso(onVolver)}>
						← Volver
					</Button>
					<Badge tone={activationValid ? "success" : "warning"}>
						{estadoDelFormulario(estadoFormulario)}
					</Badge>
				</div>

				<Card padded={false} className="grid overflow-hidden rounded-3xl shadow-xl lg:grid-cols-[0.8fr_1.2fr]">
					<section className="flex flex-col justify-between border-b border-border bg-surface-2 p-6 sm:p-8 lg:border-b-0 lg:border-r">
						<div>
							<div className="flex items-center justify-between gap-3">
								<div className="grid size-14 place-items-center rounded-2xl bg-accent-soft text-accent">
									<ShieldCheck className="size-7" aria-hidden />
								</div>
								<Badge tone="accent">TPV principal</Badge>
							</div>

							<h1 className="mt-6 text-2xl font-bold tracking-tight text-fg sm:text-3xl">Activa tu TPV</h1>
							<p className="mt-3 text-sm leading-relaxed text-fg-muted sm:text-base">
								Introduce tu licencia y los datos principales
								del negocio para preparar este equipo como
								punto de venta principal.
							</p>

							<div className="mt-7 space-y-4">
								<div className="flex gap-3">
									<div className="grid size-9 shrink-0 place-items-center rounded-xl bg-surface text-accent shadow-sm">
										<KeyRound className="size-4" aria-hidden />
									</div>
									<div>
										<p className="text-sm font-semibold text-fg">Valida tu licencia</p>
										<p className="mt-0.5 text-xs leading-relaxed text-fg-muted">
											La clave identifica la suscripción de tu negocio.
										</p>
									</div>
								</div>

								<div className="flex gap-3">
									<div className="grid size-9 shrink-0 place-items-center rounded-xl bg-surface text-accent shadow-sm">
										<Building2 className="size-4" aria-hidden />
									</div>
									<div>
										<p className="text-sm font-semibold text-fg">Registra el establecimiento</p>
										<p className="mt-0.5 text-xs leading-relaxed text-fg-muted">
											Estos datos identificarán el negocio dentro del TPV.
										</p>
									</div>
								</div>
							</div>
						</div>

						<div className="mt-8 flex items-center gap-2 rounded-2xl border border-border bg-surface px-4 py-3 text-xs text-fg-muted">
							<ShieldCheck className="size-4 shrink-0 text-success" aria-hidden />
							La activación requiere conexión a internet.
						</div>
					</section>

					<section className="p-6 sm:p-8">
						<div className="flex items-center gap-3">
							<div className="grid size-10 place-items-center rounded-xl bg-accent-soft text-accent">
								<Store className="size-5" aria-hidden />
							</div>
							<div>
								<h2 className="text-lg font-bold text-fg">Licencia y negocio</h2>
								<p className="text-sm text-fg-muted">Todos los campos son obligatorios.</p>
							</div>
						</div>

						<RechazoPrevio motivo={rechazoPrevio} />

						<form onSubmit={conAviso(submitActivation)} className="mt-6 grid gap-5">
							<div>
								<label htmlFor="activation-license-key" className="text-sm font-semibold text-fg">
									Clave de licencia
								</label>
								<Input
									id="activation-license-key"
									autoFocus
									value={act.licenseKey}
									onChange={(e) => setAct((s) => ({ ...s, licenseKey: e.target.value }))}
									onBlur={() => setClaveTerminada(true)}
									className="mt-2 h-12 px-4 font-mono uppercase tracking-wider"
									placeholder={EJEMPLO_CLAVE}
									autoComplete="off"
									aria-invalid={avisoClave ? true : undefined}
								/>
								{avisoClave ? (
									<p className="mt-2 text-sm text-danger" role="alert">
										{avisoClave}
									</p>
								) : null}
							</div>

							<div className="grid gap-4 sm:grid-cols-2">
								<div>
									<label htmlFor="activation-legal-name" className="text-sm font-semibold text-fg">
										Nombre legal
									</label>
									<Input
										id="activation-legal-name"
										value={act.legal_name}
										onChange={(e) => setAct((s) => ({ ...s, legal_name: e.target.value }))}
										className="mt-2 h-12 px-4"
										placeholder="ALTARIA LIGHTS S.L."
										autoComplete="organization"
									/>
								</div>

								<div>
									<label htmlFor="activation-business-name" className="text-sm font-semibold text-fg">
										Nombre del negocio
									</label>
									<Input
										id="activation-business-name"
										value={act.business_name}
										onChange={(e) => setAct((s) => ({ ...s, business_name: e.target.value }))}
										className="mt-2 h-12 px-4"
										placeholder="Bar La Plaza"
										autoComplete="organization"
									/>
								</div>
							</div>

							<div className="grid gap-4 sm:grid-cols-2">
								<div>
									<label htmlFor="activation-phone" className="flex items-center gap-2 text-sm font-semibold text-fg">
										<Phone className="size-4 text-accent" aria-hidden />
										Número de teléfono
									</label>
									<Input
										id="activation-phone"
										type="tel"
										value={act.phone}
										onChange={(e) => setAct((s) => ({ ...s, phone: e.target.value }))}
										className="mt-2 h-12 px-4"
										placeholder="+34 600 000 000"
										autoComplete="tel"
									/>
								</div>

								<div>
									<label htmlFor="activation-country" className="flex items-center gap-2 text-sm font-semibold text-fg">
										<MapPin className="size-4 text-accent" aria-hidden />
										País
									</label>
									<Input
										id="activation-country"
										value={act.country}
										onChange={(e) => setAct((s) => ({ ...s, country: e.target.value }))}
										className="mt-2 h-12 px-4"
										placeholder="España"
										autoComplete="country-name"
									/>
								</div>
							</div>

							{enDeviceChange ? (
								<div className="rounded-2xl border border-accent bg-accent-soft px-4 py-4">
									<p className="text-sm font-semibold text-fg">Esta licencia ya está activa en otro equipo</p>
									<p className="mt-1 text-xs leading-relaxed text-fg-muted">
										Te hemos enviado un código de 6 dígitos a{" "}
										<span className="font-mono font-semibold text-fg">{deviceChangeHint || "tu correo"}</span>
										. Introdúcelo para mover la licencia a este
										ordenador. El equipo anterior dejará de
										funcionar.
									</p>

									<Input
										id="activation-device-code"
										value={deviceChangeCode}
										onChange={(e) => setDeviceChangeCode(e.target.value.replace(/[^\d]/g, "").slice(0, 6))}
										className="mt-3 h-14 px-4 text-center font-mono text-xl font-bold tracking-[0.35em]"
										placeholder="000000"
										inputMode="numeric"
										autoComplete="one-time-code"
										maxLength={6}
									/>

									<button
										type="button"
										onClick={conAviso(requestDeviceChangeCode)}
										disabled={otpSending}
										className="mt-2 text-xs font-semibold text-accent hover:underline disabled:opacity-50"
									>
										{otpSending ? "Enviando…" : "Reenviar código"}
									</button>
								</div>
							) : null}

							{errorVisible ? (
								<pre
									className="whitespace-pre-wrap rounded-2xl border border-danger bg-danger-soft px-4 py-3 text-sm text-danger"
									role="alert"
								>
									{errorVisible}
								</pre>
							) : null}

							<div className="grid gap-3 sm:grid-cols-[auto_1fr]">
								<Button
									variant="secondary"
									size="lg"
									disabled={ocupado}
									onClick={() => {
										// LIC-INC-02: limpiar es empezar de cero, también sin el error de antes.
										setAct(FORMULARIO_VACIO);
										setClaveTerminada(false);
										setError(null);
										onOlvidarErrorAlVolver();
										setDeviceChangeHint(null);
										setDeviceChangeCode("");
									}}
								>
									Limpiar
								</Button>

								<Button
									type="submit"
									size="lg"
									fullWidth
									loading={ocupado}
									disabled={!activationValid}
									leftIcon={<ShieldCheck className="size-5" aria-hidden />}
								>
									{enDeviceChange ? "Confirmar y activar" : "Activar TPV"}
								</Button>
							</div>
						</form>
					</section>
				</Card>
			</div>
		</div>
	);
}
