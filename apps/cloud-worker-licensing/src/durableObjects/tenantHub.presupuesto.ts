// src/durableObjects/tenantHub.presupuesto.ts
//
// AUD-36 · Lo que puede escribir un negocio en su base de la nube, por operación y por hora.
//
// La base del negocio es el SQLite de su TenantHub. Lo que se escribe en ella se factura (filas
// escritas y almacenamiento), ocupa el tope de almacenamiento del objeto y gasta la CPU del objeto,
// que es la misma con la que atiende al resto del negocio. Nadie lo acotaba: una Main con licencia
// (su dueño, o quien controle el equipo: el outbox va sin firma) o una Handy con sus credenciales
// podían escribir lo que quisieran, tan deprisa como les dejara la red.
//
// Dos topes, con un margen muy amplio sobre lo que escribe un negocio de verdad (el outbox de un
// servicio real, 300 operaciones: 106 filas la que más, 2.579 todas, y 20 KB de crecimiento la que
// más; `test/presupuestoDeEscritura.test.ts`):
//
// - **Por operación de la Main** (`TOPE_DE_UNA_OPERACION`): las filas que escribe (con las de los
//   índices y las de los triggers, `rowsWritten`) y lo que crece la base. Se miran sentencia a
//   sentencia, dentro de su transacción (`loteEnBruto`): la que se pasa se deshace entera y se
//   rechaza como permanente (`operacion_demasiado_grande`), y la Main la aparta y la repara por
//   estado. Una reparación (`contraste.rs`) son 500 sentencias de una fila.
// - **Por hora, para todo el negocio** (`PRESUPUESTO_POR_HORA`): las filas y los bytes que han
//   escrito sus operaciones en la hora en curso. Agotado, lo que llega espera a la hora siguiente:
//   la operación de la Main sale `transitorio` (la conserva y la vuelve a mandar; la Main sigue
//   cobrando), y la escritura de una Handy, `presupuesto_agotado` (429). Se avisa a Sentry y a
//   Axiom una vez por instancia (`avisarUnaVez`). Cuentan también las filas de un intento que se
//   deshizo: el SQLite del DO las ha escrito igual.
//
// Lo que hay que recordar va en el SQL del propio objeto (`_Presupuesto_Escritura`, una fila), no en
// un campo: sobrevive a la hibernación. Una tabla con `_` delante es del objeto: no se replica, ni
// sale en los volcados, ni la puede escribir la Main (`tenantHub.replicable.ts`).

import { HubError } from "../lib/errorHttp";

type Almacen = DurableObjectState["storage"];

const HORA_MS = 60 * 60 * 1000;
const MIB = 1024 * 1024;

/** Lo que puede escribir una operación de la Main. */
export const TOPE_DE_UNA_OPERACION = { filas: 100_000, bytes: 32 * MIB } as const;

/** Lo que puede escribir el negocio entero en una hora (la Main y sus Handy). */
export const PRESUPUESTO_POR_HORA = { filas: 500_000, bytes: 256 * MIB } as const;

/** Lo que lleva escrito una operación, sentencia a sentencia (`loteEnBruto`). */
export type TopeDeOperacion = {
	filas: number;
	bytes: number;
	/** Lo escrito de verdad, también en un intento que se deshace. Lo apunta `loteEnBruto`. */
	medida: { filas: number };
};

export function topeDeUnaOperacion(): TopeDeOperacion {
	return { ...TOPE_DE_UNA_OPERACION, medida: { filas: 0 } };
}

/** La operación se ha pasado de su tope: se deshace entera. Permanente (`tenantHub.errores.ts`). */
export function operacionDemasiadoGrande(): HubError {
	return new HubError("operacion_demasiado_grande", 413);
}

function asegurarTabla(storage: Almacen): void {
	storage.sql.exec(`
		CREATE TABLE IF NOT EXISTS _Presupuesto_Escritura (
			Id INTEGER PRIMARY KEY CHECK (Id = 1),
			Hora_Ms INTEGER NOT NULL,
			Filas INTEGER NOT NULL,
			Bytes INTEGER NOT NULL
		);
	`);
}

const horaDe = (ahoraMs: number) => Math.floor(ahoraMs / HORA_MS) * HORA_MS;

/** Lo gastado en la hora de `ahoraMs`. */
export function gastadoEnLaHora(storage: Almacen, ahoraMs: number): { filas: number; bytes: number } {
	asegurarTabla(storage);
	const fila = storage.sql
		.exec("SELECT Hora_Ms, Filas, Bytes FROM _Presupuesto_Escritura WHERE Id = 1;")
		.toArray()[0] as { Hora_Ms?: number; Filas?: number; Bytes?: number } | undefined;
	if (!fila || Number(fila.Hora_Ms) !== horaDe(ahoraMs)) return { filas: 0, bytes: 0 };
	return { filas: Number(fila.Filas ?? 0), bytes: Number(fila.Bytes ?? 0) };
}

/** ¿Se ha gastado ya el presupuesto de esta hora? Lo que llega ahora espera a la siguiente. */
export function presupuestoAgotado(storage: Almacen, ahoraMs: number): boolean {
	const g = gastadoEnLaHora(storage, ahoraMs);
	return g.filas >= PRESUPUESTO_POR_HORA.filas || g.bytes >= PRESUPUESTO_POR_HORA.bytes;
}

/** Apunta lo que ha escrito una operación (o un intento suyo que se deshizo). */
export function apuntarGasto(storage: Almacen, ahoraMs: number, filas: number, bytes: number): void {
	if (!(filas > 0) && !(bytes > 0)) return;
	asegurarTabla(storage);
	const hora = horaDe(ahoraMs);
	storage.sql.exec(
		`INSERT INTO _Presupuesto_Escritura (Id, Hora_Ms, Filas, Bytes) VALUES (1, ?1, ?2, ?3)
		 ON CONFLICT(Id) DO UPDATE SET
		   Filas = CASE WHEN Hora_Ms = ?1 THEN Filas + ?2 ELSE ?2 END,
		   Bytes = CASE WHEN Hora_Ms = ?1 THEN Bytes + ?3 ELSE ?3 END,
		   Hora_Ms = ?1;`,
		hora,
		Math.max(0, Math.floor(filas)),
		Math.max(0, Math.floor(bytes)),
	);
}

/** El presupuesto agotado, como lo recibe una Handy (y como lo clasifica el DO: pasajero). */
export function presupuestoAgotadoError(): HubError {
	return new HubError("presupuesto_agotado", 429);
}
