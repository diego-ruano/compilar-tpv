// src/durableObjects/tenantHub.errores.ts
//
// ¿Este fallo se arregla reintentando, o no? (SYNC-20)
//
// El outbox de la Main es una cola ORDENADA: sus operaciones se apoyan unas en otras, así que el
// drenado sube la primera y no pasa a la segunda hasta que la nube confirma. Mientras el `apply_ack`
// sólo llevaba un texto de error, el cliente no podía distinguir "no ha salido" de "no va a salir",
// y hacía lo único prudente que puede hacerse sin esa información: parar y reintentar. Para
// siempre, con todas las ventas de detrás detenidas, y sin decírselo a nadie.
//
// Quien tiene la excepción delante es el DO, así que la clasificación vive aquí y viaja en el ack.
// El cliente NO debe mirar el texto: un mensaje cambia de redacción entre versiones y esa clase de
// comparación se pudre sin que nada falle de forma visible.
//
// Son tres veredictos, y se decide en este orden:
//
//   1. **Por el código**, si el fallo es uno nuestro: el de un `HubError`, o el identificador con el
//      que empieza el mensaje de un `Error` (`missing_sql`, `missing_ref:total`). Lo escribió quien
//      lo lanzó y no depende de ninguna redacción. Lo que lleve detrás es un trozo de la operación
//      (su SQL, el nombre de una referencia) y no se lee como si fuera una frase del runtime.
//   2. **Por el código de SQLite**, si el mensaje es suyo. El SQLite del DO cierra sus mensajes
//      con el código (`…: SQLITE_BUSY`, `…: SQLITE_CONSTRAINT (extended: …)`), y es lo único que
//      dice si el fallo es del estado de la base (pasajero). Lo que va delante lo escribe en parte
//      quien escribió la sentencia: lleva nombres de tablas y de columnas, y trozos del SQL.
//   3. **Por el texto**: en un mensaje de SQLite, sólo para saber si es de la sentencia
//      (permanente); en lo que no es de SQLite (el runtime del Durable Object), las frases con las
//      que dice que no estaba para atender (pasajero).
//   4. **Desconocido** todo lo demás: ni se aparta ya ni se promete que se arregle solo. Cuenta
//      como intento y acabará apartándose si no deja de fallar.
//
// La base del negocio es el SQLite de este mismo DO: aquí no llega ningún fallo de red. Por eso no
// hay firmas como `socket`, `network`, `timeout` o `503`, que eran de cuando la base se hablaba
// por HTTP. Y por eso lo pasajero de un mensaje de SQLite no se busca en su texto: `no such column:
// sqlite_full` o `no such table: database is locked` son fallos de la sentencia, permanentes, y
// leídos por su texto salían como pasajeros: no gastaban intentos y paraban el outbox para siempre.

import { HubError } from "../lib/errorHttp";

/**
 * Lo que dice el código de un `HubError` cuando NO cambia por repetirlo: es la operación la que
 * está mal escrita, y la misma operación dará el mismo rechazo las veinte veces.
 */
const CODIGOS_PERMANENTES: ReadonlySet<string> = new Set([
	// CFG-04: una escritura que dejaría a la base elegir la hora.
	"hora_no_determinista",
	// REV-22: su pareja. La hora del emisor viaja GUARDADA con la operación (la columna `Client_Now`
	// de la cola, o el mensaje que la trajo), así que si falta o está fuera de la deriva admisible,
	// faltará igual dentro de una hora. Y aquí esperar no es gratis: mientras una operación está en
	// duda, el atraso que va detrás no avanza.
	"missing_client_now",
	// Una operación sin identidad no la tendrá en el reintento.
	"missing_op_id",
	"missing_command_name",
	// El mismo `Op_Id` ya se aplicó con otro comando o con otro contenido: éste no va a entrar.
	"idempotency_command_mismatch",
	"idempotency_payload_mismatch",
	// La operación no se deja montar (`tenantHub.lote.ts`, `tenantHub.sentencias.ts`): sin pasos, con
	// un paso o un comando de una clase que no existe, sin SQL, con un argumento que no es un valor,
	// con una referencia a un paso que no está o un paso `value` que no se sabe evaluar. Sólo depende
	// de lo que trae la operación, que no cambia.
	"missing_transaction_steps",
	"invalid_transaction_step",
	"batch_unsupported_step_kind",
	"batch_unsupported_command_type",
	"missing_sql",
	"invalid_sql_args",
	"unsupported_sql_arg",
	"missing_ref",
	"bad_ref_value",
	"value_step_no_evaluable_en_batch",
]);

