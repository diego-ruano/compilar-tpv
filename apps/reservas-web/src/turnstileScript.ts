// El script de Turnstile de Cloudflare, cargado una vez por página. Lo usan el widget (`Turnstile.tsx`)
// y la casilla del SDK para los formularios propios (`verificar.ts`).

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

export function cargarTurnstile(): Promise<void> {
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
