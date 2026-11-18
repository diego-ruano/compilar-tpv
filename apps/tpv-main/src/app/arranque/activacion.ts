// src/app/arranque/activacion.ts
//
// Cuándo el formulario de activación de la licencia está listo para enviarse. Sin React, porque es la
// única regla de esa pantalla que no es marcado, y se prueba en `test/arranque.test.ts`.

import { claveCanonica } from "../../shared/lib/claveLicencia";

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

/**
 * Todos los campos rellenos, la clave con la forma de una (LIC-INC-02: antes bastaba con que no
 * estuviera vacía) y, si la licencia está en otro equipo, el código de 6 cifras que llegó al correo.
 */
export function activacionCompleta(p: {
	formulario: FormularioActivacion;
	enCambioDeEquipo: boolean;
	codigoCambio: string;
}): boolean {
	const f = p.formulario;
	const camposRellenos = [f.licenseKey, f.legal_name, f.business_name, f.phone, f.country].every(
		(v) => v.trim().length > 0,
	);
	const codigoOk = !p.enCambioDeEquipo || p.codigoCambio.trim().length === 6;
	return camposRellenos && claveCanonica(f.licenseKey) !== null && codigoOk;
}

/** Lo que dice la etiqueta de arriba del formulario. */
export function estadoDelFormulario(p: Parameters<typeof activacionCompleta>[0]): string {
	if (activacionCompleta(p)) return "Datos completos";
	const clave = p.formulario.licenseKey;
	return clave.trim() !== "" && claveCanonica(clave) === null ? "Revisa la clave de licencia" : "Completa todos los campos";
}
