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
// El cliente NO debe mirar el texto: un mensaje de libsql cambia de redacción entre versiones y esa
// clase de comparación se pudre sin que nada falle de forma visible.

/**
 * Firmas de error que NO cambian por repetirlas: la sentencia no encaja con el esquema o con los
 * datos del tenant. Reintentar da exactamente el mismo resultado las veinte veces.
 *
 * Se comparan en minúsculas y por `includes`, porque libsql antepone su propio prefijo
 * (`SQLite error: near "..."`) y a veces envuelve el mensaje en una capa de transporte.
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
	"datatype mismatch",
	"syntax error",
	"too many sql variables",
	"values were supplied", // "N values for M columns"
	"readonly database",
	// CFG-04: el DO rechaza una escritura que dejaría a Turso elegir la hora. Es el propio comando
	// el que está mal escrito: repetirlo da el mismo rechazo.
	"hora_no_determinista",
	// REV-22: su pareja. La hora del emisor viaja GUARDADA con la operación (la columna `Client_Now`
	// de la cola, o el mensaje que la trajo), así que si falta o está fuera de la deriva admisible,
	// faltará igual dentro de una hora. Y aquí esperar no es gratis: mientras una operación está en
	// duda, el atraso que va detrás no avanza.
	"missing_client_now",
] as const;

/**
 * Firmas que SÍ se arreglan solas: la nube no estaba disponible o estaba ocupada en ese instante.
 *
 * Van explícitas y se comprueban ANTES que las permanentes porque un mensaje de transporte puede
 * arrastrar dentro el texto de una sentencia. Entre "se cayó la conexión" y "la sentencia está
 * mal", lo primero manda: es el que se puede reintentar sin consecuencias.
 */
const TRANSITORIOS = [
	"database is locked",
	"sqlite_busy",
	"timeout",
	"timed out",
	"econnreset",
	"socket",
	"stream closed",
	"network",
	"fetch failed",
	"internal error",
	"service unavailable",
	"too many requests",
	"503",
	"502",
	"429",
] as const;

/**
 * ¿Es un rechazo definitivo?
 *
 * ⚠️ **Falla hacia TRANSITORIO**, y eso no es timidez: apartar una operación deja a la nube
 * divergente en esa fila, mientras que reintentarla de más sólo cuesta tiempo. Un error que no
 * sepamos clasificar acabará apartándose igual al agotar los intentos (`MAX_SUBIDA_ATTEMPTS`);
 * lo que esta función hace es ahorrarse esa espera cuando la respuesta ya se conoce.
 */
export function esRechazoPermanente(error: unknown): boolean {
	const texto = String((error as any)?.message ?? error ?? "").toLowerCase();
	if (!texto) return false;
	if (TRANSITORIOS.some((f) => texto.includes(f))) return false;
	return PERMANENTES.some((f) => texto.includes(f));
}

/**
 * ¿Es un fallo que RECONOCEMOS como pasajero? (REV-11)
 *
 * No es la negación de `esRechazoPermanente`: eso incluiría lo desconocido, y lo desconocido no se
 * puede prometer que se arregle solo. Aquí sólo entra lo que está en la lista de arriba, y sirve
 * para una cosa concreta: que el ack se lo diga a la Main y ésta **no gaste uno de los intentos**
 * que tiene la operación antes de apartarse.
 *
 * Lo que la Main no puede hacer es deducirlo del texto por su cuenta. Quien tiene la excepción
 * delante es el DO, y los mensajes de libsql cambian de redacción entre versiones: esa comparación,
 * hecha en el cliente, se pudre sin que nada falle de forma visible.
 */
export function esFalloPasajero(error: unknown): boolean {
	const texto = String((error as any)?.message ?? error ?? "").toLowerCase();
	if (!texto) return false;
	return TRANSITORIOS.some((f) => texto.includes(f));
}

/**
 * ¿Es un rechazo de CREDENCIALES de la base del tenant?
 *
 * Otra pregunta distinta de las de arriba: aquéllas miran la sentencia, ésta mira el token. Un 401
 * de Turso no se arregla reintentando ni se arregla apartando la operación --se arregla pidiendo
 * otro token--, así que quien lo ve tiene que dejarlo SALIR hasta `withTenantDbRetry`, que es quien
 * rota. Capturarlo por el camino convierte un token caducado en cincuenta operaciones sanas
 * apartadas (REV-04).
 */
export function isTursoAuthError(err: unknown): boolean {
	const msg = String((err as any)?.message ?? err ?? "").toLowerCase();

	return (
		msg.includes("server returned http status 401") ||
		msg.includes("http status 401") ||
		msg.includes("unauthorized")
	);
}
