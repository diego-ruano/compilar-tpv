// src/durableObjects/tenantHub.main.ts
//
// AUD-02 · Quién es la Main del negocio, en el SQL del propio DO.
//
// El rol `tpv` de una sesión dice que el equipo se activó como Main, no que lo siga siendo: un
// traslado de licencia sólo cambia `licenses.main_device_id` en la base central, y el socket del
// equipo anterior sigue abierto. Preguntarle a la base central cada vez que hay que decidir es una
// espera, y entre la respuesta y la decisión cabe otra respuesta, un cierre o un traslado. Así que
// la decisión no pregunta: **quién es la Main está apuntado aquí**, en una fila, y se mira sin
// esperar (`MotorTenantHub.esLaMain`). Las lecturas de la base central sólo ponen la fila al día.
//
// La fila (`_Main_Vigente`, una sola):
//   · `Device_Id`         el `main_device_id` de la licencia viva, o NULL: no hay Main (la licencia
//                         está anulada). Con `Lectura_Aplicada` a 0 no se ha leído nunca.
//   · `Comprobada_Ms`     cuándo empezó la última lectura. Es la marca de «una vez por minuto» de la
//                         comprobación por actividad, y se escribe ANTES de esperar la respuesta:
//                         veinte mensajes a la vez hacen una lectura, sin promesas compartidas.
//   · `Lectura_Empezada`  el número de la última lectura que ha salido hacia la base central.
//   · `Lectura_Aplicada`  el número de la última cuya respuesta se ha apuntado.
//
// Las lecturas se numeran al EMPEZAR, y una respuesta sólo se apunta si no se ha apuntado ya la de
// una lectura que empezó después: una respuesta vieja que llega tarde no deshace una nueva.
//
// ⚠️ Funciones libres y sin estado (SYNC-16): lo que hay que recordar está en la tabla, que
// sobrevive a la hibernación. Ni temporizadores ni alarmas: nadie pregunta por un negocio parado.

import { nowMs } from "./tenantHub.tiempo";

/** Cada cuánto, como mucho, pregunta la comprobación por actividad a la base central. */
const INTERVALO_COMPROBAR_MAIN_MS = 60_000;

type Almacen = DurableObjectState["storage"];

/** Barato e idempotente: se llama al principio de cada operación, sin un flag que se pierda al hibernar. */
function asegurarTabla(storage: Almacen): void {
	storage.sql.exec(`
		CREATE TABLE IF NOT EXISTS _Main_Vigente (
			Id INTEGER PRIMARY KEY CHECK (Id = 1),
			Device_Id TEXT,
			Comprobada_Ms INTEGER NOT NULL DEFAULT 0,
			Lectura_Empezada INTEGER NOT NULL DEFAULT 0,
			Lectura_Aplicada INTEGER NOT NULL DEFAULT 0
		);
	`);
}

/** La tabla y su única fila: lo que necesita quien va a escribir. Quien sólo lee no la crea. */
function asegurarMain(storage: Almacen): void {
	asegurarTabla(storage);
	storage.sql.exec("INSERT INTO _Main_Vigente (Id) VALUES (1) ON CONFLICT(Id) DO NOTHING;");
}

/**
 * Lo que dice la tabla: si se ha leído alguna vez de la base central y, si se ha leído, qué
 * dispositivo es la Main (`null`: ninguno, la licencia está anulada).
 */
export type MainVigente = { leida: boolean; deviceId: string | null };

/**
 * Quién es la Main ahora mismo, según la tabla. No espera a nadie, y no crea la tabla: sin ella es
 * que no se ha leído nunca, lo mismo que con la tabla recién creada. Se mira también en un objeto
 * sin base (una ruta de un `tpv`, `vetoDeMain`), y preguntarle no puede dejarle nada escrito.
 */
export function mainVigente(storage: Almacen): MainVigente {
	const hayTabla =
		storage.sql
			.exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '_Main_Vigente';")
			.toArray().length > 0;
	if (!hayTabla) return { leida: false, deviceId: null };
	const fila = storage.sql
		.exec("SELECT Device_Id, Lectura_Aplicada FROM _Main_Vigente WHERE Id = 1;")
		.toArray()[0] as any;
	return {
		leida: Number(fila?.Lectura_Aplicada ?? 0) > 0,
		deviceId: String(fila?.Device_Id ?? "") || null,
	};
}

/**
 * Sale una lectura hacia la base central: devuelve su número, que es mayor que el de cualquiera que
 * haya salido antes, y deja anotado cuándo. Toda lectura cuenta para el minuto, también la de un
 * saludo.
 */
export function empezarLectura(storage: Almacen): number {
	asegurarMain(storage);
	const fila = storage.sql
		.exec(
			`UPDATE _Main_Vigente
			    SET Lectura_Empezada = Lectura_Empezada + 1, Comprobada_Ms = ?
			  WHERE Id = 1
			 RETURNING Lectura_Empezada AS n;`,
			nowMs(),
		)
		.toArray()[0] as any;
	return Number(fila?.n ?? 0);
}

/**
 * Apunta la respuesta de la lectura `lectura`. Devuelve `false`, sin tocar nada, si ya se apuntó la
 * de una que empezó después.
 */
export function aplicarLectura(storage: Almacen, lectura: number, deviceId: string | null): boolean {
	asegurarMain(storage);
	const filas = storage.sql
		.exec(
			`UPDATE _Main_Vigente
			    SET Device_Id = ?, Lectura_Aplicada = ?
			  WHERE Id = 1 AND Lectura_Aplicada < ?
			 RETURNING Id;`,
			deviceId,
			lectura,
			lectura,
		)
		.toArray();
	return filas.length > 0;
}

/**
 * ¿Toca la comprobación por actividad? Si toca, quien pregunta se la queda: la marca se escribe
 * aquí, antes de que nadie espere, y los que lleguen mientras tanto ven que ya no toca. Toca
 * también si el reloj ha ido hacia atrás, para no quedarse sin preguntar.
 */
export function tocaComprobar(storage: Almacen): boolean {
	asegurarMain(storage);
	const ahora = nowMs();
	const filas = storage.sql
		.exec(
			`UPDATE _Main_Vigente
			    SET Comprobada_Ms = ?
			  WHERE Id = 1 AND (? - Comprobada_Ms >= ? OR ? < Comprobada_Ms)
			 RETURNING Id;`,
			ahora,
			ahora,
			INTERVALO_COMPROBAR_MAIN_MS,
			ahora,
		)
		.toArray();
	return filas.length > 0;
}

/**
 * Lo que se sabe puede haber cambiado (un aviso de cambio de licencia: traslado, anulación,
 * reembolso): la siguiente actividad pregunta sin esperar al minuto.
 */
export function olvidarComprobacion(storage: Almacen): void {
	asegurarMain(storage);
	storage.sql.exec("UPDATE _Main_Vigente SET Comprobada_Ms = 0 WHERE Id = 1;");
}
