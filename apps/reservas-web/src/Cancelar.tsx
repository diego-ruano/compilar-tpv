// Cancelar desde el enlace del correo (§4.8). El token va en el fragmento (`#t=…`), que el navegador
// no manda a ningún servidor, y abrir la página no cancela nada: los filtros de correo abren los
// enlaces, así que hay que pulsar un botón y confirmarlo.

import { useEffect, useRef, useState } from "react";
import { nombreDeMesa } from "@tpv/plano/nombre";

import { ErrorReservas, type ReservasWeb, type ResumenReserva } from "@altarialights/reservas-web-tpv";

import { diaLargo, personasTexto } from "./logica";
import { Aviso, Boton, Cargando } from "./ui";

export default function Cancelar({ api, token, negocio }: { api: ReservasWeb; token: string | null; negocio: string }) {
	const [resumen, setResumen] = useState<ResumenReserva | null>(null);
	const [error, setError] = useState<string | null>(null);
	// Si no se ha podido leer la reserva: un enlace que no vale no vale al segundo intento; un fallo de
	// red o del servidor, quizá sí, y se ofrece «Reintentar» sin recargar la página.
	const [errorCarga, setErrorCarga] = useState<{ mensaje: string; reintentable: boolean } | null>(null);
	const [intento, setIntento] = useState(0);
	const [confirmando, setConfirmando] = useState(false);
	const [ocupado, setOcupado] = useState(false);
	// Al pedir la confirmación, al decir que no y al cancelar desaparece el botón que tenía el foco: va al
	// «No» (lo que no rompe nada si se pulsa sin querer), al botón de antes o al título.
	const titulo = useRef<HTMLHeadingElement | null>(null);
	const abrir = useRef<HTMLButtonElement | null>(null);
	const no = useRef<HTMLButtonElement | null>(null);
	const confirmandoEnfocado = useRef(confirmando);
	const estado = resumen?.estado;
	useEffect(() => {
		if (confirmandoEnfocado.current === confirmando) return;
		confirmandoEnfocado.current = confirmando;
		if (confirmando) no.current?.focus();
		else (estado === "cancelada" ? titulo.current : abrir.current)?.focus();
	}, [confirmando, estado]);

	useEffect(() => {
		if (!token) {
			setErrorCarga({ mensaje: "Este enlace no es válido o ha caducado.", reintentable: false });
			return;
		}
		let vivo = true;
		api.consultarReserva(token).then(
			(r) => vivo && setResumen(r),
			(e) =>
				vivo &&
				setErrorCarga({
					mensaje: e instanceof ErrorReservas ? e.message : "Algo ha fallado. Vuelve a intentarlo.",
					reintentable: !(e instanceof ErrorReservas && e.codigo === "enlace_no_valido"),
				}),
		);
		return () => {
			vivo = false;
		};
	}, [api, token, intento]);

	async function cancelar() {
		if (!token || !resumen) return;
		setOcupado(true);
		setError(null);
		try {
			await api.cancelarReserva(token);
			setResumen({ ...resumen, estado: "cancelada", cancelable: false });
			setConfirmando(false);
		} catch (e) {
			setError(e instanceof ErrorReservas ? e.message : "Algo ha fallado. Vuelve a intentarlo.");
		} finally {
			setOcupado(false);
		}
	}

	if (!resumen) {
		if (!errorCarga) return <Cargando />;
		return (
			<div className="space-y-3">
				<Aviso>{errorCarga.mensaje}</Aviso>
				{errorCarga.reintentable ? (
					<Boton
						onClick={() => {
							setErrorCarga(null);
							setIntento((n) => n + 1);
						}}
					>
						Reintentar
					</Boton>
				) : null}
			</div>
		);
	}

	return (
		<section aria-label="Tu reserva" className="space-y-3">
			<h2 ref={titulo} tabIndex={-1} className="text-base font-bold outline-none">
				Tu reserva en {negocio}
			</h2>
			<div className="text-sm font-semibold capitalize">
				{diaLargo(resumen.dia)} · {resumen.hora}
			</div>
			<div className="text-sm">
				{personasTexto(resumen.personas)}
				{resumen.mesa_nombre ? ` · ${nombreDeMesa(resumen.mesa_nombre)}` : ""}
			</div>
			{error ? <Aviso>{error}</Aviso> : null}
			{/* Una región que ya estaba: lo que cambie dentro (también «Esta reserva está cancelada») se anuncia. */}
			<div aria-live="polite">
				{resumen.estado === "cancelada" ? (
					<Aviso tono="success">Esta reserva está cancelada.</Aviso>
				) : resumen.estado === "pasada" || !resumen.cancelable ? (
					<Aviso tono="warning">Esta reserva ya no se puede cancelar por internet. Si lo necesitas, llama al restaurante.</Aviso>
				) : confirmando ? (
					<div className="space-y-2">
						<div className="text-sm">¿Seguro que quieres cancelarla?</div>
						<div className="flex gap-2">
							<Boton variante="peligro" disabled={ocupado} onClick={() => void cancelar()}>
								{ocupado ? "Cancelando…" : "Sí, cancelarla"}
							</Boton>
							<Boton ref={no} variante="secundario" disabled={ocupado} onClick={() => setConfirmando(false)}>
								No
							</Boton>
						</div>
					</div>
				) : (
					<Boton ref={abrir} variante="peligro" onClick={() => setConfirmando(true)}>
						Cancelar la reserva
					</Boton>
				)}
			</div>
		</section>
	);
}
