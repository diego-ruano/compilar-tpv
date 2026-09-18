// src/app/arranque/HandyEsperandoMain.tsx
//
// Un Handy emparejado sin una Main activa no trabaja (ni siquiera el login): esta es la espera.
//
// Y la espera tiene dos formas muy distintas, que antes se veían igual. Unas terminan solas —la
// Main está apagada, o subiendo su atraso, o la red va mal— y para ésas lo correcto es un spinner y
// «Conectando…». Otras no van a terminar nunca porque la nube ha dicho que no a ESTE Handy: le han
// revocado el acceso, o la licencia del negocio no está activa. Ahí un spinner es mentira: hace
// esperar a alguien por algo que no va a pasar, y le esconde lo único que lo arregla.

import React from "react";

import type { MotivoRechazo } from "../../shared/stores/useMainPresence";

export default function HandyEsperandoMain({
	conectando,
	volcando,
	rechazo,
	onReintentar,
	onIrAVinculacion,
}: {
	conectando: boolean;
	/** SYNC-18: hay Main, pero está subiendo su atraso. Es una espera con final, no una avería. */
	volcando: boolean;
	/** La nube rechaza a este Handy. No es una espera: es algo que hay que ir a arreglar. */
	rechazo: MotivoRechazo | null;
	onReintentar: () => void;
	onIrAVinculacion: () => void;
}) {
	const { titulo, texto } = mensaje({ conectando, volcando, rechazo });
	// Volver a vincular es la salida del dispositivo rechazado, así que ahí es la acción principal;
	// en todo lo demás, lo que se espera es que la conexión vuelva.
	const vincularEsLoPrincipal = rechazo === "dispositivo";

	return (
		<div className="relative min-h-full w-full bg-slate-100 flex items-center justify-center p-6">
			<div className="w-full max-w-md rounded-2xl bg-white shadow-sm border border-slate-200 p-6 text-center">
				{rechazo ? (
					<div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-full bg-amber-100 text-2xl text-amber-700">
						!
					</div>
				) : (
					<div className="mx-auto mb-4 size-12 rounded-full border-4 border-slate-200 border-t-[#016FFC] animate-spin" />
				)}
				<h1 className="text-xl font-semibold text-slate-900">{titulo}</h1>
				<p className="text-sm text-slate-600 mt-2">{texto}</p>

				<div className="mt-6 flex flex-col items-center gap-2">
					<button
						type="button"
						onClick={vincularEsLoPrincipal ? onIrAVinculacion : onReintentar}
						className="w-full rounded-xl bg-[#016FFC] px-4 py-2.5 text-sm font-semibold text-white hover:bg-[#2B81D4]"
					>
						{vincularEsLoPrincipal ? "Vincular de nuevo" : "Reintentar conexión"}
					</button>
					<button
						type="button"
						onClick={vincularEsLoPrincipal ? onReintentar : onIrAVinculacion}
						className="rounded-xl border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-800 hover:bg-slate-50"
					>
						{vincularEsLoPrincipal ? "Reintentar conexión" : "← Ir a vinculación"}
					</button>
				</div>
			</div>
		</div>
	);
}

/**
 * Qué se le cuenta al camarero. El orden importa: un rechazo manda sobre cualquier espera, porque
 * mientras exista no hay nada que esperar.
 */
function mensaje(e: { conectando: boolean; volcando: boolean; rechazo: MotivoRechazo | null }): {
	titulo: string;
	texto: string;
} {
	if (e.rechazo === "dispositivo") {
		return {
			titulo: "Este dispositivo ya no tiene acceso",
			texto:
				"El punto de venta principal ha retirado el acceso a esta Handy, o se ha vinculado a otro negocio. Para volver a usarla, vincúlala de nuevo con un código del TPV principal.",
		};
	}

	if (e.rechazo === "licencia") {
		return {
			titulo: "La licencia del negocio no está activa",
			texto:
				"La nube no deja conectar a este dispositivo porque la licencia está caducada o anulada. Se arregla en el punto de venta principal; en cuanto vuelva a estar activa, esta Handy se conecta sola.",
		};
	}

	if (e.volcando) {
		return {
			titulo: "Haciendo copia de seguridad",
			texto:
				"En breve podrás conectarte. El punto de venta principal está guardando lo que hizo sin conexión; en cuanto termine, este Handy se desbloquea solo.",
		};
	}

	if (e.conectando) {
		return {
			titulo: "Conectando con la Main…",
			texto: "Estableciendo conexión con el punto de venta principal.",
		};
	}

	return {
		titulo: "La Main no está activa",
		texto:
			"Este Handy no puede usarse mientras el punto de venta principal esté apagado o en modo offline. Volverá a estar disponible en cuanto la Main se active.",
	};
}
