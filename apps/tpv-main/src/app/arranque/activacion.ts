// src/app/arranque/activacion.ts
//
// Cuándo el formulario de activación de la licencia está listo para enviarse. Sin React, porque es la
// única regla de esa pantalla que no es marcado, y se prueba en `test/arranque.test.ts`.

export type FormularioActivacion = {
	licenseKey: string;
	legal_name: string;
	business_name: string;
	phone: string;
	country: string;
};

export const FORMULARIO_VACIO: FormularioActivacion = {
	licenseKey: "",
	legal_name: "",
	business_name: "",
	phone: "",
	country: "",
};

/** Un correo con forma de correo. Que el buzón exista lo comprueba el código que se le manda después. */
export function correoValido(correo: string): boolean {
	return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(correo.trim());
}

/**
 * Todos los campos rellenos; si no se usa el correo de la compra, uno válido (LOGIN-08); y si la
 * licencia está en otro equipo, el código de 6 cifras que llegó al correo.
 */
export function activacionCompleta(p: {
	formulario: FormularioActivacion;
	usarCorreoCompra: boolean;
	correoRecuperacion: string;
	enCambioDeEquipo: boolean;
	codigoCambio: string;
}): boolean {
	const f = p.formulario;
	const camposRellenos = [f.licenseKey, f.legal_name, f.business_name, f.phone, f.country].every(
		(v) => v.trim().length > 0,
	);
	const correoOk = p.usarCorreoCompra || correoValido(p.correoRecuperacion);
	const codigoOk = !p.enCambioDeEquipo || p.codigoCambio.trim().length === 6;
	return camposRellenos && correoOk && codigoOk;
}
