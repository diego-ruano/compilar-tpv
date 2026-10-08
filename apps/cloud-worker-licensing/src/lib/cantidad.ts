// src/lib/cantidad.ts
//
// Cantidades de stock (RI-26). Espejo de `crates/tpv-domain/src/cantidad.rs`; la tabla
// `cantidad_casos.json` los mantiene iguales.
//
// Son REAL a propósito (medio kilo), pero un double no representa 0,1 y los residuos se acumulan:
// un kilo vendido en diez raciones de 0,1 dejaba 1,39e-16 en el lote, que el FEFO seguía eligiendo.
// Cada cantidad que se escribe se redondea a milésimas, aquí y en SQL con ROUND(…, 3).

/**
 * Redondea a milésimas con la mitad lejos del cero, como `f64::round` de Rust (`Math.round` lleva la
 * mitad hacia +infinito, así que se aplica al valor absoluto). El cero negativo sale como cero.
 */
export function redondearCantidad(x: number | null): number {
	if (x == null) return 0;
	if (!Number.isFinite(x)) return 0;
	const r = (Math.sign(x) * Math.round(Math.abs(x) * 1000)) / 1000;
	return r || 0;
}