/**
 * Lo que dice el código cuando el fallo NO habla de la operación sino de cómo está la nube en este
 * momento: no hay base, no se ha podido poner al día su esquema, no hay Main, la sesión ya no es la
 * de la Main. La operación es buena y entrará cuando eso cambie: no se le gasta ningún intento.
 */
const CODIGOS_PASAJEROS: ReadonlySet<string> = new Set([
	"tenant_db_not_provisioned",
	// El esquema de la base del negocio no ha podido ponerse al día, o no cuadra con el del worker
	// (`MotorTenantHub.getTenantDb`): lo arreglamos nosotros, no un reintento, pero apartar por ello
	// las ventas de un negocio entero las dejaría fuera de la nube.
	"tenant_db_migration_failed",
	"migration_altered",
	"main_offline",
	"main_volcando",
	"not_authenticated",
	// Su `Op_Id` chocó y la fila aún no se deja leer: la siguiente vuelta la encuentra.
	"idempotency_operation_processing",
]);

/**
 * Firmas de SQLite que NO cambian por repetirlas: la sentencia no encaja con el esquema, con los
 * datos del negocio o con los límites del SQLite del DO. Reintentar da exactamente el mismo
 * resultado.
 *
 * Se comparan en minúsculas y por `includes`: el runtime añade detrás el código (`: SQLITE_ERROR`)
 * y a veces delante un prefijo (`near "…"`). Sólo se llega aquí con un fallo que no es pasajero.
 */
const PERMANENTES = [
	"no such column",
	"no such table",
	"no such function",
	"has no column named",
	"unique constraint failed",
	"not null constraint failed",
	"foreign key constraint failed",
	"check constraint failed",
	// Los valores de dominio cerrados son triggers (RI-48), y las guardas de los horarios (RI-85).
	"ri48:",
	"horario_solapado",
	"horario_invalido",
	"datatype mismatch",
	"syntax error",
	"values were supplied", // "N values for M columns"
	// Los límites del SQLite del DO (docs/arquitectura/worker.md): los pone la sentencia, no el
	// momento. Más de 100 parámetros, un patrón de `LIKE` de más de 50 bytes, más de 5 `SELECT` en
	// un compuesto, una sentencia de más de 100 KB o un valor que no cabe en una fila.
	"too many sql variables",
	"variable number must be between", // un `?101`
	"like or glob pattern too complex",
	"too many terms in compound select",
	"statement too long",
	"string or blob too big",
	// Lo que el DO no deja ejecutar: un `PRAGMA` fuera de su lista, un `ATTACH`, y abrir una
	// transacción desde el SQL (`BEGIN`, `SAVEPOINT`).
	"not authorized",
	"sql begin transaction or savepoint",
	// CFG-04 y REV-22, cuando llegan como texto (un error que ha cruzado un RPC pierde su código).
	"hora_no_determinista",
	"missing_client_now",
] as const;

/** RI-85: señales propias del esquema, con el mismo mensaje en Main y Handy. */
export function errorHorario(error: unknown): { error: string; status: number; message: string } | null {
	const texto = String((error as { message?: string })?.message ?? error);
	if (texto.includes("horario_solapado")) return { error: "horario_solapado", status: 409, message: "Ese horario se solapa con otro tramo del trabajador. Corrige las horas antes de guardar." };
	if (texto.includes("horario_invalido")) return { error: "horario_invalido", status: 400, message: "El horario contiene una fecha o unas horas inválidas." };
	return null;
}

