// test/tenantHubErrores.test.ts
//
// SYNC-20 — ¿este rechazo se arregla reintentando, o no?
//
// De esta decisión depende que una operación irreparable pare la cola entera o se aparte. Los
// errores posibles tienen coste, y no el mismo:
//
//   - Llamar PERMANENTE a un fallo de la base aparta una venta que habría subido sola. Se pierde de
//     la nube un dato que sí existía.
//   - Llamar PASAJERO a un error de la sentencia no le gasta intentos y para el outbox para siempre.
//   - Llamar DESCONOCIDO a cualquiera de los dos sólo cuesta esperar: la operación se apartará al
//     agotar `MAX_SUBIDA_ATTEMPTS`.
//
// Por eso se falla hacia desconocido, y por eso estos casos importan. La base del negocio es el
// SQLite del propio Durable Object: los textos de abajo son los que dan SQLite y el runtime de
// Cloudflare (los de los límites, tal como salen en `test/sondaSqliteDo.test.ts`), no los de una
// base que se habla por la red.

import { describe, it, expect } from "vitest";

import { esBaseLlena, esFalloPasajero, esRechazoPermanente } from "../src/durableObjects/tenantHub.errores";
import { HubError } from "../src/lib/errorHttp";

type Veredicto = "permanente" | "pasajero" | "desconocido";

function veredicto(error: unknown): Veredicto {
	const permanente = esRechazoPermanente(error);
	const pasajero = esFalloPasajero(error);
	// Serían órdenes contradictorias para la Main: apartar ya y no contar el intento.
	expect(permanente && pasajero, String((error as any)?.message ?? error)).toBe(false);
	return permanente ? "permanente" : pasajero ? "pasajero" : "desconocido";
}

/** El texto con el que el SQLite del DO acompaña a sus errores: el mensaje y el código detrás. */
const sqlite = (mensaje: string, codigo = "SQLITE_ERROR") => new Error(`${mensaje}: ${codigo}`);

describe("por el código de un fallo nuestro, antes que por su texto", () => {
	const CASOS: [string, number, Veredicto][] = [
		// La operación está mal escrita: el mismo rechazo las veinte veces.
		["hora_no_determinista", 400, "permanente"],
		["missing_client_now", 400, "permanente"],
		["missing_op_id", 400, "permanente"],
		["missing_command_name", 400, "permanente"],
		["idempotency_command_mismatch", 409, "permanente"],
		["idempotency_payload_mismatch", 409, "permanente"],
		// No habla de la operación sino de cómo está la nube ahora: no se le gasta ningún intento.
		["tenant_db_not_provisioned", 404, "pasajero"],
		["tenant_db_migration_failed", 503, "pasajero"],
		["migration_altered", 500, "pasajero"],
		["main_offline", 400, "pasajero"],
		["main_volcando", 400, "pasajero"],
		["not_authenticated", 401, "pasajero"],
		["idempotency_operation_processing", 409, "pasajero"],
		// Un código que nadie ha clasificado no se inventa su veredicto.
		["algo_que_no_esta_en_ninguna_lista", 400, "desconocido"],
	];

	it.each(CASOS)("%s (%i) es %s", (codigo, status, esperado) => {
		expect(veredicto(new HubError(codigo, status))).toBe(esperado);
	});

	it("el código manda sobre lo que diga el mensaje", () => {
		// Los detalles de un `HubError` son su mensaje, y pueden traer cualquier texto.
		expect(veredicto(new HubError("main_offline", 400, { message: "no such table: Pagos" }))).toBe("pasajero");
		expect(veredicto(new HubError("missing_client_now", 400, { message: "database is locked" }))).toBe("permanente");
	});

	it("sin código, o con uno sin clasificar, decide el texto", () => {
		expect(veredicto(new HubError("otro_codigo", 500, { message: "no such column: Razon_Social" }))).toBe("permanente");
		// Un fallo que ha cruzado un RPC llega como un `Error` con el identificador por mensaje.
		expect(veredicto(new Error("hora_no_determinista: CURRENT_*"))).toBe("permanente");
		expect(veredicto(new Error("missing_client_now"))).toBe("permanente");
	});

	it("lo que algunos códigos llevan detrás no cuenta", () => {
		expect(veredicto(new HubError("  Main_Offline:detalle ", 400))).toBe("pasajero");
	});
});

