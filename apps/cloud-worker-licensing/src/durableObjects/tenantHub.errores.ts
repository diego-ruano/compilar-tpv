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
//   1. **Por el código**, si el fallo es uno nuestro (`HubError`): lo escribió quien lo lanzó y no
//      depende de ninguna redacción.
//   2. **Por el texto**, si viene de SQLite o del runtime del Durable Object. Primero lo que es un
//      estado de la base o del objeto (pasajero), después lo que es de la sentencia (permanente).
//   3. **Desconocido** todo lo demás: ni se aparta ya ni se promete que se arregle solo. Cuenta
//      como intento y acabará apartándose si no deja de fallar.
//
// La base del negocio es el SQLite de este mismo DO: aquí no llega ningún fallo de red. Por eso las
// firmas de texto son las de SQLite y las del runtime, y van con sus espacios o con su código
// (`is full`, `sqlite_full`), no con palabras sueltas. El mensaje de SQLite lleva nombres de tablas
// y columnas (`no such column: X`), y una firma como `socket`, `network`, `timeout` o `503`, que
// era de cuando la base se hablaba por HTTP, podía casar con uno: ese fallo, que es permanente,
// salía como pasajero, no gastaba intentos y paraba el outbox para siempre.

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
]);

/**
 * Lo que dice el código cuando el fallo NO habla de la operación sino de cómo está la nube en este
 * momento: no hay base, no se ha podido poner al día su esquema, no hay Main, la sesión ya no es la
 * de la Main. La operación es buena y entrará cuando eso cambie: no se le gasta ningún intento.
 */
const CODIGOS_PASAJEROS: ReadonlySet<string> = new Set([
	"tenant_db_not_provisioned",
	// El esquema de la base del negocio no cuadra con el del worker: lo arreglamos nosotros, no un
	// reintento, pero apartar por ello las ventas de un negocio entero las dejaría fuera de la nube.
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
 * y a veces delante un prefijo (`near "…"`).
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
 * La base está llena o no se deja escribir. No es culpa de ninguna operación ni se arregla sola:
 * hay que hacerle sitio. Mientras tanto no se aparta nada (lo apartado se quedaría fuera de la
 * nube), y quien lo ve avisa (`MotorTenantHub.avisarBaseLlena`).
 */
const BASE_LLENA = [
	"database or disk is full",
	"sqlite_full",
	"readonly database",
	"sqlite_readonly",
] as const;

/**
 * Firmas que NO hablan de la operación: la base o el objeto no estaban para atenderla en ese
 * instante. Van explícitas y se comprueban ANTES que las permanentes: entre «el objeto se ha
 * reiniciado» y «la sentencia está mal», lo primero manda, porque es lo que se puede reintentar sin
 * consecuencias.
 *
 * Todas llevan un espacio o son un código de SQLite: no pueden casar con el nombre de una tabla o
 * de una columna dentro de un mensaje de SQLite (ver la cabecera).
 */
const TRANSITORIOS = [
	...BASE_LLENA,
	// SQLite: la base está ocupada, o no ha podido leer o escribir.
	"database is locked",
	"sqlite_busy",
	"sqlite_locked",
	"disk i/o error",
	"sqlite_ioerr",
	"out of memory",
	"sqlite_nomem",
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

/** El código de un fallo nuestro, sin lo que algunos llevan detrás (`escritura_solo_en_main:Pagos`). */
function codigoDe(error: unknown): string | null {
	if (!(error instanceof HubError)) return null;
	return String(error.code ?? "").split(":")[0].trim().toLowerCase() || null;
}

function textoDe(error: unknown): string {
	return String((error as any)?.message ?? error ?? "").toLowerCase();
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
	if (TRANSITORIOS.some((f) => texto.includes(f))) return false;
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
	return TRANSITORIOS.some((f) => texto.includes(f));
}

/** ¿La base está llena o en sólo lectura? Pasajero para la operación, y hay que avisar. */
export function esBaseLlena(error: unknown): boolean {
	const texto = textoDe(error);
	return BASE_LLENA.some((f) => texto.includes(f));
}
