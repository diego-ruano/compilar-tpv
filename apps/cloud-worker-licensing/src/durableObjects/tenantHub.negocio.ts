// src/durableObjects/tenantHub.negocio.ts
//
// DO-NEGOCIO · De qué negocio es este TenantHub, apuntado en su propia base.
//
// El Worker llega al objeto de un negocio por su nombre (`lib/hub.ts::hubDe`), y el negocio viaja
// otra vez en cada llamada: en la identidad de `ejecutarRuta`, en el `tenantId` de `aplicar`, de
// `leerParaLaWeb` o de `releerMain`, en la cabecera con la que se abre el WebSocket. Si el objeto se
// fiara del que llega, un fallo del programa que pidiera el objeto de un negocio y le pasara el
// identificador de otro leería o escribiría la base del primero con la identidad del segundo, sin
// que nada lo notara. Y un objeto que despierta de la hibernación por un mensaje de un socket no ha
// recibido ninguna llamada que le diga de quién es: sus eventos de salud saldrían sin negocio.
//
// Dónde se apunta: en el **sello de la base**, la tabla `_Negocio` del esquema (`0002_negocio.sql`,
// AUD-06), que es la misma con la que la base local de la Main dice de qué negocio es. Es estado
// local de cada base y no se replica; en la nube la escribe el alta (`MotorTenantHub.aprovisionar`)
// y no cambia nunca: el nombre de un Durable Object tampoco. Se va con todo lo demás al retirar el
// negocio (`borrarTodo`).
//
// ⚠️ Funciones libres y sin estado (SYNC-16). Aquí no se crea ninguna tabla: la del sello la crea
// la migración, así que un objeto sin base, o uno retirado, se queda vacío.

type Almacen = DurableObjectState["storage"];

/** ¿Tiene esta base su tabla del sello? Sin base, o con la `0002` todavía sin aplicar, no. */
function haySello(storage: Almacen): boolean {
	return (
		storage.sql
			.exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '_Negocio';")
			.toArray().length > 0
	);
}

/** El negocio apuntado, o `null` si esta base todavía no tiene ninguno. Sólo lee. */
export function negocioApuntado(storage: Almacen): string | null {
	if (!haySello(storage)) return null;
	const fila = storage.sql.exec("SELECT ID_Negocio FROM _Negocio WHERE Id = 1;").toArray()[0] as any;
	return String(fila?.ID_Negocio ?? "").trim() || null;
}

/**
 * Apunta el negocio de la base, si tiene dónde y no hay ninguno apuntado. El que ya esté se queda:
 * quien llama comprueba antes que es el suyo (`MotorTenantHub.negocioAjeno`). La misma sentencia
 * que sella la base de la Main (`tpv-infra-sqlite/src/sello.rs`). Devuelve si hay sello.
 */
export function apuntarNegocio(storage: Almacen, tenantId: string): boolean {
	if (!tenantId || !haySello(storage)) return false;
	storage.sql.exec(
		`INSERT INTO _Negocio (Id, ID_Negocio) VALUES (1, ?)
		 ON CONFLICT(Id) DO UPDATE SET ID_Negocio = excluded.ID_Negocio WHERE trim(_Negocio.ID_Negocio) = '';`,
		tenantId,
	);
	return true;
}
