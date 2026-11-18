// src/features/cuentas/proveedorDelGasto.ts
//
// El proveedor que se enseña junto a un gasto en Cuentas (la lista, la confirmación de borrarlo y el
// PDF). Un gasto cuyo proveedor se borró ya no tiene `proveedor_id`, pero conserva su nombre: la
// etiqueta la trae la lectura (`proveedor_borrado`, «Pescados Norte (borrado)», la misma que en
// Estadísticas). Antes ese gasto salía como si no fuera de ningún proveedor.
import type { SalidaDto } from "@tpv/contracts";

/**
 * La etiqueta del proveedor de un gasto, o `null` si no la lleva. El de la ficha sale sólo en los
 * gastos de tipo «Proveedor», como siempre; el de uno borrado, en cualquiera: el gasto era suyo.
 */
export function proveedorDelGasto(
	s: Pick<SalidaDto, "tipo_gasto" | "proveedor_id" | "proveedor_borrado">,
	nombreDe: (id: string) => string,
): string | null {
	if (s.proveedor_id) return s.tipo_gasto === "Proveedor" ? nombreDe(s.proveedor_id) : null;
	return s.proveedor_borrado ?? null;
}