/**
 * El código con el que el SQLite del DO cierra sus mensajes, en minúsculas: `no such table: X:
 * SQLITE_ERROR`, `UNIQUE constraint failed: T.C: SQLITE_CONSTRAINT (extended:
 * SQLITE_CONSTRAINT_UNIQUE)`. Los textos, tal como salen, en `test/sondaSqliteDo.test.ts`.
 */
const CIERRE_DE_SQLITE = /: (sqlite_[a-z0-9_]+)(?: \(extended: sqlite_[a-z0-9_]+\))?\s*$/;

/** El código de SQLite de un mensaje, o `null` si el mensaje no es de SQLite. */
function codigoSqlite(texto: string): string | null {
	return CIERRE_DE_SQLITE.exec(texto)?.[1] ?? null;
}

/** ¿Es `codigo` uno de la lista, o una variante suya (`sqlite_ioerr_write`)? */
function esDe(codigo: string, lista: readonly string[]): boolean {
	return lista.some((c) => codigo === c || codigo.startsWith(`${c}_`));
}

/**
 * La base está llena o no se deja escribir. No es culpa de ninguna operación ni se arregla sola:
 * hay que hacerle sitio. Mientras tanto no se aparta nada (lo apartado se quedaría fuera de la
 * nube), y quien lo ve avisa (`MotorTenantHub.avisarBaseLlena`).
 */
const SQLITE_BASE_LLENA = ["sqlite_full", "sqlite_readonly"] as const;

/** Lo mismo, dicho por algo que no es una sentencia (el almacenamiento del objeto). */
const FRASES_DE_BASE_LLENA = ["database or disk is full", "readonly database"] as const;

/**
 * Códigos de SQLite que NO hablan de la sentencia sino del estado de la base: llena, ocupada, sin
 * poder leer o escribir, sin memoria.
 */
const SQLITE_PASAJEROS = [
	...SQLITE_BASE_LLENA,
	"sqlite_busy",
	"sqlite_locked",
	"sqlite_ioerr",
	"sqlite_nomem",
] as const;

/**
 * Frases que NO hablan de la operación: la base o el objeto no estaban para atenderla en ese
 * instante. Sólo se buscan en lo que no es un mensaje de SQLite (ver la cabecera), y se comprueban
 * ANTES que las permanentes: entre «el objeto se ha reiniciado» y «la sentencia está mal», lo
 * primero manda, porque es lo que se puede reintentar sin consecuencias.
 */
const FRASES_PASAJERAS = [
	...FRASES_DE_BASE_LLENA,
	// El estado de la base, cuando no lo dice una sentencia.
	"database is locked",
	"disk i/o error",
	"out of memory",
	// El runtime del Durable Object: saturado, reiniciado (un despliegue, un fallo de su
	// almacenamiento, un límite de memoria o de CPU) o con su almacenamiento sin contestar.
	"is overloaded",
	"too much load",
	"object reset",
	"to be reset",
	"was reset",
	"no longer access storage",
	"different machine",
	"transient issue",
	"connection lost",
	"exceeded timeout",
	"timed out",
	"internal error",
] as const;

function textoDe(error: unknown): string {
	return String((error as any)?.message ?? error ?? "").toLowerCase();
}

/**
 * El identificador con el que empieza un fallo nuestro lanzado como `Error`, o que ha perdido su
 * clase al cruzar un RPC: `missing_sql`, `missing_ref:total`, `value_step_no_evaluable_en_batch:
 * SELECT …`. Con un guion bajo al menos, y seguido de `:` o del final: ningún mensaje de SQLite ni
 * del runtime empieza así.
 */
const EMPIEZA_POR_IDENTIFICADOR = /^([a-z][a-z0-9]*(?:_[a-z0-9]+)+)(?=:|$)/;

function identificadorDe(texto: string): string | null {
	return EMPIEZA_POR_IDENTIFICADOR.exec(texto)?.[1] ?? null;
}

