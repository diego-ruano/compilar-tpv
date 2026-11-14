// src/domains/mesas/guardasDeLinea.ts
//
// SYNC-30: lo que decide si una línea entra en una comanda, de mesa o de barra, mirado dentro del
// lote que la escribe. La ruta lo leía antes y rechazaba con su mensaje, pero entre esa lectura y el
// lote la Main puede cobrar la comanda o archivar el producto. Son pasos `guard` del comando
// (`tenantHub.lote.ts`): si no se cumplen, el lote entero se deshace y la Handy oye el mismo
// rechazo, y un reintento de una línea que sí entró contesta lo guardado sin volver a mirarlos.
// Espejo de `exigir_comanda_abierta` y `snapshot_del_producto` en la Main.
//
// Va fuera de `mesas.commands.ts` porque no construye ningún comando: los usan el de mesas y el de
// la barra.

import type { TxStep } from "../../durableObjects/tenantHub.types";

/**
 * INC-20261030-016: la comanda no está cobrada. Una que no existe no cuenta como cobrada: la de barra
 * se crea en el mismo lote que su primera línea. La sentencia que escribe la línea lleva además su
 * propia condición, que es la que vuelve a evaluar la Main al aplicarla.
 */
export function guardaComandaSinCobrar(idComanda: string): TxStep {
	return {
		kind: "guard",
		sql: "SELECT NOT EXISTS (SELECT 1 FROM Comandas WHERE ID_Comanda = ?1 AND Estado <> 'Abierta');",
		args: [idComanda],
		error: "comanda_cobrada",
		status: 409,
	};
}

/** RI-54: el producto no está archivado. Una pantalla con la carta de antes en caché lo ofrece. */
export function guardaProductoEnLaCarta(idProducto: string): TxStep {
	return {
		kind: "guard",
		sql: "SELECT NOT EXISTS (SELECT 1 FROM Productos WHERE ID_Producto = ?1 AND Archivado_En IS NOT NULL);",
		args: [idProducto],
		error: "producto_archivado",
		status: 409,
	};
}
