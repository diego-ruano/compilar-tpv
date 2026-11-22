// src/app/arranque/AvisoReloj.tsx
//
// RELOJ-01 — la franja que avisa de que la hora de este equipo se aparta de la de la nube. Hermana de
// `AvisoCaducidad`: cuelga por encima de la aplicación (también del login y de la espera de la Handy)
// y no bloquea nada. Qué se dice y a partir de cuánto, en `relojDesfasado.ts`.
//
// La medida la toma Rust con cada respuesta del worker (en la Main, al menos la consulta de
// interruptores cada 5 minutos; en la Handy, cada petición). Aquí sólo se lee: al montar y cada
// minuto, sin salir a la red.

import React, { useEffect, useState } from "react";
import { commands } from "@tpv/client";

import { esMovil } from "../../shared/lib/plataforma";
import { avisoDelReloj, textoAvisoReloj } from "./relojDesfasado";

const CADA_MS = 60_000;

export default function AvisoReloj() {
	const [desfaseMs, setDesfaseMs] = useState<number | null>(null);

	useEffect(() => {
		let vivo = true;
		const leer = () => {
			commands.relojDesfase()
				.then((r) => {
					if (vivo) setDesfaseMs(r.desfaseMs);
				})
				.catch(() => {
					// Ya lo registró `invocar`. Sin medida no se avisa, y se vuelve a mirar en un minuto.
				});
		};
		leer();
		const temporizador = window.setInterval(leer, CADA_MS);
		return () => {
			vivo = false;
			window.clearInterval(temporizador);
		};
	}, []);

	const aviso = avisoDelReloj(desfaseMs);
	if (!aviso) return null;

	return (
		<div
			className="w-full px-4 py-2 text-center text-sm font-medium bg-warning-soft text-fg border-b border-warning"
			role="status"
		>
			{textoAvisoReloj(aviso, esMovil)}
		</div>
	);
}
