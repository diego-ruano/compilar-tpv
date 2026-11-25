// src/app/arranque/LicenciaBloqueada.tsx
//
// La Main no puede trabajar porque la licencia no lo permite: por qué, y qué se puede hacer.

import { textoBloqueo } from "./textosLicencia";

export default function LicenciaBloqueada({
	motivo,
	error,
	onReintentar,
	onBorrar,
}: {
	motivo: string;
	/** Lo que falló al borrar la licencia. Sin esto, el botón fallaba y la pantalla no decía nada. */
	error: string | null;
	onReintentar: () => void;
	onBorrar: () => void;
}) {
	const { titulo, cuerpo } = textoBloqueo(motivo);
	return (
		<div className="min-h-full w-full bg-slate-100 flex items-center justify-center p-6">
			<div className="w-full max-w-lg rounded-2xl bg-white shadow-sm border border-slate-200 p-6">
				<h1 className="text-2xl font-semibold text-slate-900">{titulo}</h1>
				<p className="text-sm text-slate-600 mt-2">{cuerpo}</p>

				<div className="mt-5 flex gap-3">
					<button
						onClick={onReintentar}
						className="flex-1 rounded-xl bg-[#016FFC] text-white py-3 font-semibold hover:bg-[#2B81D4]"
					>
						Reintentar comprobación
					</button>
					<button
						onClick={onBorrar}
						className="rounded-xl border border-slate-300 bg-white py-3 px-4 font-semibold text-slate-700 hover:bg-slate-50"
					>
						Borrar y volver a activar
					</button>
				</div>

				{error ? (
					<p className="mt-4 text-sm text-red-600" role="alert">
						{error}
					</p>
				) : null}

				<p className="mt-4 font-mono text-xs text-slate-400">{motivo}</p>
			</div>
		</div>
	);
}
