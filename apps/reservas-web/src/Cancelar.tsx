// Cancelar desde el enlace del correo (§4.8). El token va en el fragmento (`#t=…`), que el navegador
// no manda a ningún servidor, y abrir la página no cancela nada: los filtros de correo abren los
// enlaces, así que hay que pulsar un botón y confirmarlo.

import { useEffect, useState } from "react";

import type { Api, Resumen } from "./api";
import { ErrorApi } from "./api";
import { diaLargo, personasTexto } from "./logica";
import { Aviso, Boton, Cargando } from "./ui";

export default function Cancelar({ api, token, negocio }: { api: Api; token: string | null; negocio: string }) {
	const [resumen, setResumen] = useState<Resumen | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [confirmando, setConfirmando] = useState(false);
	const [ocupado, setOcupado] = useState(false);

	useEffect(() => {
		if (!token) {
			setError("Este enlace no es válido o ha caducado.");
			return;
		}
		let vivo = true;
		api.reserva(token).then(
			(r) => vivo && setResumen(r),
			(e) => vivo && setError(e instanceof ErrorApi ? e.message : "Algo ha fallado. Vuelve a intentarlo."),
		);
		return () => {
			vivo = false;
		};
	}, [api, token]);

	async function cancelar() {
		if (!token || !resumen) return;
		setOcupado(true);
		setError(null);
		try {
			await api.cancelar(token);
			setResumen({ ...resumen, estado: "cancelada", cancelable: false });
			setConfirmando(false);
		} catch (e) {
			setError(e instanceof ErrorApi ? e.message : "Algo ha fallado. Vuelve a intentarlo.");
		} finally {
			setOcupado(false);
		}
	}

	if (!resumen) return error ? <Aviso>{error}</Aviso> : <Cargando />;

	return (
		<section aria-label="Tu reserva" className="space-y-3">
			<h2 className="text-base font-bold">Tu reserva en {negocio}</h2>
			<div className="text-sm font-semibold capitalize">
				{diaLargo(resumen.dia)} · {resumen.hora}
			</div>
			<div className="text-sm">
				{personasTexto(resumen.personas)}
				{resumen.mesa ? ` · Mesa ${resumen.mesa}` : ""}
			</div>
			{error ? <Aviso>{error}</Aviso> : null}
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
						<Boton variante="secundario" disabled={ocupado} onClick={() => setConfirmando(false)}>
							No
						</Boton>
					</div>
				</div>
			) : (
				<Boton variante="peligro" onClick={() => setConfirmando(true)}>
					Cancelar la reserva
				</Boton>
			)}
		</section>
	);
}