/** El código de un fallo nuestro, sin lo que algunos llevan detrás (`escritura_solo_en_main:Pagos`). */
function codigoDe(error: unknown): string | null {
	if (error instanceof HubError) return String(error.code ?? "").split(":")[0].trim().toLowerCase() || null;
	return identificadorDe(textoDe(error));
}

/** ¿Tiene este fallo un código nuestro que ya dice de qué clase es? */
function estaClasificado(error: unknown): boolean {
	const codigo = codigoDe(error);
	return codigo !== null && (CODIGOS_PERMANENTES.has(codigo) || CODIGOS_PASAJEROS.has(codigo));
}

/** ¿Dice este texto que la base o el objeto no estaban para atender? */
function esPasajeroPorTexto(texto: string): boolean {
	const sqlite = codigoSqlite(texto);
	// Un mensaje de SQLite: decide su código, no lo que lleve delante.
	if (sqlite !== null) return esDe(sqlite, SQLITE_PASAJEROS);
	// Un fallo nuestro con su identificador delante: lo que lleva detrás es un trozo de la operación.
	if (identificadorDe(texto) !== null) return false;
	return FRASES_PASAJERAS.some((f) => texto.includes(f));
}

/**
 * ¿Es un rechazo definitivo?
 *
 * ⚠️ **Falla hacia TRANSITORIO**, y eso no es timidez: apartar una operación deja a la nube
 * divergente en esa fila, mientras que reintentarla de más sólo cuesta tiempo. Un error que no
 * sepamos clasificar acabará apartándose igual al agotar los intentos (`MAX_SUBIDA_ATTEMPTS`);
 * lo que esta función hace es ahorrarse esa espera cuando la respuesta ya se conoce.
 */
export function esRechazoPermanente(error: unknown): boolean {
	const codigo = codigoDe(error);
	if (codigo !== null) {
		if (CODIGOS_PERMANENTES.has(codigo)) return true;
		if (CODIGOS_PASAJEROS.has(codigo)) return false;
	}
	const texto = textoDe(error);
	if (!texto) return false;
	if (esPasajeroPorTexto(texto)) return false;
	return PERMANENTES.some((f) => texto.includes(f));
}

/**
 * ¿Es un fallo que RECONOCEMOS como pasajero? (REV-11)
 *
 * No es la negación de `esRechazoPermanente`: eso incluiría lo desconocido, y lo desconocido no se
 * puede prometer que se arregle solo. Aquí sólo entra lo que está en las listas de arriba, y sirve
 * para una cosa concreta: que el ack se lo diga a la Main y ésta **no gaste uno de los intentos**
 * que tiene la operación antes de apartarse.
 *
 * Lo que la Main no puede hacer es deducirlo del texto por su cuenta. Quien tiene la excepción
 * delante es el DO, y los mensajes cambian de redacción entre versiones: esa comparación, hecha en
 * el cliente, se pudre sin que nada falle de forma visible.
 */
export function esFalloPasajero(error: unknown): boolean {
	const codigo = codigoDe(error);
	if (codigo !== null) {
		if (CODIGOS_PASAJEROS.has(codigo)) return true;
		if (CODIGOS_PERMANENTES.has(codigo)) return false;
	}
	const texto = textoDe(error);
	if (!texto) return false;
	return esPasajeroPorTexto(texto);
}

/** ¿La base está llena o en sólo lectura? Pasajero para la operación, y hay que avisar. */
export function esBaseLlena(error: unknown): boolean {
	// Un fallo nuestro ya dice lo que es, y no es esto.
	if (estaClasificado(error)) return false;
	const texto = textoDe(error);
	const sqlite = codigoSqlite(texto);
	if (sqlite !== null) return esDe(sqlite, SQLITE_BASE_LLENA);
	if (identificadorDe(texto) !== null) return false;
	return FRASES_DE_BASE_LLENA.some((f) => texto.includes(f));
}
