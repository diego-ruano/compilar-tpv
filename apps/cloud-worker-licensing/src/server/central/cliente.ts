// src/server/central/cliente.ts
//
// Cómo se le habla a la base central desde fuera de su objeto: una `Base` (`lib/sql.ts`) sobre el
// RPC de `BaseCentral` (`durableObjects/baseCentral.ts`), más `operar` para sus operaciones
// (`operaciones/registro.ts`). Lo usan el Worker (`server/db.ts::getDb`) y el `TenantHub`
// (`getCentralDb`, con plazo).
//
// - Los argumentos salen convertidos por el enlace estricto de la central (`enlace.ts`): lo que no se
//   puede guardar lanza aquí, sin llegar a viajar.
// - Cada viaje suma al tramo `central` de la petición (`observability/tiempos.ts`).
// - Cada viaje pide su stub: uno que ha lanzado puede haberse quedado roto, y Cloudflare aconseja
//   no volver a usarlo (https://developers.cloudflare.com/durable-objects/best-practices/error-handling/).
//   Pedirlo no sale del isolate.
// - Un error nunca se convierte en filas vacías: «la central no contesta» no puede leerse como «esa
//   licencia no existe». Lo que el objeto contesta que no ha hecho (también un error de SQL) sale
//   como `ErrorDeLaCentral`, con su código; lo que la plataforma marca como saturado o pasajero, y
//   un plazo vencido, como `CentralNoDisponible`, con los códigos del objeto de un negocio que no
//   puede atender (`lib/enElHub.ts`); cualquier otro fallo del viaje, tal cual.
// - Con `plazoMs`, cada viaje tiene ese plazo. Un RPC no se puede cancelar: vencido el plazo, la
//   llamada sigue viva y nadie la espera, y si escribía, escribe cuando la central la atienda. El
//   plazo libera a quien espera, no al objeto que la hizo: mientras la llamada no termina es E/S
//   pendiente, y ese objeto no puede hibernar.

import type { BaseCentral } from "../../durableObjects/baseCentral";
import type { CodigoDeLaCentral, RespuestaDeLaCentral } from "../../durableObjects/baseCentral.rpc";
import { aResultado } from "../../durableObjects/sqliteDelObjeto";
import { HubError } from "../../lib/errorHttp";
import type { Base } from "../../lib/sql";
import { medirTramo } from "../../observability/tiempos";
import { enlazar } from "./enlace";
import type { Operaciones } from "./operaciones/registro";

/** La base central: sentencias sueltas, lotes todo o nada, y sus operaciones. */
export type ClienteCentral = Base & {
	/** Una operación de la central (`operaciones/registro.ts`), entera o nada: su resultado, o lanza. */
	operar<N extends keyof Operaciones>(
		nombre: N,
		datos: Parameters<Operaciones[N]>[1],
	): Promise<ReturnType<Operaciones[N]>>;
};

/** Con qué estado HTTP sale cada cosa que el objeto contesta que no ha hecho. */
const ESTADO: Record<CodigoDeLaCentral, number> = {
	// Es de quien la administra (o de un despliegue a medias): para quien llama, la nube no puede
	// atender ahora mismo.
	central_sin_aprovisionar: 503,
	central_operacion_desconocida: 503,
	central_migracion_alterada: 503,
	central_migracion_fallida: 503,
	central_restauracion_a_medias: 503,
	central_vuelta_en_curso: 503,
	// Lo de siempre con una base: un error de SQL sale como un 500.
	central_error_sql: 500,
	central_operacion_fallida: 500,
	// Un fallo del programa: una sentencia que la central no ejecuta.
	central_sentencia_prohibida: 500,
	// Lo que sólo pide la administración (y la copia diaria, el cron).
	central_ya_aprovisionada: 409,
	central_copia_fallida: 500,
	central_copia_inservible: 422,
	central_instante_fuera_de_plazo: 400,
	central_vuelta_no_disponible: 501,
	central_vuelta_a_la_vez: 409,
	central_sin_vuelta_preparada: 409,
	central_vuelta_rechazada: 422,
};

/** El estado HTTP con el que sale lo que el objeto de la central contesta que no ha hecho. */
export function estadoHttpDe(codigo: CodigoDeLaCentral): number {
	return ESTADO[codigo];
}

/**
 * Lo que el objeto de la central contesta que no ha hecho, con su código (`baseCentral.rpc.ts`). El
 * detalle (el texto de SQLite, el motivo) va en el mensaje, que ven el log y Sentry; la respuesta
 * HTTP sólo lleva el código.
 */
export class ErrorDeLaCentral extends HubError {
	declare code: CodigoDeLaCentral;

