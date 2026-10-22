// src/shared/lib/correo.ts

/** Un correo con forma de correo. Que el buzón exista lo comprueba el código que se le manda después. */
export function correoValido(correo: string): boolean {
	return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(correo.trim());
}
