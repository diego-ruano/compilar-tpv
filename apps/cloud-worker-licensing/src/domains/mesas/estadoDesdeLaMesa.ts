// src/domains/mesas/estadoDesdeLaMesa.ts
//
// Marcar desde la mesa que el cliente ha llegado (ACTIVA) o que se ha ido (FINALIZADA). La mesa
// abierta enseña una foto de la reserva, y mientras tanto el cliente pudo cancelarla o pasar a «No
// vino»: se decide con la reserva como está ahora. Espejo de `cambio_desde_la_mesa` en la Main
// (`tpv-domain/src/reservas.rs`). Va fuera de `mesas.commands.ts` porque no construye ningún comando.

/**
 * ¿Se escribe lo que pide la mesa sobre la reserva tal como está ahora (`null` si ya no existe)?
 * Llegar, sólo la que aún no ha llegado; irse, sólo la sentada; lo que ya está así no se vuelve a
 * escribir. Lo demás es que ha cambiado con la mesa abierta, y no se pisa.
 */
export function cambioDesdeLaMesa(actual: string | null, nuevo: string): "escribir" | "nada" | "cambiada" {
	if (actual === nuevo) return "nada";
	if ((actual === "PROXIMA" && nuevo === "ACTIVA") || (actual === "ACTIVA" && nuevo === "FINALIZADA")) {
		return "escribir";
	}
	return "cambiada";
}
