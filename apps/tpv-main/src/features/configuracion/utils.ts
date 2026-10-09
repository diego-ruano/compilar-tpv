// src/pages/Configuracion/utils.ts
export function cn(...classes: Array<string | false | undefined | null>) {
	return classes.filter(Boolean).join(" ");
}

export function clampIva(n: number) {
	if (!Number.isFinite(n)) return 10;
	return Math.max(0, Math.min(30, n));
}