describe("un fallo nuestro lanzado como Error se clasifica por el identificador con el que empieza", () => {
	it("una operación que no se deja montar es permanente, traiga lo que traiga detrás", () => {
		// Lo de detrás es un trozo de la operación: el SQL de un paso, el nombre de una referencia,
		// una clase de paso. Con una de las frases del runtime ahí dentro, este rechazo salía como
		// pasajero (y como una base llena): la Main lo reintentaba sin gastar intentos, y por la
		// cola de entrada era una base caída para siempre.
		for (const e of [
			new Error("value_step_no_evaluable_en_batch: SELECT 'readonly database'"),
			new Error("value_step_no_evaluable_en_batch: SELECT 'database or disk is full'"),
			new Error("missing_ref:database is locked"),
			new Error("bad_ref_value:timed out"),
			new Error("batch_unsupported_step_kind:internal error"),
			new Error("batch_unsupported_command_type:tenantDb.ping"),
			new Error("missing_transaction_steps"),
			new Error("invalid_transaction_step"),
			new Error("missing_sql"),
			new Error("invalid_sql_args"),
			new Error("unsupported_sql_arg"),
		]) {
			expect(veredicto(e), e.message).toBe("permanente");
			expect(esBaseLlena(e), e.message).toBe(false);
		}
	});

	it("uno que ha perdido su clase al cruzar un RPC conserva su veredicto", () => {
		expect(veredicto(new Error("tenant_db_not_provisioned"))).toBe("pasajero");
		expect(veredicto(new Error("main_offline"))).toBe("pasajero");
		expect(veredicto(new Error("idempotency_payload_mismatch"))).toBe("permanente");
	});

	it("un identificador sin clasificar no se vuelve pasajero por lo que lleve detrás", () => {
		for (const e of [
			new Error("algo_sin_clasificar: database is locked"),
			new Error("algo_sin_clasificar: SELECT 'readonly database'"),
			new Error("algo_sin_clasificar:was reset"),
		]) {
			expect(veredicto(e), e.message).toBe("desconocido");
			expect(esBaseLlena(e), e.message).toBe(false);
		}
	});

	it("un fallo con un código ya clasificado no es una base llena, diga lo que diga su mensaje", () => {
		expect(esBaseLlena(new HubError("main_offline", 400, { message: "database or disk is full" }))).toBe(false);
		expect(esBaseLlena(new HubError("missing_client_now", 400, { message: "readonly database" }))).toBe(false);
	});

	it("una frase no es un identificador: el runtime sigue reconociéndose", () => {
		expect(veredicto(new Error("internal error; reference = 0123abcd"))).toBe("pasajero");
		expect(veredicto(new Error("database is locked"))).toBe("pasajero");
		expect(esBaseLlena(new Error("database or disk is full"))).toBe(true);
	});
});

describe("un rechazo que NO se arregla reintentando", () => {
	const CASOS: [string, unknown][] = [
		// El caso que motivó todo esto: la Main manda una columna que el negocio no tiene.
		["una columna que no existe", sqlite("no such column: Razon_Social")],
		["una tabla que no existe", sqlite("no such table: Registros_Facturacion")],
		["una columna de más en un INSERT", sqlite("table Pagos has no column named Motivo_Baja")],
		["una función que no existe", sqlite("no such function: datetime_local")],
		["UNIQUE", sqlite("UNIQUE constraint failed: Usuarios.Email", "SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_UNIQUE)")],
		["FOREIGN KEY", sqlite("FOREIGN KEY constraint failed", "SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_FOREIGNKEY)")],
		["FOREIGN KEY aplazada (`loteEnBruto`)", new Error("FOREIGN KEY constraint failed: Detalle_Comanda → Comandas (aplazada)")],
		["NOT NULL", sqlite("NOT NULL constraint failed: Pagos.Importe", "SQLITE_CONSTRAINT")],
		["CHECK", sqlite("CHECK constraint failed: Comandas", "SQLITE_CONSTRAINT")],
		["un valor de dominio cerrado (RI-48)", sqlite("RI48: Pagos.Metodo_Pago no admitido", "SQLITE_CONSTRAINT")],
		["un horario que se solapa (RI-85)", sqlite("horario_solapado", "SQLITE_CONSTRAINT")],
		["un tipo que no encaja", sqlite("datatype mismatch", "SQLITE_MISMATCH")],
		["un error de sintaxis", sqlite('near "SELCT": syntax error at offset 0')],
		["valores que no cuadran con las columnas", sqlite("table Zonas has 5 columns but 4 values were supplied")],
		// Los límites del SQLite del DO: los pone la sentencia, no el momento.
		["más de 100 parámetros sin numerar", sqlite("too many SQL variables at offset 512")],
		["un parámetro por encima del ?100", sqlite("variable number must be between ?1 and ?100 at offset 519")],
		["un patrón de LIKE de más de 50 bytes", sqlite("LIKE or GLOB pattern too complex")],
		["más de 5 SELECT en un compuesto", sqlite("too many terms in compound SELECT")],
		["una sentencia de más de 100 KB", sqlite("statement too long", "SQLITE_TOOBIG")],
		["un valor que no cabe en una fila", sqlite("string or blob too big", "SQLITE_TOOBIG")],
		// Lo que el DO no deja ejecutar.
		["un PRAGMA fuera de su lista", sqlite("not authorized", "SQLITE_AUTH")],
		[
			"una transacción abierta desde el SQL",
			new Error(
				"To execute a transaction, please use the state.storage.transaction() or state.storage.transactionSync() APIs instead of the SQL BEGIN TRANSACTION or SAVEPOINT statements.",
			),
		],
		["algo que no es un Error", "no such column: X"],
	];

	it.each(CASOS)("%s", (_caso, error) => {
		expect(veredicto(error)).toBe("permanente");
	});
});

