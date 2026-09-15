// src/app/arranque/HandyEsperandoMain.tsx
//
// Un Handy emparejado sin una Main activa no trabaja (ni siquiera el login): esta es la espera.

import React from "react";

export default function HandyEsperandoMain({
	conectando,
	volcando,
	onReintentar,
	onIrAVinculacion,
}: {
	conectando: boolean;
	/** SYNC-18: hay Main, pero está subiendo su atraso. Es una espera con final, no una avería. */
	volcando: boolean;
	onReintentar: () => void;
	onIrAVinculacion: () => void;
}) {
	return (
		<div className="relative min-h-full w-full bg-slate-100 flex items-center justify-center p-6">
			<div className="w-full max-w-md rounded-2xl bg-white shadow-sm border border-slate-200 p-6 text-center">
				<div className="mx-auto mb-4 size-12 rounded-full border-4 border-slate-200 border-t-[#016FFC] animate-spin" />
				<h1 className="text-xl font-semibold text-slate-900">
					{volcando
						? "Haciendo copia de seguridad"
						: conectando
							? "Conectando con la Main…"
							: "La Main no está activa"}
				</h1>
				<p className="text-sm text-slate-600 mt-2">
					{volcando
						? "En breve podrás conectarte. El punto de venta principal está guardando lo que hizo sin conexión; en cuanto termine, este Handy se desbloquea solo."
						: conectando
							? "Estableciendo conexión con el punto de venta principal."
							: "Este Handy no puede usarse mientras el punto de venta principal esté apagado o en modo offline. Volverá a estar disponible en cuanto la Main se active."}
				</p>

				<div className="mt-6 flex flex-col items-center gap-2">
					<button
						type="button"
						onClick={onReintentar}
						className="w-full rounded-xl bg-[#016FFC] px-4 py-2.5 text-sm font-semibold text-white hover:bg-[#2B81D4]"
					>
						Reintentar conexión
					</button>
					<button
						type="button"
						onClick={onIrAVinculacion}
						className="rounded-xl border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-800 hover:bg-slate-50"
					>
						← Ir a vinculación
					</button>
				</div>
			</div>
		</div>
	);
}
