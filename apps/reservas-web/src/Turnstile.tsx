// Turnstile de Cloudflare: lo que dice que quien reserva es una persona. El token es de un solo uso;
// tras un intento de alta, se pide otro (`reiniciar`).

import { useEffect, useImperativeHandle, useRef, type Ref } from "react";

declare global {
	interface Window {
		turnstile?: {
			render: (el: HTMLElement, opciones: Record<string, unknown>) => string;
			reset: (id: string) => void;
			remove: (id: string) => void;
		};
	}
}

const SCRIPT = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
let cargando: Promise<void> | null = null;

function cargarScript(): Promise<void> {
	if (window.turnstile) return Promise.resolve();
	if (!cargando) {
		cargando = new Promise<void>((resolver, rechazar) => {
			const s = document.createElement("script");
			s.src = SCRIPT;
			s.async = true;
			s.onload = () => resolver();
			s.onerror = () => {
				cargando = null;
				rechazar(new Error("turnstile"));
			};
			document.head.appendChild(s);
		});
	}
	return cargando;
}

export type ControlTurnstile = { reiniciar: () => void };

export default function Turnstile({
	clave,
	onToken,
	onFallo,
	ref,
}: {
	clave: string;
	onToken: (token: string | null) => void;
	onFallo: () => void;
	ref?: Ref<ControlTurnstile>;
}) {
	const hueco = useRef<HTMLDivElement | null>(null);
	const id = useRef<string | null>(null);
	// Lo último de los props, para no volver a montar el widget cada vez que cambian.
	const avisos = useRef({ onToken, onFallo });
	avisos.current = { onToken, onFallo };

	useImperativeHandle(ref, () => ({
		reiniciar: () => {
			avisos.current.onToken(null);
			if (id.current && window.turnstile) window.turnstile.reset(id.current);
		},
	}));

	useEffect(() => {
		let vivo = true;
		cargarScript()
			.then(() => {
				if (!vivo || !hueco.current || !window.turnstile) return;
				id.current = window.turnstile.render(hueco.current, {
					sitekey: clave,
					language: "es",
					callback: (token: string) => avisos.current.onToken(token),
					"expired-callback": () => avisos.current.onToken(null),
					"error-callback": () => avisos.current.onFallo(),
				});
			})
			.catch(() => {
				if (vivo) avisos.current.onFallo();
			});
		return () => {
			vivo = false;
			if (id.current && window.turnstile) window.turnstile.remove(id.current);
			id.current = null;
		};
	}, [clave]);

	return <div ref={hueco} className="min-h-[65px]" />;
}
