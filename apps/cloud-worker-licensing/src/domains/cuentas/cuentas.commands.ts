// src/domains/cuentas/cuentas.commands.ts

import { nuevoId } from "../../lib/ids";
import type { ApplyCommand } from "../../lib/hub";
import type {
	AnularPagoInput,
	CreateGastoInput,
	UpdateGastoInput,
	UpdatePagoInput,
} from "./cuentas.schemas";

export type BuiltCommand = {
	commandName: string;
	command: ApplyCommand;
	cloudPayload: any;
};

const REF_ID = { $ref: "id" } as const;

/// Normaliza el método de pago a "Tarjeta" o "Efectivo" (paridad con `tpv_domain::pago`, CUENTA-03).
function normalizeMetodo(input: string): string {
	return input.trim().toLowerCase() === "tarjeta" ? "Tarjeta" : "Efectivo";
}

// UUIDv7: el id lo genera el cliente y lo envía; si faltara, generamos uno.
function idStep(provided?: string | null) {
	const id = (provided ?? "").trim() || nuevoId();
	return { kind: "value", saveAs: "id", sql: "SELECT ?1;", args: [id] };
}

export function createGasto(input: CreateGastoInput): BuiltCommand {
	const cloudPayload = {
		id_gasto: input.id_gasto ?? null,
		fecha: input.fecha,
		tipo_gasto: input.tipo_gasto,
		concepto: input.concepto,
		importe: input.importe,
		proveedor_id: input.proveedor_id ?? null,
		pagado_con_caja: Boolean(input.pagado_con_caja),
	};
	const steps = [
		idStep(cloudPayload.id_gasto),
		// Los dos ids se generan ANTES de sus INSERT, nunca dentro del SQL: una `TEXT PRIMARY KEY`
		// calculada en la sentencia se re-evaluaría al replicar (docs/arquitectura/sincronizacion.md).
		{ kind: "value", saveAs: "mov", sql: "SELECT ?1;", args: [nuevoId()] },
		{
			kind: "execute",
			sql: `
				INSERT INTO Cuentas_Gastos (ID_Gasto, Fecha, Concepto, Importe, Tipo_Gasto, ID_Proveedor, Pagado_Con_Caja)
				VALUES (?1, date(?2), ?3, ?4, ?5, ?6, ?7)
				ON CONFLICT(ID_Gasto) DO UPDATE SET
					Fecha = excluded.Fecha,
					Concepto = excluded.Concepto,
					Importe = excluded.Importe,
					Tipo_Gasto = excluded.Tipo_Gasto,
					ID_Proveedor = excluded.ID_Proveedor,
					Pagado_Con_Caja = excluded.Pagado_Con_Caja;
			`,
			args: [
				REF_ID,
				cloudPayload.fecha,
				cloudPayload.concepto,
				cloudPayload.importe,
				cloudPayload.tipo_gasto,
				cloudPayload.proveedor_id,
				cloudPayload.pagado_con_caja ? 1 : 0,
			],
		},
		// Su fila en el historial de caja (CUENTA-07). Paridad con
		// `SqliteCuentasRepository::crear_gasto`: una salida de dinero es un movimiento como lo es
		// un cobro. `ID_Usuario` va nulo porque aquí no hay sesión de usuario —solo tenant y
		// dispositivo—; en la Main lo pone el backend.
		{
			kind: "execute",
			sql: `
				INSERT INTO Movimientos_Caja (
				  ID_Movimiento, Fecha_Hora, Tipo, ID_Gasto, Importe, Motivo
				)
				SELECT ?1, datetime('now','localtime'), 'GASTO', ?2, ABS(?3), ?4
				WHERE NOT EXISTS (
				  SELECT 1 FROM Movimientos_Caja mc WHERE mc.Tipo = 'GASTO' AND mc.ID_Gasto = ?2
				);
			`,
			args: [{ $ref: "mov" }, REF_ID, cloudPayload.importe, cloudPayload.concepto],
		},
	];
	return {
		commandName: "cuentas_create_gasto",
		command: { type: "tenantDb.transaction", payload: { steps, resultKey: "id" } },
		cloudPayload,
	};
}

