import { commands } from "@tpv/client";
// src/features/configuracion/sections/CorreoRecuperacion.tsx
//
// El correo de recuperación (LOGIN-08): a dónde llegan los códigos para recuperar el PIN de un
// administrador. Por defecto, el de la compra.
//
// Cambiarlo es un paso de verdad, no un campo que se guarda: se manda un código al correo NUEVO y
// sólo al escribirlo queda cambiado, y se avisa al anterior y al de la compra. Así un correo mal
// escrito no deja al negocio sin forma de recuperar el PIN, y un cambio que no hizo el dueño no pasa
// desapercibido. Todo esto vive en la base central, así que necesita internet.

import { useEffect, useState } from "react";
import { Mail } from "lucide-react";
import { toAppError } from "@tpv/client";

import { Button, Input } from "../../../shared/ui";
import { conAviso } from "../../../shared/lib/conAviso";
import { formatoCuentaAtras, useCuentaAtras } from "../../../shared/lib/useCuentaAtras";
import { Panel } from "../ui/Panel";
import { correoRecuperacionConfirmar, correoRecuperacionSolicitar, type EstadoCorreoRecuperacion } from "../api/correoRecuperacionApis";

type Paso = "ver" | "escribir" | "codigo";

export function CorreoRecuperacion() {
	const [estado, setEstado] = useState<EstadoCorreoRecuperacion | null>(null);
	const [cargando, setCargando] = useState(true);
	const [paso, setPaso] = useState<Paso>("ver");
	const [correo, setCorreo] = useState("");
	const [enviado, setEnviado] = useState<{ emailHint: string; minutos: number } | null>(null);
	const [codigo, setCodigo] = useState("");
	const [ocupado, setOcupado] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [hecho, setHecho] = useState<string | null>(null);
	const [reenvioHasta, setReenvioHasta] = useState<number | null>(null);
	const espera = useCuentaAtras(reenvioHasta);

	useEffect(() => {
		let vivo = true;
		commands.correoRecuperacionEstado()
			.then((e) => {
				if (vivo) setEstado(e);
			})
			.catch((e: unknown) => {
				if (vivo) setError(toAppError(e).message);
			})
			.finally(() => {
				if (vivo) setCargando(false);
			});
		return () => {
			vivo = false;
		};
	}, []);

	const volverAVer = () => {
		setPaso("ver");
		setCorreo("");
		setCodigo("");
		setEnviado(null);
		setError(null);
	};

	const ejecutar = async (fn: () => Promise<void>) => {
		setOcupado(true);
		setError(null);
		setHecho(null);
		try {
			await fn();
		} catch (e) {
			setError(toAppError(e).message);
		} finally {
			setOcupado(false);
		}
	};

	const pedirCodigo = () =>
		ejecutar(async () => {
			const r = await correoRecuperacionSolicitar(correo);
			if (r.sinCambios) {
				volverAVer();
				setHecho("Ese ya es el correo de recuperación.");
				return;
			}
			setEnviado(r);
			setReenvioHasta(Date.now() + r.reenvioSegundos * 1000);
			setCodigo("");
			setPaso("codigo");
		});

	const confirmar = () =>
		ejecutar(async () => {
			const nuevo = await correoRecuperacionConfirmar(codigo);
			setEstado(nuevo);
			volverAVer();
			setHecho(
				nuevo.es_el_de_la_compra
					? "Los códigos vuelven a llegar al correo de la compra."
					: "Correo de recuperación cambiado. Hemos avisado al correo anterior.",
			);
		});

	const volverAlDeLaCompra = () =>
		ejecutar(async () => {
			setEstado(await commands.correoRecuperacionUsarElDeLaCompra());
			setHecho("Los códigos vuelven a llegar al correo de la compra.");
		});

	return (
		<Panel
			title="Correo de recuperación"
			subtitle="A dónde llegan los códigos para recuperar el PIN de un administrador"
		>
			{cargando ? (
				<p className="text-sm text-fg-muted">Cargando…</p>
			) : estado ? (
				<div className="flex flex-col gap-4">
					<div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-surface-2 px-4 py-3">
						<div className="flex min-w-0 items-center gap-2 text-sm">
							<Mail className="size-4 shrink-0 text-accent" aria-hidden />
							<span className="truncate font-mono font-semibold text-fg">
								{estado.email_hint}
							</span>
						</div>
						<span className="rounded-full border border-border px-3 py-1 text-xs font-semibold text-fg-muted">
							{estado.es_el_de_la_compra ? "El de la compra" : "Cambiado"}
						</span>
					</div>

					{paso === "ver" ? (
						<div className="flex flex-wrap gap-2">
							<Button variant="secondary" disabled={ocupado} onClick={() => setPaso("escribir")}>
								Cambiar correo
							</Button>
							{!estado.es_el_de_la_compra ? (
								<Button
									variant="secondary"
									loading={ocupado}
									onClick={conAviso(volverAlDeLaCompra)}
								>
									Volver al de la compra
								</Button>
							) : null}
						</div>
					) : null}

					{paso === "escribir" ? (
						<div className="flex flex-col gap-3">
							<label className="block">
								<span className="text-sm font-semibold text-fg">Correo nuevo</span>
								<Input
									autoFocus
									type="email"
									value={correo}
									onChange={(e) => setCorreo(e.target.value)}
									placeholder="encargado@tubar.com"
									autoComplete="email"
									disabled={ocupado}
									className="mt-1 h-11"
								/>
							</label>
							<p className="text-xs text-fg-muted">
								Te enviaremos un código a ese correo. Hasta que no lo escribas aquí, no
								cambia nada.
							</p>
							<div className="flex flex-wrap gap-2">
								<Button
									loading={ocupado}
									disabled={!correo.trim()}
									onClick={conAviso(pedirCodigo)}
								>
									Enviar código
								</Button>
								<Button variant="secondary" disabled={ocupado} onClick={volverAVer}>
									Cancelar
								</Button>
							</div>
						</div>
					) : null}

					{paso === "codigo" && enviado ? (
						<div className="flex flex-col gap-3">
							<p className="text-sm text-fg-muted">
								Hemos enviado un código a{" "}
								<span className="font-mono font-semibold text-fg">{enviado.emailHint}</span>.
								Caduca en {enviado.minutos} minutos.
							</p>
							<Input
								autoFocus
								value={codigo}
								onChange={(e) => setCodigo(e.target.value.replace(/\D/g, "").slice(0, 6))}
								inputMode="numeric"
								autoComplete="one-time-code"
								placeholder="000000"
								disabled={ocupado}
								className="h-12 max-w-60 text-center text-lg tracking-[0.4em]"
							/>
							<div className="flex flex-wrap gap-2">
								<Button
									loading={ocupado}
									disabled={codigo.length !== 6}
									onClick={conAviso(confirmar)}
								>
									Confirmar
								</Button>
								<Button
									variant="secondary"
									disabled={ocupado || espera > 0}
									onClick={conAviso(pedirCodigo)}
								>
									{espera > 0
										? `Enviar otro código (${formatoCuentaAtras(espera)})`
										: "Enviar otro código"}
								</Button>
								<Button variant="secondary" disabled={ocupado} onClick={volverAVer}>
									Cancelar
								</Button>
							</div>
						</div>
					) : null}

					<p className="text-xs text-fg-subtle">
						Al cambiarlo avisaremos al correo anterior y al de la compra. Trasladar la
						licencia a otro equipo sigue usando siempre el correo de la compra.
					</p>
				</div>
			) : null}

			{error ? (
				<div
					className="mt-4 rounded-xl border border-danger bg-danger-soft px-4 py-3 text-sm text-danger"
					role="alert"
				>
					{error}
				</div>
			) : null}

			{hecho ? (
				<div className="mt-4 rounded-xl border border-success bg-success-soft px-4 py-3 text-sm text-success">
					{hecho}
				</div>
			) : null}
		</Panel>
	);
}
