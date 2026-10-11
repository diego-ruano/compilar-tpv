// src/shared/lib/iva.ts
//
// Un tipo de IVA es un porcentaje entre 0 y 100 (RI-78): el del negocio y el propio de un producto.
// El mismo criterio que `validate_iva_percent` en la Main y `zIva` en el worker; los tres leen sus
// casos de `crates/tpv-domain/src/validacion_casos.json`.
//
// Lo que no vale se dice en el formulario. Recortarlo al rango convertía un «210» tecleado por
// «21» en otro número que nadie había escrito.

/** Mismo texto que `MSG_IVA` en la Main y en el worker. */
export const MSG_IVA = "El IVA tiene que ser un número entre 0 y 100";

export function ivaEnRango(n: number): boolean {
	return Number.isFinite(n) && n >= 0 && n <= 100;
}

/** Lo tecleado en un campo de IVA, con coma o con punto. `null` si no es un tipo válido. */
export function leerIva(texto: string): number | null {
	const t = texto.trim().replace(",", ".");
	if (!/^\d+(\.\d+)?$/.test(t)) return null;
	const n = Number(t);
	return ivaEnRango(n) ? n : null;
}