export function updateGasto(idGasto: string, input: UpdateGastoInput): BuiltCommand {
	const cloudPayload = { id_gasto: idGasto, ...input };
	return {
		commandName: "cuentas_update_gasto",
		command: {
			type: "tenantDb.exec",
			payload: {
				sql: `
					UPDATE Cuentas_Gastos
					SET Fecha = date(?2), Tipo_Gasto = ?3, Concepto = ?4, Importe = ?5, ID_Proveedor = ?6,
						Pagado_Con_Caja = ?7
					WHERE ID_Gasto = ?1;
				`,
				args: [
					idGasto,
					input.fecha,
					input.tipo_gasto,
					input.concepto,
					input.importe,
					input.proveedor_id ?? null,
					input.pagado_con_caja ? 1 : 0,
				],
			},
		},
		cloudPayload,
	};
}

export function deleteGasto(idGasto: string): BuiltCommand {
	const steps = [
		{ kind: "value", saveAs: "mov", sql: "SELECT ?1;", args: [nuevoId()] },
		// El movimiento se anota ANTES del borrado: después la fila ya no está y el historial se
		// quedaría con un importe de 0, que no dice nada de lo que se deshizo.
		{
			kind: "execute",
			sql: `
				INSERT INTO Movimientos_Caja (
				  ID_Movimiento, Fecha_Hora, Tipo, ID_Gasto, Importe, Motivo
				)
				SELECT ?2, datetime('now','localtime'), 'GASTO_ANULADO', g.ID_Gasto,
				       ABS(IFNULL(g.Importe,0)), NULLIF(COALESCE(g.Concepto,''),'')
				FROM Cuentas_Gastos g
				WHERE g.ID_Gasto = ?1
				  AND NOT EXISTS (
				    SELECT 1 FROM Movimientos_Caja mc
				    WHERE mc.Tipo = 'GASTO_ANULADO' AND mc.ID_Gasto = ?1
				  );
			`,
			args: [idGasto, { $ref: "mov" }],
		},
		{
			kind: "execute",
			sql: "DELETE FROM Cuentas_Gastos WHERE ID_Gasto = ?1;",
			args: [idGasto],
		},
	];
	return {
		commandName: "cuentas_delete_gasto",
		command: { type: "tenantDb.transaction", payload: { steps } },
		cloudPayload: { id_gasto: idGasto },
	};
}

// Actualiza sólo método y fecha; el Importe_Total se **recalcula** desde los Pago_Detalles
// cobrados (CUENTA-02), no se toma del input. Paridad con `SqliteCuentasRepository::actualizar_pago`.
// Una devolución de parte de un cobro no se edita: su importe no sale de Pago_Detalles.
export function updatePago(idPago: string, input: UpdatePagoInput): BuiltCommand {
	const cloudPayload = { id_pago: idPago, ...input };
	return {
		commandName: "cuentas_update_pago",
		command: {
			type: "tenantDb.exec",
			payload: {
				sql: `
					UPDATE Pagos
					SET Fecha_Hora = ?2,
					    Metodo_Pago = ?3,
					    Importe_Total = (
					      SELECT IFNULL(SUM(CAST(ROUND(COALESCE(dc.Cantidad,1) * COALESCE(dc.Precio_Unitario,0)) AS INTEGER)), 0)
					      FROM Pago_Detalles pd
					      JOIN Detalle_Comanda dc ON dc.ID_Detalle = pd.ID_Detalle
					      WHERE pd.ID_Pago = ?1
					    )
					WHERE ID_Pago = ?1 AND ID_Pago_Origen IS NULL;
				`,
				args: [idPago, input.fecha_hora, normalizeMetodo(input.metodo)],
			},
		},
		cloudPayload,
	};
}