describe("un fallo que no habla de la operación", () => {
	const CASOS: [string, unknown][] = [
		["la base está ocupada", sqlite("database is locked", "SQLITE_BUSY")],
		["la base está ocupada, con su código extendido", sqlite("database is locked", "SQLITE_BUSY (extended: SQLITE_BUSY_SNAPSHOT)")],
		["una tabla está ocupada", sqlite("database table is locked: Zonas", "SQLITE_LOCKED")],
		["la base no se ha podido leer o escribir", sqlite("disk I/O error", "SQLITE_IOERR")],
		["la base no se ha podido escribir, con su código extendido", sqlite("disk I/O error", "SQLITE_IOERR (extended: SQLITE_IOERR_WRITE)")],
		["la base no se ha podido sincronizar, sólo con el código extendido", sqlite("disk I/O error", "SQLITE_IOERR_FSYNC")],
		["no queda memoria", sqlite("out of memory", "SQLITE_NOMEM")],
		// El runtime del Durable Object, con sus frases.
		["el objeto está saturado", new Error("Durable Object is overloaded. Too many requests queued.")],
		[
			"la cuenta genera demasiada carga",
			new Error("Your account is generating too much load on Durable Objects. Please back off and try again later."),
		],
		["se ha desplegado código nuevo", new Error("Durable Object reset because its code was updated.")],
		[
			"esta versión ya no llega a su almacenamiento",
			new Error("The Durable Object's code has been updated, this version can no longer access storage."),
		],
		[
			"el almacenamiento no contestó a tiempo",
			new Error("Durable Object storage operation exceeded timeout which caused object to be reset."),
		],
		[
			"falló una escritura del almacenamiento",
			new Error("Internal error in Durable Object storage write caused object to be reset."),
		],
		["pasó de su memoria", new Error("Durable Object exceeded its memory limit and was reset.")],
		["el objeto se ha mudado", new Error("Cannot access storage because object has moved to a different machine.")],
		["un fallo pasajero de otro nodo", new Error("Cannot resolve Durable Object due to transient issue on remote node.")],
		["se perdió la conexión", new Error("Network connection lost.")],
		["algo tardó demasiado", new Error("The request timed out")],
		["un error interno de Cloudflare", new Error("internal error; reference = 0123abcd")],
		["algo que no es un Error", "database is locked"],
	];

	it.each(CASOS)("%s: es pasajero y no se aparta", (_caso, error) => {
		expect(veredicto(error)).toBe("pasajero");
	});

	it("manda sobre el texto de SQL que arrastre dentro", () => {
		// Entre «el objeto se ha reiniciado» y «la sentencia está mal», lo primero es lo que se
		// puede reintentar sin consecuencias.
		expect(
			veredicto(new Error("Durable Object reset because its code was updated. (UNIQUE constraint failed: Pagos.ID_Pago)")),
		).toBe("pasajero");
	});
});

