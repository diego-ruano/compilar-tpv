import { commands } from "@tpv/client";
// src/features/configuracion/sections/AvisoInterruptores.tsx
//
// PROD-06 · Lo que soporte ha apagado desde la nube en este equipo.
//
// No tapa nada ni bloquea nada: explica por qué algo no avanza. Sin esto, con la descarga del
// histórico apagada, la pantalla de conectividad enseñaría un progreso parado y el dueño del bar
// buscaría el problema en su router. Se pinta sólo si hay algo apagado.

import React from "react";

import type { Interruptor, InterruptorApagado } from "@tpv/contracts";

/** Exhaustivo a propósito: un interruptor nuevo sin etiqueta no compila. */
const ETIQUETA: Record<Interruptor, string> = {
	reparacion_nube: "La reparación automática de diferencias con la nube",
	backfill_historico: "La descarga del histórico",
	cifrado_pii: "El cifrado de los datos del personal",
	imagenes: "La subida de imágenes",
	reservas_web: "Las reservas desde la web",
	subida_nube: "La subida de los datos a la nube restaurada",
};

function hasta(ms: number): string {
	return new Date(ms).toLocaleString("es-ES", {
		day: "2-digit",
		month: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
	});
}

export function AvisoInterruptores() {
	const [apagados, setApagados] = React.useState<InterruptorApagado[]>([]);

	React.useEffect(() => {
		let cancelado = false;
		const leer = async () => {
			try {
				const lista = await commands.interruptoresApagados();
				if (!cancelado) setApagados(Array.isArray(lista) ? lista : []);
			} catch {
				// Si no se puede leer no se pinta nada: el aviso es una explicación, no un estado.
				if (!cancelado) setApagados([]);
			}
		};
		void leer();
		// El job pregunta a la nube cada 5 min; mirar cada minuto basta para enterarse pronto.
		const t = window.setInterval(() => void leer(), 60_000);
		return () => {
			cancelado = true;
			clearInterval(t);
		};
	}, []);

	if (!apagados.length) return null;

	return (
		<div className="rounded-2xl border border-warning/40 bg-warning/10 p-4">
			<div className="text-sm font-semibold text-warning">Pausado por soporte</div>
			<ul className="mt-2 flex flex-col gap-2">
				{apagados.map((a) => (
					<li key={a.interruptor} className="text-sm text-fg">
						<strong>{ETIQUETA[a.interruptor] ?? a.interruptor}</strong> está en pausa
						{a.motivo ? <>: {a.motivo}</> : null}. Se reanuda solo, como tarde el{" "}
						{hasta(a.hasta_ms)}.
					</li>
				))}
			</ul>
			<p className="mt-2 text-xs text-fg-muted">
				No se pierde nada: lo pendiente espera en su cola y sale en cuanto se reanude. El TPV
				sigue vendiendo con normalidad.
			</p>
		</div>
	);
}