// Lo que ya repusieron al stock las devoluciones parciales vigentes de un cobro, para una traza de
// consumo (`a` es el alias de Lote_Consumos o Suelto_Consumos). Copia de `cuentas::sql_ya_repuesto`
// en la Main: la misma cuenta con la que repone cada devolución, para que la baja del cobro reponga
// exactamente lo que falta.
const yaRepuesto = (a: string) =>
	`IFNULL(ROUND(${a}.Cantidad * (` +
	`SELECT ROUND(v.Cantidad, 3) FROM v_unidades_devueltas v ` +
	`WHERE v.ID_Pago = ${a}.ID_Pago AND v.ID_Detalle = ${a}.ID_Detalle` +
	`) / (` +
	`SELECT NULLIF(COALESCE(dc.Cantidad, 1), 0) FROM Detalle_Comanda dc ` +
	`WHERE dc.ID_Detalle = ${a}.ID_Detalle` +
	`), 3), 0)`;

// Anula un pago SIN borrarlo (CUENTA-07): devuelve el stock (por lote y suelto), resta el gasto
// del cliente, marca la fila de `Pagos` y deja el movimiento en `Movimientos_Caja`. Las líneas y
// sus `Pago_Detalles` se **conservan** (Opción A): son lo que permite reimprimir el ticket anulado,
// y lo que devuelve las consumiciones a la mesa como pendientes — «cobrada» pasa a leerse por la
// vista `v_lineas_cobradas`, que sólo mira pagos activos. Paridad con
// `SqliteCuentasRepository::anular_pago`. Todo en una transacción del DO.
export function anularPago(idPago: string, input: AnularPagoInput): BuiltCommand {
	const motivo = (input.motivo ?? "").trim();
	const idUsuario = input.id_usuario;
	// FISCAL-01: los dos instrumentos. Espejo de `ClaseBaja` en Rust.
	//
	//   ERROR      → la venta NO existió: las líneas vuelven a la comanda.
	//   DEVOLUCION → la venta SÍ existió: las líneas NO vuelven, o quedarían pendientes de cobro
	//                otra vez.
	//
	// Las dos reponen el stock: lo devuelto vuelve al almacén.
	//
	// Lo que esta ruta **no** hace en ningún caso es emitir el registro de facturación: lo emite la
	// Main dentro de su propia transacción, y el veto de `applyViaHub` impide escribir
	// `Registros_Facturacion` desde aquí. La nube es copia, no fuente.
	const clase = input.clase === "DEVOLUCION" ? "DEVOLUCION" : "ERROR";
	const devuelveLasLineas = clase === "ERROR";
	const steps = [
		// El id del movimiento de caja se genera ANTES del INSERT, nunca dentro de la sentencia:
		// una TEXT PRIMARY KEY calculada en SQL se re-evaluaría al replicar y la nube y la Main
		// acabarían con dos filas distintas para el mismo hecho.
		idStep(null),
		// 1) Devolver el stock que consumió ESTE pago: por el pago del consumo y no por sus líneas
		//    (STOCK-01). La traza (`Lote_Consumos`) se CONSERVA: el doble abono lo impide el `Estado`.
		//    Redondeado a milésimas como todo movimiento de stock (RI-26).
		{
			kind: "execute",
			sql: `
				UPDATE Lotes_Producto
				SET Stock_Disponible = ROUND(COALESCE(Stock_Disponible,0) + (
				    SELECT IFNULL(SUM(lc.Cantidad - ${yaRepuesto("lc")}),0)
				    FROM Lote_Consumos lc
				    WHERE lc.ID_Pago = ?1 AND lc.ID_Lote = Lotes_Producto.ID_Lote
				), 3)
				WHERE ID_Lote IN (
				    SELECT lc.ID_Lote
				    FROM Lote_Consumos lc
				    WHERE lc.ID_Pago = ?1
				)
				  AND (SELECT COALESCE(Estado,'ACTIVO') FROM Pagos WHERE ID_Pago = ?1) = 'ACTIVO';
			`,
			args: [idPago],
		},
		// 1-bis) Y el stock SUELTO que consumió el pago (lo que los lotes no cubrieron, VR-04).
		{
			kind: "execute",
			sql: `
				UPDATE Productos
				SET Stock_Suelto = ROUND(COALESCE(Stock_Suelto,0) + (
				    SELECT IFNULL(SUM(sc.Cantidad - ${yaRepuesto("sc")}),0)
				    FROM Suelto_Consumos sc
				    WHERE sc.ID_Pago = ?1 AND sc.ID_Producto = Productos.ID_Producto
				), 3)
				WHERE ID_Producto IN (
				    SELECT sc.ID_Producto
				    FROM Suelto_Consumos sc
				    WHERE sc.ID_Pago = ?1
				)
				  AND (SELECT COALESCE(Estado,'ACTIVO') FROM Pagos WHERE ID_Pago = ?1) = 'ACTIVO';
			`,
			args: [idPago],
		},
		// 2) Restar el gasto del cliente ligado a la comanda del pago (sin bajar de 0). Lo que ya le
		//    restaron sus devoluciones parciales (pagos negativos) no se le resta otra vez.
		{
			kind: "execute",
			sql: `
				UPDATE Clientes
				SET Total_Gastado = MAX(0, COALESCE(Total_Gastado,0) - (
				    SELECT IFNULL(p.Importe_Total,0) + IFNULL((
				        SELECT SUM(d.Importe_Total) FROM Pagos d
				        WHERE d.ID_Pago_Origen = ?1 AND d.Estado = 'ACTIVO'
				    ),0)
				    FROM Pagos p WHERE p.ID_Pago = ?1
				))
				-- RI-61: el cliente de la comanda (fijado al cobrar) y, si no, el de su reserva.
				WHERE ID_Cliente = (
				    SELECT COALESCE(c.ID_Cliente, r.ID_Cliente)
				    FROM Pagos p
				    JOIN Comandas c ON c.ID_Comanda = p.ID_Comanda
				    LEFT JOIN Reservas r ON r.ID_Reserva = c.ID_Reserva
				    WHERE p.ID_Pago = ?1
				      AND COALESCE(p.Estado,'ACTIVO') = 'ACTIVO'
				);
			`,
			args: [idPago],
		},
		// 3) El movimiento en el historial de caja, con el tipo que corresponde: son dos hechos
		//    distintos y el historial existe para poder distinguirlos al investigar un descuadre.
		//    Va ANTES de marcar el pago porque lee su importe y su método de la fila todavía activa.
		{
			kind: "execute",
			sql: `
				INSERT INTO Movimientos_Caja (
				  ID_Movimiento, Fecha_Hora, Tipo, ID_Pago, ID_Usuario, Importe, Metodo_Pago, Motivo
				)
				SELECT ?2, datetime('now','localtime'), ?5, p.ID_Pago, ?3,
				       ABS(IFNULL(p.Importe_Total,0)), NULLIF(COALESCE(p.Metodo_Pago,''),''), ?4
				FROM Pagos p
				WHERE p.ID_Pago = ?1 AND COALESCE(p.Estado,'ACTIVO') = 'ACTIVO'
				  AND NOT EXISTS (
				    SELECT 1 FROM Movimientos_Caja mc
				    WHERE mc.Tipo IN ('ANULACION','DEVOLUCION') AND mc.ID_Pago = ?1
				  );
			`,
			args: [idPago, REF_ID, idUsuario, motivo, clase === "DEVOLUCION" ? "DEVOLUCION" : "ANULACION"],
		},
		// 4) Marcar el pago. El `Estado <> 'ANULADO'` deja el UPDATE idempotente, y es el guardia
		//    que impide abonar el stock dos veces.
		{
			kind: "execute",
			sql: `
				UPDATE Pagos
				SET Estado = 'ANULADO',
				    Anulado_En = datetime('now','localtime'),
				    Anulado_Por = ?2,
				    Motivo_Anulacion = ?3,
				    Motivo_Baja = ?4
				WHERE ID_Pago = ?1 AND COALESCE(Estado,'ACTIVO') <> 'ANULADO';
			`,
			args: [idPago, idUsuario, motivo, clase],
		},
		// 4-bis) La baja por error deshace sus devoluciones parciales, con la misma firma: si la venta
		//        no existió, el dinero devuelto de ella tampoco salió por una venta. Su stock y el
		//        gasto del cliente ya están cuadrados en los pasos 1 y 2.
		devuelveLasLineas && {
			kind: "execute",
			sql: `
				UPDATE Pagos
				SET Estado = 'ANULADO',
				    Anulado_En = datetime('now','localtime'),
				    Anulado_Por = ?2,
				    Motivo_Anulacion = ?3,
				    Motivo_Baja = 'ERROR'
				WHERE ID_Pago_Origen = ?1 AND Estado = 'ACTIVO';
			`,
			args: [idPago, idUsuario, motivo],
		},
		// 5) Recalcular la comanda. Sus líneas vuelven a estar pendientes —el pago que las cubría
		//    ya no está activo—, así que se reabre si no hay otra comanda abierta para la mesa.
		//
		//    Sólo en una anulación por error: en una devolución la mesa está cerrada y reabrirla
		//    pondría las líneas otra vez a cobrar.
		devuelveLasLineas && {
			kind: "execute",
			sql: `
				UPDATE Comandas
				SET Estado = CASE
				      WHEN ID_Comanda = (SELECT ID_Comanda FROM Pagos WHERE ID_Pago = ?1)
				       AND EXISTS (
				        SELECT 1 FROM Detalle_Comanda dc
				        WHERE dc.ID_Comanda = Comandas.ID_Comanda AND NOT EXISTS (SELECT 1 FROM v_lineas_cobradas pd WHERE pd.ID_Detalle = dc.ID_Detalle)
				      )
				       AND NOT EXISTS (
				        SELECT 1 FROM Comandas abierta
				        WHERE abierta.ID_Mesa = Comandas.ID_Mesa
				          AND abierta.Estado = 'Abierta'
				          AND abierta.ID_Comanda <> Comandas.ID_Comanda
				      )
				      THEN 'Abierta' ELSE Estado END,
				    Fecha_Hora_Cierre = CASE
				      WHEN ID_Comanda = (SELECT ID_Comanda FROM Pagos WHERE ID_Pago = ?1)
				       AND EXISTS (
				        SELECT 1 FROM Detalle_Comanda dc
				        WHERE dc.ID_Comanda = Comandas.ID_Comanda AND NOT EXISTS (SELECT 1 FROM v_lineas_cobradas pd WHERE pd.ID_Detalle = dc.ID_Detalle)
				      )
				       AND NOT EXISTS (
				        SELECT 1 FROM Comandas abierta
				        WHERE abierta.ID_Mesa = Comandas.ID_Mesa
				          AND abierta.Estado = 'Abierta'
				          AND abierta.ID_Comanda <> Comandas.ID_Comanda
				      )
				      THEN NULL ELSE Fecha_Hora_Cierre END,
				    Total_Comanda = (
				        SELECT IFNULL(SUM(CAST(ROUND(COALESCE(Cantidad,1) * COALESCE(Precio_Unitario,0)) AS INTEGER)), 0)
				        FROM Detalle_Comanda WHERE ID_Comanda = Comandas.ID_Comanda
				    )
				WHERE ID_Comanda = (SELECT ID_Comanda FROM Pagos WHERE ID_Pago = ?1);
			`,
			args: [idPago],
		},
		// Los pasos marcados con `devuelveLasLineas && …` quedan en `false` cuando es una
		// devolución; se descartan aquí. Es más legible que montar el array por trozos, y lo que
		// importa —qué paso aplica a qué caso— se lee en el propio paso.
	].filter(Boolean) as any[];
	return {
		commandName: "cuentas_anular_pago",
		command: { type: "tenantDb.transaction", payload: { steps } },
		cloudPayload: { id_pago: idPago, id_usuario: idUsuario, motivo, clase },
	};
}