describe("una base llena no aparta nada", () => {
	const LLENA = [
		sqlite("database or disk is full", "SQLITE_FULL"),
		sqlite("attempt to write a readonly database", "SQLITE_READONLY"),
		sqlite("attempt to write a readonly database", "SQLITE_READONLY (extended: SQLITE_READONLY_DBMOVED)"),
		// Dicho por algo que no es una sentencia: sin el código detrás.
		new Error("database or disk is full"),
	];

	it("es pasajero para la operación: ni se aparta ni se le gasta un intento", () => {
		// Hacerle sitio a la base es cosa de una persona. Apartar mientras tanto dejaría fuera de la
		// nube todas las ventas que llegaran, que están bien.
		for (const e of LLENA) expect(veredicto(e)).toBe("pasajero");
	});

	it("y se reconoce para avisar de ella", () => {
		for (const e of LLENA) expect(esBaseLlena(e)).toBe(true);
		expect(esBaseLlena(sqlite("database is locked", "SQLITE_BUSY"))).toBe(false);
		expect(esBaseLlena(new HubError("main_offline", 400))).toBe(false);
		expect(esBaseLlena(undefined)).toBe(false);
	});
});

describe("ante la duda, ni se aparta ni se promete que se arregle solo", () => {
	it("lo desconocido cuenta como intento", () => {
		// Es la regla que impide que este arreglo se convierta en una forma nueva de perder datos, y
		// también en una forma nueva de atascar la cola.
		for (const e of [new Error("algo raro ha pasado"), new Error(""), undefined, null, {}, 42]) {
			expect(veredicto(e)).toBe("desconocido");
		}
	});

	it("el nombre de una tabla o de una columna no convierte un rechazo en pasajero", () => {
		// El mensaje de SQLite lleva identificadores. Con firmas de una palabra (`socket`, `network`,
		// `timeout`, `reset`, `503`), una columna que se llamara así sacaba este rechazo, que es
		// permanente, como pasajero: no gastaba intentos y paraba el outbox para siempre.
		for (const nombre of [
			"Socket_Id",
			"Network_Config",
			"Timeout_Ms",
			"Reset_At",
			"Stream_Closed",
			"Overloaded",
			"Locked",
			"Full",
			"Busy",
			"Internal",
			"Codigo_503",
			"Fetch_Failed",
		]) {
			expect(veredicto(sqlite(`no such column: ${nombre}`)), nombre).toBe("permanente");
			expect(veredicto(sqlite(`UNIQUE constraint failed: ${nombre}.ID`, "SQLITE_CONSTRAINT")), nombre).toBe("permanente");
		}
	});

	it("en un mensaje de SQLite decide su código, no lo que la sentencia haya puesto delante", () => {
		// El texto de un mensaje de SQLite lo escribe en parte quien escribió la sentencia: el nombre
		// de una columna, de una tabla, o el trozo de SQL que no se entiende. Con un nombre que se
		// llamara como un código o como una de las frases, este rechazo, que es permanente, salía
		// como pasajero (y hasta como una base llena): no gastaba intentos y paraba el outbox. Los
		// tres primeros son los textos que da el SQLite del DO (`test/sondaSqliteDo.test.ts`).
		const DE_LA_SENTENCIA = [
			sqlite("no such column: sqlite_full at offset 7"),
			sqlite("no such table: sqlite_busy"),
			sqlite("no such table: database is locked"),
			sqlite("no such column: sqlite_readonly at offset 12"),
			sqlite("table Zonas has no column named sqlite_ioerr"),
			sqlite("no such table: database or disk is full"),
			sqlite('near "timed out": syntax error at offset 28'),
			sqlite("no such function: was reset"),
			sqlite("UNIQUE constraint failed: internal error.ID", "SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_UNIQUE)"),
		];
		for (const e of DE_LA_SENTENCIA) {
			expect(veredicto(e), e.message).toBe("permanente");
			expect(esBaseLlena(e), e.message).toBe(false);
		}
	});

	it("un código de SQLite que no es ni de la sentencia ni del estado de la base no se inventa su veredicto", () => {
		for (const e of [
			sqlite("interrupted", "SQLITE_INTERRUPT"),
			sqlite("database disk image is malformed", "SQLITE_CORRUPT"),
			// Con una frase de las del runtime delante: sigue siendo un mensaje de SQLite.
			sqlite("internal error", "SQLITE_INTERNAL"),
		]) {
			expect(veredicto(e), e.message).toBe("desconocido");
		}
	});

	it("los fallos de una base que se hablaba por la red ya no tienen firma", () => {
		// La base del negocio está en el propio DO: nada de esto puede salir de ella. Si alguno
		// llegara, no se reconoce: cuenta como intento, que es el lado que no pierde nada.
		for (const msg of ["fetch failed", "ECONNRESET", "stream closed", "503 Service Unavailable", "429 Too Many Requests"]) {
			expect(veredicto(new Error(msg)), msg).toBe("desconocido");
		}
	});
});
