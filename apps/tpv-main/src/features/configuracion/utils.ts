// src/pages/Configuracion/utils.ts
export function cn(...classes: Array<string | false | undefined | null>) {
	return classes.filter(Boolean).join(" ");
}

export function clampIva(n: number) {
	if (!Number.isFinite(n)) return 10;
	return Math.max(0, Math.min(30, n));
}

export function makePairCode() {
	const s = Math.random().toString(36).slice(2, 10).toUpperCase();
	const t = Date.now().toString(36).toUpperCase().slice(-6);
	return `${s}-${t}`;
}