	constructor(
		code: CodigoDeLaCentral,
		readonly detalle?: string,
	) {
		super(code, estadoHttpDe(code));
		this.name = "ErrorDeLaCentral";
		if (detalle !== undefined) this.message = `${code}: ${detalle}`;
	}
}

/** Por qué no ha podido atender la central: saturada, un fallo pasajero de la plataforma, o tarde. */
type MotivoDeNoDisponible = "saturada" | "pasajera" | "plazo";

/**
 * La central no ha podido atender la llamada. No es un fallo del programa: se puede repetir. Sale
 * con los mismos códigos que el objeto de un negocio que no puede atender (`lib/enElHub.ts`):
 * saturada, `hub_overloaded`; lo demás, `hub_unavailable`.
 */
export class CentralNoDisponible extends HubError {
	constructor(
		readonly motivo: MotivoDeNoDisponible,
		causa?: unknown,
	) {
		super(motivo === "saturada" ? "hub_overloaded" : "hub_unavailable", 503);
		this.name = "CentralNoDisponible";
		this.cause = causa;
	}
}

/**
 * Lo que Cloudflare marca en el error de una llamada a un Durable Object
 * (https://developers.cloudflare.com/durable-objects/best-practices/error-handling/): `overloaded`,
 * el objeto tiene más de lo que puede atender; `retryable`, un fallo pasajero de la plataforma.
 */
function noDisponibleSiLoEs(error: unknown): unknown {
	const fallo = (error ?? {}) as { overloaded?: unknown; retryable?: unknown };
	if (fallo.overloaded === true) return new CentralNoDisponible("saturada", error);
	if (fallo.retryable === true) return new CentralNoDisponible("pasajera", error);
	return error;
}

/** `llamada`, o `CentralNoDisponible` si no ha contestado en `plazoMs`. */
function conPlazo<T>(llamada: Promise<T>, plazoMs: number | undefined): Promise<T> {
	if (!plazoMs) return llamada;
	// Si vence el plazo, la llamada sigue viva y nadie la espera: su fallo, si llega, no puede salir
	// como un rechazo sin recoger.
	llamada.catch(() => {});
	let temporizador: ReturnType<typeof setTimeout> | undefined;
	const vencido = new Promise<never>((_, rechazar) => {
		temporizador = setTimeout(() => rechazar(new CentralNoDisponible("plazo")), plazoMs);
	});
	// El temporizador no vive más que la llamada: uno pendiente sería otra cosa que no deja hibernar
	// al objeto que espera.
	return Promise.race([llamada, vencido]).finally(() => clearTimeout(temporizador));
}

/** Un viaje a la central: su respuesta si la ha hecho, o el error que corresponde. */
function viaje<T>(pedir: () => Promise<RespuestaDeLaCentral<T>>, plazoMs: number | undefined): Promise<T> {
	return medirTramo("central", async () => {
		let respuesta: RespuestaDeLaCentral<T>;
		try {
			respuesta = await conPlazo(pedir(), plazoMs);
		} catch (error) {
			throw noDisponibleSiLoEs(error);
		}
		if (!respuesta.ok) throw new ErrorDeLaCentral(respuesta.error, respuesta.detalle);
		return respuesta.valor;
	});
}

/**
 * La base central del objeto que da `pedirStub`: en producción, `() => centralDe(env)`
 * (`lib/objetosDelNegocio.ts`). Se le pide un stub nuevo en cada viaje.
 */
export function clienteCentral(
	pedirStub: () => DurableObjectStub<BaseCentral>,
	opciones: { plazoMs?: number } = {},
): ClienteCentral {
	const { plazoMs } = opciones;
	// Cada llamada RPC se espera en el acto (`return await`): una que fallara sin nadie esperándola
	// todavía contaría como un rechazo sin recoger.
	return {
		async execute(sentencia) {
			const enlazada = enlazar(sentencia);
			return aResultado(await viaje(async () => await pedirStub().ejecutar(enlazada), plazoMs));
		},
		async batch(sentencias) {
			const enlazadas = sentencias.map(enlazar);
			return (await viaje(async () => await pedirStub().lote(enlazadas), plazoMs)).map(aResultado);
		},
		operar<N extends keyof Operaciones>(nombre: N, datos: Parameters<Operaciones[N]>[1]) {
			// El RPC no conoce el tipo de cada operación: el objeto contesta lo que devuelve la que se nombra.
			type Respuesta = RespuestaDeLaCentral<ReturnType<Operaciones[N]>>;
			return viaje(async () => (await pedirStub().operar(nombre, datos)) as Respuesta, plazoMs);
		},
	};
}
