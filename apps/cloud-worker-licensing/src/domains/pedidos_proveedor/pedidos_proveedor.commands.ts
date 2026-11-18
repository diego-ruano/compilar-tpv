// src/domains/pedidos_proveedor/pedidos_proveedor.commands.ts
//
// ESCRITURAS de los pedidos a proveedores como comandos del motor del DO (PED-HANDY). Espejo de la
// Main (`tpv-infra-sqlite/src/pedidos_proveedor.rs`): las mismas sentencias, que son lo que se
// replica y lo que la Main aplica con sus datos. La copia del nombre del proveedor
// (`Nombre_Proveedor`) sale de la base que aplica la sentencia, no de un literal, como allí.
//
// Lo que decide si una edición entra (que el pedido siga siendo un borrador) va en un paso `guard`
// dentro del lote (SYNC-30), con el texto de la Main (`MSG_PEDIDO_NO_EDITABLE`). El cambio de estado
// no lleva guarda: su sentencia ya sólo toca un borrador, y la ruta dice si lo tocó.
//
// Los avisos («Pedido pendiente de aprobar» y su resolución) no van aquí: los emite el caso de uso
// de quien escribe, en la Handy por `/v1/notificaciones`, igual que en la Main.

import { nuevoId } from "../../lib/ids";
import { recortar } from "../../lib/texto";
import type { ApplyCommand } from "../../lib/hub";
import type { PedidoActualizarInput, PedidoCrearInput, PedidoEstadoInput } from "./pedidos_proveedor.schemas";

export type BuiltCommand = {
	commandName: string;
	command: ApplyCommand;
	cloudPayload: any;
};

/** La copia del nombre del proveedor `param`, sacada en la sentencia de la base que la aplica. */
const nombreDe = (param: string) => `(SELECT Nombre_Empresa FROM Proveedores WHERE ID_Proveedor = ${param})`;

const SQL_LINEA = `INSERT INTO Lineas_Pedido_Proveedor
	(ID_Linea, ID_Pedido, Nombre_Producto, Cantidad, Precio_Unitario, Unidad)
	VALUES (?1, ?2, ?3, ?4, ?5, ?6);`;

/** Una sentencia por línea, como la Main. El id lo manda el cliente; si falta, se genera aquí. */
function lineas(idPedido: string, entrada: PedidoCrearInput["lineas"]) {
	return entrada.map((l) => ({
		kind: "execute",
		sql: SQL_LINEA,
		args: [
			recortar(l.id_linea) || nuevoId(),
			idPedido,
			l.nombre_producto,
			l.cantidad,
			l.precio_unitario ?? null,
			l.unidad ?? null,
		],
	}));
}

export function crear(input: PedidoCrearInput): BuiltCommand {
	const id = input.id_pedido;
	const steps: any[] = [
		{ kind: "value", saveAs: "id", sql: "SELECT ?1;", args: [id] },
		{
			kind: "execute",
			// La hora la pone quien escribe: `X-Client-Now` fija el `'now'` (0004).
			sql: `INSERT INTO Pedidos_Proveedor
				(ID_Pedido, ID_Proveedor, Email_Destino, Estado, Fecha_Creacion, Notas, Nombre_Proveedor)
				VALUES (?1, ?2, ?3, 'borrador', datetime('now','localtime'), ?4, ${nombreDe("?2")});`,
			args: [id, input.id_proveedor, input.email_destino, input.notas],
		},
		...lineas(id, input.lineas),
	];
	return {
		commandName: "pedidos_proveedor_crear",
		command: { type: "tenantDb.transaction", payload: { steps, resultKey: "id" } },
		cloudPayload: input,
	};
}

/** PROV-01: sólo se edita un borrador, cabecera y líneas juntas. Espejo de `actualizar`. */
export function actualizar(idPedido: string, input: PedidoActualizarInput): BuiltCommand {
	const steps: any[] = [
		{
			kind: "guard",
			sql: "SELECT EXISTS (SELECT 1 FROM Pedidos_Proveedor WHERE ID_Pedido = ?1 AND Estado = 'borrador');",
			args: [idPedido],
			error: "pedido_no_editable",
			status: 409,
		},
		{
			kind: "execute",
			sql: `UPDATE Pedidos_Proveedor
				SET ID_Proveedor = ?1, Email_Destino = ?2, Notas = ?3, Nombre_Proveedor = ${nombreDe("?1")}
				WHERE ID_Pedido = ?4 AND Estado = 'borrador';`,
			args: [input.id_proveedor, input.email_destino, input.notas, idPedido],
		},
		{
			kind: "execute",
			sql: "DELETE FROM Lineas_Pedido_Proveedor WHERE ID_Pedido = ?1;",
			args: [idPedido],
		},
		...lineas(idPedido, input.lineas),
	];
	return {
		commandName: "pedidos_proveedor_actualizar",
		command: { type: "tenantDb.transaction", payload: { steps } },
		cloudPayload: { ...input, id_pedido: idPedido },
	};
}

/**
 * PROV-02: un pedido sólo pasa de borrador a enviado o cancelado. El resultado es cuántas filas tocó
 * (`cambiado`): 0 si no había un borrador con ese id. Al enviarlo (o cancelarlo) se vuelve a copiar el
 * nombre del proveedor, si sigue.
 */
export function cambiarEstado(idPedido: string, input: PedidoEstadoInput): BuiltCommand {
	const steps: any[] = [
		{
			kind: "execute",
			saveAs: "cambiado",
			sql: `UPDATE Pedidos_Proveedor
				SET Estado = ?1, Fecha_Envio = ?2,
					Nombre_Proveedor = COALESCE(${nombreDe("Pedidos_Proveedor.ID_Proveedor")}, Nombre_Proveedor)
				WHERE ID_Pedido = ?3 AND Estado = 'borrador';`,
			args: [input.estado, input.fecha_envio, idPedido],
		},
	];
	return {
		commandName: "pedidos_proveedor_cambiar_estado",
		command: { type: "tenantDb.transaction", payload: { steps, resultKey: "cambiado" } },
		cloudPayload: { ...input, id_pedido: idPedido },
	};
}
