// src/durableObjects/agendaWeb.motor.ts
//
// La agenda de reservas web de un negocio (docs/estudios/reservas-web.md §4.3): decide la mesa,
// guarda la reserva hasta que la Main la tiene y lleva los enlaces de cancelar.
//
// Reglas que no se rompen aquí:
//   · **Nunca escribe en la base del negocio** (ADR 0007). Lee la base del negocio y escribe sólo en su SQLite.
//   · **Comprobar y apuntar van en el mismo bloque síncrono**, sin `await` en medio: lo que hace que
//     dos altas a la vez para la misma mesa no salgan las dos (`agendaWeb.almacen.ts`). Lo que es
//     asíncrono (la base, los hashes) va antes.
//   · **Sin estado en campos de instancia que importe**: lo que hay que recordar va en el SQLite
//     (`estado`), como en el `TenantHub` (SYNC-16). `leer` es una costura para los tests, no estado.
//   · Las respuestas no llevan datos personales de ninguna reserva.

import type { PendientesReservaWebDto, PeticionReservaWebDto } from "@tpv/contracts";

import type { Env } from "../env";
import { nuevoId } from "../lib/ids";
import { hubDe } from "../lib/hub";
import { sha256HexStr } from "../server/utils/crypto";
import { reportarReservaWeb } from "../observability/axiom";
import {
	alternativas,
	horaEnTramos,
	intervalo,
	laMasAjustada,
	libres,
	mesasAdecuadas,
	motivoDelDia,
	tramosDelDia,
	type AjustesWeb,
	type FranjaWeb,
	type MesaWeb,
	type Ocupacion,
} from "../domains/reservas_web/disponibilidad";
import {
	leerParaLaWeb,
	type LecturaWeb,
	type NombreDeLectura,
	type ReservaEnLaBase,
	type ResultadoDe,
} from "../domains/reservas_web/lecturasDeLaWeb";
import { MESA_AUTOMATICA, type AltaReservaWeb } from "../domains/reservas_web/reservasWeb.schemas";
import { enviarCorreoReservaWeb, type Correo, type ResultadoCorreo } from "../domains/reservas_web/correos";
import {
	altasDeLaConexionDesde,
	altasDesde,
	apuntarAltaDeLaConexion,
	cancelacionesHechas,
	esperando,
	fallidasPorAvisar,
	olvidarCorreo,
	apuntarIntentoDeAviso,
	cursorDeLaAlarma,
	guardarCursorDeLaAlarma,
	anularAlta,
	apuntarAlta,
	apuntarCancelacion,
	apuntarIntento,
	apuntarResultados,
	darPorVistas,
	entregarPendientes,
	negocioRecordado,
	ocupacionPendiente,
	pendientesDesde,
	peticion,
	prepararAlmacen,
	prolongarEnlaces,
	apuntarEnlace,
	purgar,
	recordarNegocio,
	reofrecer,
	reservaDelEnlace,
	respuestaDelIntento,
	vivasDelCorreoEnLaAgenda,
	VENTANA_TOPES_MS,
	type FilaPeticion,
	type EnlaceVivo,
	type ResultadoDeLaMain,
} from "./agendaWeb.almacen";

/** Reservas vivas por correo, contando las de la base y las que esperan aquí. */
export const MAX_RESERVAS_POR_CORREO = 10;
/** Altas por negocio en 24 h: el control exacto detrás del limitador por IP. */
export const MAX_ALTAS_DIA_NEGOCIO = 200;
/**
 * RW-ALTAS · Altas por conexión (la IP, o su /64 en IPv6) en este negocio en 24 h, contando las que
 * su autor anula. Sin él, una sola conexión llenaba el tope del negocio cambiando de correo, o
 * gastaba su cupo de correos reservando y cancelando en bucle.
 *
 * Por qué 10: una conexión compartida (el CGNAT de un operador móvil, una oficina, un hotel) junta a
 * muchas personas, pero que más de diez de ellas reserven por la web en el mismo restaurante el
 * mismo día es rarísimo; quien lo hace por todos (una empresa, un grupo grande) puede llamar, que es
 * lo que dice el rechazo. Y con 10, llegar al tope de 200 del negocio pide al menos 20 conexiones
 * distintas, cada una con su Turnstile resuelto; en IPv6, además, de al menos 7 redes /48
 * (`MAX_ALTAS_DIA_RED`).
 */
export const MAX_ALTAS_DIA_CONEXION = 10;
/**
 * RW-ALTAS · Altas por red amplia de IPv6 (su /48, `limitador.ts::redAmpliaIpv6`) en este negocio en
 * 24 h, contadas como las de la conexión. En IPv6 una sola persona suele tener muchos /64: una casa
 * recibe un /56 (256) y un túnel gratuito da un /48 (65 536). Sólo con el tope por /64, llenaba el
 * del negocio con 20 de los suyos.
 *
 * Por qué 30: el /48 es de una casa, una empresa o un túnel, pero un operador móvil puede repartir /64
 * de un mismo /48 entre clientes distintos; 30 altas web el mismo día en el mismo restaurante desde
 * ahí siguen siendo rarísimas, y quien choque puede llamar. Con 30, llenar el tope del negocio pide al
 * menos 7 redes /48 distintas, y gastar su cupo de 600 correos reservando y cancelando (dos por
 * vuelta), 10. En IPv4 no hay red amplia: un /24 juntaría a desconocidos detrás del CGNAT.
 */
export const MAX_ALTAS_DIA_RED = 30;
/** Cada cuánto despierta la alarma mientras haya algo guardado. */
const CADA_ALARMA_MS = 60 * 60_000;
/** Lo entregado a la Main que no se ve en la base (ni contesta) en este tiempo se le vuelve a ofrecer. */
const REOFRECER_TRAS_MS = 60 * 60_000;
/** Una petición que sigue sin recoger tanto tiempo es una anomalía que mirar (§9). */
const ATASCADA_TRAS_MS = 72 * 60 * 60_000;
/**
 * Cuántos correos de «no se pudo registrar» se mandan de una vez, y entre cuántas fallidas se
 * buscan: las que no salen (un buzón en el tope, un correo que el binding rechaza) no pueden tapar a
 * las de detrás. Lo que quede, en la alarma.
 */
const MAX_AVISOS_FALLIDAS = 20;
const MAX_FALLIDAS_MIRADAS = 100;
/** Cuántas peticiones se entregan a la Main de una vez. */
const MAX_ENTREGA = 50;
/**
 * Cuánto antes de empezar a leer la base se mira si otra petición dio un alta por vista
 * (`agendaWeb.almacen.ts::Lectura`). Cubre que la lectura de la base llegue con algo de retraso.
 */
const MARGEN_LECTURA_MS = 60_000;
/**
 * Cuántas altas que esperan mira la alarma en la base por consulta, y cuántas consultas hace cada vez.
 * Lo que no le dé tiempo lo sigue en la siguiente, desde donde lo dejó (`cursor_alarma`).
 */
const MAX_RECONCILIAR = 500;
const LOTES_POR_ALARMA = 5;

type ErrorAgenda =
	| "reserva_web_cerrada"
	| "dia_no_reservable"
	| "hora_fuera_de_franja"
	| "mesa_no_disponible"
	| "sin_mesa_libre"
	| "limite_reservas_correo"
	| "tope_reservas_negocio"
	| "tope_reservas_conexion"
	| "reserva_no_cancelable"
	| "enlace_no_valido";

/** Los rechazos de negocio cruzan el RPC como resultado, no como excepción (igual que `aplicar`). */
export type RechazoAgenda = { ok: false; error: ErrorAgenda; status: 400 | 404 | 409 | 429 };

const STATUS: Record<ErrorAgenda, RechazoAgenda["status"]> = {
	reserva_web_cerrada: 409,
	dia_no_reservable: 400,
	hora_fuera_de_franja: 400,
	mesa_no_disponible: 409,
	sin_mesa_libre: 409,
	limite_reservas_correo: 409,
	tope_reservas_negocio: 429,
	tope_reservas_conexion: 429,
	reserva_no_cancelable: 409,
	enlace_no_valido: 404,
};

function rechazo(error: ErrorAgenda): RechazoAgenda {
	return { ok: false, error, status: STATUS[error] };
}

export type ResultadoDisponibles = { ok: true; mesas: string[]; alternativas: string[] } | RechazoAgenda;

export type ResultadoReservar =
	| {
			ok: true;
			id_reserva: string;
			codigo: string;
			dia: string;
			hora: string;
			personas: number;
			id_mesa: string;
			/** El nombre de la mesa en la Main. */
			mesa: string;
			/** El token del enlace de cancelar: sólo para el correo, nunca para la respuesta. `null` en una
			 * repetición: de él sólo queda el hash, y el correo es del alta de verdad. */
			token: string | null;
			/** La repetición de un intento que ya había dado esta reserva: no se ha apuntado otra. */
			repetida: boolean;
	  }
	| RechazoAgenda;

export type EstadoPublico = "confirmada" | "cancelada" | "pasada";

export type ResultadoConsulta =
	| {
			ok: true;
			dia: string;
			hora: string;
			personas: number;
			id_mesa: string | null;
			/** El nombre de la mesa en la Main, o vacío si no se sabe. */
			mesa: string;
			estado: EstadoPublico;
			cancelable: boolean;
	  }
	| RechazoAgenda;

/**
 * Lo que necesita el correo de «has cancelado tu reserva» (`domains/reservas_web/correos.ts`). Sólo
 * cruza el RPC hasta la ruta, que no lo devuelve: la respuesta pública sigue sin datos personales.
 */
export type AvisoDeCancelacion = {
	id_reserva: string;
	email: string;
	dia: string;
	hora: string;
	personas: number;
	mesa: string | null;
	/**
	 * Se canceló con el enlace del correo de un cambio del restaurante (`enlaceParaUnCambio`), no con el
	 * de la confirmación. Ese correo lo pide la Main, no quien reserva: el «has cancelado» no tiene que
	 * esperar a la confirmación (RW-ALTAS).
	 */
	con_enlace_de_un_cambio: boolean;
};

/** `aviso`, si se acaba de cancelar y se sabe a quién decírselo; `null` si ya lo estaba. */
export type ResultadoCancelar = { ok: true; aviso: AvisoDeCancelacion | null } | RechazoAgenda;

/** Una referencia corta para hablar con el restaurante: el final aleatorio del `ID_Reserva`. */
export function codigoDeReserva(idReserva: string): string {
	return idReserva.replace(/-/g, "").slice(-6).toUpperCase();
}

/** El token del enlace de cancelar: 128 bits en base64url. Sólo se guarda su hash. */
function nuevoToken(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(16));
	return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Hasta cuándo vale el enlace de cancelar de una reserva: un día después de su hora. La hora es de
 * pared del negocio y aquí se lee como UTC: un día y medio de margen cubre cualquier desfase.
 */
export function caducidadDelEnlace(dia: string, hora: string): number {
	return Date.parse(`${dia}T${hora}:00Z`) + 36 * 3_600_000;
}

/** La forma de un token de enlace: lo demás no se busca. */
const TOKEN_RE = /^[A-Za-z0-9_-]{22}$/;

/** Lo que se lee de la base para decidir sobre un día. */
type DiaLeido = {
	/** Cuándo se empezó a leer: de ahí sale `Lectura.vistasDesdeMs`. */
	leidaMs: number;
	ahora: string;
	ajustes: AjustesWeb;
	cierres: Set<string>;
	mesas: MesaWeb[];
	franjas: FranjaWeb[];
	ocupaciones: Ocupacion[];
	idsEnLaBase: Set<string>;
};

/**
 * Cómo se lee la base del negocio: una lectura entera, por su nombre, en un viaje a su TenantHub
 * (`domains/reservas_web/lecturasDeLaWeb.ts`). Lo que espera aquí se le pasa en sus datos.
 */
export type Lector = <N extends NombreDeLectura>(tenantId: string, lectura: LecturaWeb<N>) => Promise<ResultadoDe<N>>;

export type EnviarCorreo = (correo: Correo) => Promise<ResultadoCorreo>;

export class MotorAgendaWeb {
	/** Cómo se lee la base. Los tests lo cambian por un cliente sobre SQLite. */
	leer: Lector;
	/** Cómo se manda un correo al cliente. Los tests lo cambian por uno que apunta. */
	enviarCorreo: EnviarCorreo;

	/**
	 * Si las tablas de la agenda están creadas y al día. Se preparan al construir el objeto, y otra
	 * vez, cuando hagan falta, después de vaciarlo (`borrarTodo`).
	 */
	private almacenListo = false;

	constructor(
		private readonly ctx: DurableObjectState,
		private readonly env: Env,
	) {
		void this.sql;
		this.leer = (tenantId, lectura) => leerParaLaWeb(env, tenantId, lectura);
		this.enviarCorreo = (correo) => enviarCorreoReservaWeb(env, correo);
	}

	/**
	 * El empujón a la Main: que venga a recoger (`TenantHub.avisarReservasWeb`). Sin esperarlo y sin
	 * fallar si no contesta: lo que hay que entregar ya está guardado, y la Main lo recoge igual al
	 * conectar o cuando la alarma se lo vuelve a ofrecer.
	 */
	private avisarALaMain(tenantId: string): void {
		const hub = hubDe(this.env, tenantId);
		this.ctx.waitUntil(
			Promise.resolve()
				.then(() => hub.avisarReservasWeb())
				.catch((e: any) => console.warn("[agenda-web] no se ha podido avisar a la Main:", String(e?.message || e))),
		);
	}

	/** Un evento a Axiom, retenido más allá de la respuesta (`observability/axiom.ts`). */
	private anotar(campos: Parameters<typeof reportarReservaWeb>[1]): void {
		this.ctx.waitUntil(reportarReservaWeb(this.env, campos));
	}

	private get sql(): SqlStorage {
		if (!this.almacenListo) {
			prepararAlmacen(this.ctx.storage.sql);
			this.almacenListo = true;
		}
		return this.ctx.storage.sql;
	}

	/**
	 * Retirar un negocio de pruebas: lo que esperaba a la Main (con los datos de quien reservó), los
	 * enlaces, los intentos y la alarma. El objeto queda sin nada guardado; si después le llega algo,
	 * vuelve a crear sus tablas vacías.
	 */
	async borrarTodo(): Promise<void> {
		await this.ctx.storage.deleteAlarm();
		await this.ctx.storage.deleteAll();
		this.almacenListo = false;
	}

	private async leerDia(tenantId: string, dia: string): Promise<DiaLeido> {
		const leidaMs = Date.now();
		return { leidaMs, ...(await this.leer(tenantId, { que: "diaDeLaAgenda", dia })) };
	}

	/** Si el día o la hora no valen, el rechazo. */
	private motivo(d: DiaLeido, dia: string, hora: string): RechazoAgenda | null {
		const delDia = motivoDelDia(dia, d.ahora.slice(0, 10), d.ajustes, d.cierres);
		if (delDia === "reserva_web_cerrada") return rechazo("reserva_web_cerrada");
		if (delDia) return rechazo("dia_no_reservable");
		if (!horaEnTramos(tramosDelDia(d.mesas, d.franjas, dia, d.ajustes), hora)) return rechazo("hora_fuera_de_franja");
		return null;
	}

	/** Las mesas libres a esa hora, contando la base y lo que espera aquí. Síncrono. */
	private mesasLibres(d: DiaLeido, dia: string, hora: string, personas: number): MesaWeb[] {
		const lectura = { ids: d.idsEnLaBase, vistasDesdeMs: d.leidaMs - MARGEN_LECTURA_MS };
		const ocupado = [...d.ocupaciones, ...ocupacionPendiente(this.sql, dia, d.ajustes.duracion, lectura)];
		const adecuadas = mesasAdecuadas(d.mesas, d.franjas, dia, hora, personas, d.ajustes);
		return libres(adecuadas, ocupado, dia, hora, d.ajustes.duracion);
	}

	async disponibles(p: { tenantId: string; dia: string; hora: string; personas: number }): Promise<ResultadoDisponibles> {
		recordarNegocio(this.sql, p.tenantId);
		const d = await this.leerDia(p.tenantId, p.dia);

		const motivo = this.motivo(d, p.dia, p.hora);
		if (motivo) return motivo;

		darPorVistas(this.sql, d.idsEnLaBase, Date.now());
		const mesas = this.mesasLibres(d, p.dia, p.hora, p.personas).map((m) => m.id_mesa);
		if (mesas.length) return { ok: true, mesas, alternativas: [] };

		const tramos = tramosDelDia(d.mesas, d.franjas, p.dia, d.ajustes);
		const otras = alternativas(
			p.hora,
			(h) => horaEnTramos(tramos, h) && this.mesasLibres(d, p.dia, h, p.personas).length > 0,
		);
		return { ok: true, mesas: [], alternativas: otras };
	}

	/**
	 * Un alta del widget. `intento` es su `Idempotency-Key`: la misma mientras repite el alta porque no
	 * le llegó la respuesta. Si ese intento ya dio una reserva, se contesta la misma y no se apunta otra
	 * (la mesa ya está ocupada por ella, y elegir otra la duplicaría).
	 *
	 * `conexion` y `red` son las huellas de la conexión desde la que llega y, en IPv6, de su /48
	 * (`puerta.ts::huellasDeLaConexion`), para sus topes (RW-ALTAS); `null` si no se sabe, y entonces
	 * no cuenta para ese tope.
	 */
	async reservar(p: {
		tenantId: string;
		alta: AltaReservaWeb;
		intento?: string | null;
		conexion?: string | null;
		red?: string | null;
	}): Promise<ResultadoReservar> {
		const { alta } = p;
		const conexion = { conexion: p.conexion || null, red: p.red || null };
		// Sin mesa elegida (`MESA_AUTOMATICA`), la decide el bloque síncrono de abajo: la de menos plazas
		// en la que quepan. Elegirla antes, con lo leído, dejaría que dos altas a la vez se llevaran la misma.
		const automatica = alta.id_mesa === MESA_AUTOMATICA;
		recordarNegocio(this.sql, p.tenantId);
		const repetida = this.repeticion(p.intento);
		if (repetida) return repetida;
		// RW-ALTAS · Una conexión que ya ha llegado a su tope no le cuesta a nadie una lectura de la base.
		// Se vuelve a mirar en el bloque que decide: dos altas a la vez pueden pasar las dos por aquí.
		if (this.conexionEnSuTope(conexion, Date.now())) return rechazo("tope_reservas_conexion");

		// Lo asíncrono, antes del bloque que decide.
		const token = nuevoToken();
		const [tokenHash, emailHash] = await Promise.all([sha256HexStr(token), sha256HexStr(alta.email)]);
		const leidaMs = Date.now();
		// Lo del día, las reservas vivas del correo y el nombre que lleva la respuesta: de la mesa pedida
		// o, sin ella, de todas las que puede tocar. Un viaje.
		const leido = await this.leer(p.tenantId, {
			que: "alta",
			dia: alta.dia_ymd,
			email: alta.email,
			idMesa: alta.id_mesa,
			automatica,
		});
		const d: DiaLeido = { leidaMs, ...leido.dia };

		// ── Desde aquí, síncrono hasta apuntarla ──
		// Otra vez: el mismo intento pudo apuntarse mientras éste leía la base.
		const repetidaAlLeer = this.repeticion(p.intento);
		if (repetidaAlLeer) return repetidaAlLeer;

		const motivo = this.motivo(d, alta.dia_ymd, alta.hora);
		if (motivo) return motivo;

		const ahoraMs = Date.now();
		darPorVistas(this.sql, [...d.idsEnLaBase, ...leido.delCorreo], ahoraMs);

		const libres = this.mesasLibres(d, alta.dia_ymd, alta.hora, alta.personas);
		const elegida = automatica ? laMasAjustada(libres) : (libres.find((m) => m.id_mesa === alta.id_mesa) ?? null);
		const nombreMesa = elegida ? (leido.nombres.get(elegida.id_mesa) ?? null) : null;
		if (!elegida || nombreMesa === null) return automatica ? rechazo("sin_mesa_libre") : rechazo("mesa_no_disponible");
		const idMesa = elegida.id_mesa;

		const hoy = d.ahora.slice(0, 10);
		const lecturaDelCorreo = { ids: leido.delCorreo, vistasDesdeMs: leidaMs - MARGEN_LECTURA_MS };
		if (leido.delCorreo.size + vivasDelCorreoEnLaAgenda(this.sql, emailHash, hoy, lecturaDelCorreo) >= MAX_RESERVAS_POR_CORREO) {
			return rechazo("limite_reservas_correo");
		}
		if (this.conexionEnSuTope(conexion, ahoraMs)) return rechazo("tope_reservas_conexion");
		if (altasDesde(this.sql, ahoraMs - VENTANA_TOPES_MS) >= MAX_ALTAS_DIA_NEGOCIO) return rechazo("tope_reservas_negocio");

		const idReserva = nuevoId();
		const caducaMs = caducidadDelEnlace(alta.dia_ymd, alta.hora);
		const respuesta = {
			id_reserva: idReserva,
			codigo: codigoDeReserva(idReserva),
			dia: alta.dia_ymd,
			hora: alta.hora,
			personas: alta.personas,
			id_mesa: idMesa,
			mesa: nombreMesa,
		};
		this.ctx.storage.transactionSync(() => {
			apuntarAlta(
				this.sql,
				{
					id_peticion: nuevoId(),
					tipo: "alta",
					id_reserva: idReserva,
					id_mesa: idMesa,
					dia_ymd: alta.dia_ymd,
					hora: alta.hora,
					comensales: alta.personas,
					email_hash: emailHash,
					datos_json: JSON.stringify({
						nombre: alta.nombre,
						email: alta.email,
						telefono: alta.telefono,
						nota: alta.nota,
					}),
					// La hora la pone quien escribe (0004): el alta ocurre aquí, y éste es el
					// `Created_At` que escribirá la Main.
					creada_local: d.ahora,
					creada_ms: ahoraMs,
					estado: "pendiente",
				},
				{ tokenHash, caducaMs },
			);
			if (conexion.conexion) apuntarAltaDeLaConexion(this.sql, conexion.conexion, ahoraMs);
			if (conexion.red) apuntarAltaDeLaConexion(this.sql, conexion.red, ahoraMs);
			if (p.intento) apuntarIntento(this.sql, p.intento, respuesta, ahoraMs);
		});
		// ── Fin del bloque ──

		this.avisarALaMain(p.tenantId);
		await this.asegurarAlarma();
		return { ok: true, ...respuesta, token, repetida: false };
	}

	/**
	 * RW-ALTAS · ¿Esa conexión, o su red amplia de IPv6, ha apuntado ya su máximo de altas en las
	 * últimas 24 h? Síncrono. Las dos huellas van en la misma tabla: el HMAC de cada una lleva su uso,
	 * así que no se cuentan la una por la otra.
	 */
	private conexionEnSuTope(huellas: { conexion: string | null; red: string | null }, ahoraMs: number): boolean {
		const desdeMs = ahoraMs - VENTANA_TOPES_MS;
		if (huellas.conexion !== null && altasDeLaConexionDesde(this.sql, huellas.conexion, desdeMs) >= MAX_ALTAS_DIA_CONEXION) {
			return true;
		}
		return huellas.red !== null && altasDeLaConexionDesde(this.sql, huellas.red, desdeMs) >= MAX_ALTAS_DIA_RED;
	}

	/** Lo que contestó ya ese intento, si acabó en reserva. */
	private repeticion(intento: string | null | undefined): ResultadoReservar | null {
		const r = intento ? respuestaDelIntento(this.sql, intento, Date.now()) : null;
		return r ? { ok: true, ...r, token: null, repetida: true } : null;
	}

	/** El resumen para la página de cancelar. */
	async consultarEnlace(p: { tenantId: string; token: string }): Promise<ResultadoConsulta> {
		recordarNegocio(this.sql, p.tenantId);
		const idReserva = (await this.enlaceDelToken(p.token))?.id_reserva;
		if (!idReserva) return rechazo("enlace_no_valido");

		const { leidaMs, ahora, enLaBase, numero } = await this.leerReserva(p.tenantId, idReserva);
		const alta = peticion(this.sql, "alta", idReserva);
		const datos = enLaBase ?? (alta ? { dia: alta.dia_ymd, hora: alta.hora, personas: alta.comensales, id_mesa: alta.id_mesa } : null);
		if (!datos) return rechazo("enlace_no_valido");

		const estado = this.estadoPublico(idReserva, enLaBase, ahora, datos, leidaMs);
		return {
			ok: true,
			dia: datos.dia,
			hora: datos.hora,
			personas: datos.personas,
			id_mesa: datos.id_mesa,
			mesa: numero ?? "",
			estado,
			cancelable: estado === "confirmada",
		};
	}

	/**
	 * Cancelar desde el enlace, hasta la hora de la reserva. Si la Main todavía no la tiene, se anula
	 * aquí; si ya la tiene (o la está registrando), queda una cancelación para entregarle.
	 * Idempotente: cancelar dos veces es un `ok`.
	 */
	async cancelar(p: { tenantId: string; token: string }): Promise<ResultadoCancelar> {
		recordarNegocio(this.sql, p.tenantId);
		const enlace = await this.enlaceDelToken(p.token);
		if (!enlace) return rechazo("enlace_no_valido");
		const idReserva = enlace.id_reserva;

		const { leidaMs, ahora, enLaBase, numero } = await this.leerReserva(p.tenantId, idReserva);
		// ── Síncrono hasta el final ──
		const ahoraMs = Date.now();
		if (enLaBase) darPorVistas(this.sql, [idReserva], ahoraMs);
		const alta = peticion(this.sql, "alta", idReserva);
		const datos = enLaBase ?? (alta ? { dia: alta.dia_ymd, hora: alta.hora, personas: alta.comensales, id_mesa: alta.id_mesa } : null);
		if (!datos) return rechazo("enlace_no_valido");

		const estado = this.estadoPublico(idReserva, enLaBase, ahora, datos, leidaMs);
		// Ya cancelada: ya se le dijo, no se le vuelve a escribir.
		if (estado === "cancelada") return { ok: true, aviso: null };
		if (estado === "pasada") return rechazo("reserva_no_cancelable");

		// A quién decírselo: al cliente de la reserva en la base o, si aún no está, al correo del alta.
		// Antes de anularla, que se lleva los datos del alta.
		const email = enLaBase?.email ?? correoDelAlta(alta);
		const aviso: AvisoDeCancelacion | null = email
			? {
					id_reserva: idReserva,
					email,
					dia: datos.dia,
					hora: datos.hora,
					personas: datos.personas,
					mesa: numero,
					con_enlace_de_un_cambio: enlace.por_un_cambio,
				}
			: null;

		if (!enLaBase && anularAlta(this.sql, idReserva, ahoraMs)) return { ok: true, aviso };
		apuntarCancelacion(this.sql, {
			id_peticion: nuevoId(),
			id_reserva: idReserva,
			id_mesa: datos.id_mesa,
			dia_ymd: datos.dia,
			hora: datos.hora,
			comensales: datos.personas,
			creada_local: ahora,
			creada_ms: ahoraMs,
		});
		this.avisarALaMain(p.tenantId);
		await this.asegurarAlarma();
		return { ok: true, aviso };
	}

	/**
	 * Lo que la Main tiene que registrar, por orden de llegada; pasa a `entregada`. Antes se da por
	 * visto lo que ya está en la base, para no volver a entregarlo. Si la base no contesta se entrega
	 * igual: registrarlo dos veces no lo duplica.
	 */
	async pendientes(p: { tenantId: string }): Promise<{ ok: true } & PendientesReservaWebDto> {
		recordarNegocio(this.sql, p.tenantId);
		try {
			await this.reconciliarConLaBase();
		} catch (e: any) {
			console.warn("[agenda-web] no se ha podido mirar la base antes de entregar:", String(e?.message || e));
		}
		const { peticiones, hayMas } = entregarPendientes(this.sql, MAX_ENTREGA, Date.now());
		if (peticiones.length) {
			this.anotar({ event: "reserva_web_entregada", tenant_id: p.tenantId, cuantas: peticiones.length });
			// La alarma es la que las vuelve a ofrecer si no llegan a la base.
			await this.asegurarAlarma();
		}
		return { ok: true, peticiones: peticiones.map(paraLaMain), hay_mas: hayMas };
	}

	/**
	 * El restaurante ha cambiado la reserva y se lo va a contar al cliente («tu reserva ha cambiado»).
	 * Lo pide la ruta de los avisos:
	 *   · si el cliente ya la canceló desde su enlace (aunque la Main aún no lo tenga), lo dice: contarle
	 *     cómo queda después de su «has cancelado» le haría creer que sigue en pie;
	 *   · si no, le da un enlace de cancelar nuevo para ese correo, que vale hasta un día después de la
	 *     hora nueva (el de la confirmación pudo caducar o purgarse si la reserva se movió lejos), y
	 *     alarga hasta ahí los que ya tenía.
	 */
	async enlaceParaUnCambio(p: {
		tenantId: string;
		id_reserva: string;
		dia: string;
		hora: string;
	}): Promise<{ ok: true; canceladaPorElCliente: boolean; token: string | null }> {
		recordarNegocio(this.sql, p.tenantId);
		const token = nuevoToken();
		const tokenHash = await sha256HexStr(token);
		// ── Síncrono desde aquí ──
		const canceladaPorElCliente =
			peticion(this.sql, "cancelacion", p.id_reserva) !== null ||
			peticion(this.sql, "alta", p.id_reserva)?.estado === "anulada";
		if (canceladaPorElCliente) return { ok: true, canceladaPorElCliente, token: null };
		const caducaMs = caducidadDelEnlace(p.dia, p.hora);
		this.ctx.storage.transactionSync(() => {
			prolongarEnlaces(this.sql, p.id_reserva, caducaMs);
			apuntarEnlace(this.sql, p.id_reserva, tokenHash, caducaMs);
		});
		await this.asegurarAlarma();
		return { ok: true, canceladaPorElCliente: false, token };
	}

	/** Lo que la Main contesta de lo entregado (`agendaWeb.almacen.ts::apuntarResultados`). */
	async recogidas(p: { tenantId: string; resultados: ResultadoDeLaMain[] }): Promise<{ ok: true; apuntadas: number }> {
		recordarNegocio(this.sql, p.tenantId);
		const { apuntadas, fallidas } = apuntarResultados(this.sql, p.resultados, Date.now());
		for (const f of fallidas) {
			this.anotar({ event: "reserva_web_fallida", tenant_id: p.tenantId, id_reserva: f.id_reserva, motivo: f.codigo ?? undefined });
		}
		// El correo al cliente. Una fallida es rara (un dato imposible) y la Main recoge en segundo
		// plano: puede esperarlo. Lo que no salga, o no dé tiempo, lo repite la alarma.
		if (fallidas.length) {
			try {
				await this.avisarFallidas(p.tenantId);
			} catch (e: any) {
				console.warn("[agenda-web] no se ha podido avisar de las fallidas:", String(e?.message || e));
			}
		}
		return { ok: true, apuntadas };
	}

	/**
	 * «No hemos podido registrar tu reserva», a cada cliente cuya alta no pudo guardar la Main: tiene
	 * una reserva confirmada que el restaurante no tiene (§4.8). Hasta que sale; después la agenda
	 * olvida su correo. Pasada la hora de la reserva ya no se manda: no le sirve de nada.
	 */
	async avisarFallidas(tenantId: string): Promise<number> {
		const pendientes = fallidasPorAvisar(this.sql, MAX_FALLIDAS_MIRADAS);
		if (!pendientes.length) return 0;
		const idsMesas = [...new Set(pendientes.map((f) => f.id_mesa).filter((m): m is string => !!m))];
		const { ahora, negocio, mesas } = await this.leer(tenantId, { que: "fallidas", idsMesas });
		let enviados = 0;
		for (const f of pendientes) {
			if (enviados >= MAX_AVISOS_FALLIDAS) break;
			const email = correoDelAlta(f);
			if (!email || intervalo(f.dia_ymd, f.hora, 0).inicio <= ahora) {
				olvidarCorreo(this.sql, f.id_peticion);
				continue;
			}
			const r = await this.enviarCorreo({
				tenantId,
				id: `rw:no_registrada:${f.id_reserva}`,
				tipo: "no_registrada",
				para: email,
				negocio,
				reserva: {
					dia: f.dia_ymd,
					hora: f.hora,
					personas: f.comensales,
					mesa: f.id_mesa ? (mesas.get(f.id_mesa) ?? null) : null,
					codigo: codigoDeReserva(f.id_reserva),
				},
				dispositivo: "agenda",
			});
			if (r === "enviado" || r === "ya_enviado") {
				olvidarCorreo(this.sql, f.id_peticion);
				enviados++;
			} else {
				// No ha salido: a la cola, detrás de las que aún no se han intentado.
				apuntarIntentoDeAviso(this.sql, f.id_peticion, Date.now());
			}
		}
		return enviados;
	}

	/** Lo que ve quien abre el enlace. Síncrono. */
	private estadoPublico(
		idReserva: string,
		enLaBase: ReservaEnLaBase | null,
		ahora: string,
		datos: { dia: string; hora: string },
		leidaMs: number,
	): EstadoPublico {
		const alta = peticion(this.sql, "alta", idReserva);
		// Que no esté en esta lectura de la base sólo quiere decir que se borró si se dio por vista antes
		// de empezar a leerla: si fue mientras, la lectura es simplemente más vieja (`Lectura`).
		const borrada =
			!enLaBase && alta?.estado === "vista" && Number(alta.cerrada_ms ?? 0) < leidaMs - MARGEN_LECTURA_MS;
		const cancelada =
			enLaBase?.estado === "CANCELADA" ||
			alta?.estado === "anulada" ||
			// La Main no pudo registrarla: al cliente se le avisa por correo y deja de valer.
			alta?.estado === "fallida" ||
			// Estuvo en la base y ya no está: el restaurante la borró, que es cancelarla.
			borrada ||
			peticion(this.sql, "cancelacion", idReserva) !== null;
		if (cancelada) return "cancelada";
		// Sentados (ACTIVA), terminada o no se presentaron: ya no es una reserva por venir.
		if (enLaBase && enLaBase.estado !== "PROXIMA") return "pasada";
		// Hasta la hora de la reserva, en la hora del negocio.
		if (intervalo(datos.dia, datos.hora, 0).inicio <= ahora) return "pasada";
		return "confirmada";
	}

	private async enlaceDelToken(token: string): Promise<EnlaceVivo | null> {
		if (!TOKEN_RE.test(token)) return null;
		const hash = await sha256HexStr(token);
		return reservaDelEnlace(this.sql, hash, Date.now());
	}

	private async leerReserva(
		tenantId: string,
		idReserva: string,
	): Promise<{ leidaMs: number; ahora: string; enLaBase: ReservaEnLaBase | null; numero: string | null }> {
		const leidaMs = Date.now();
		// Si la reserva aún no está en la base, el nombre de su mesa sale de la del alta que espera aquí.
		const idMesaDelAlta = peticion(this.sql, "alta", idReserva)?.id_mesa ?? null;
		return { leidaMs, ...(await this.leer(tenantId, { que: "reserva", idReserva, idMesaDelAlta })) };
	}

	/** Una sola alarma, reprogramada mientras haya algo guardado. */
	private async asegurarAlarma(): Promise<void> {
		if ((await this.ctx.storage.getAlarm()) === null) {
			await this.ctx.storage.setAlarm(Date.now() + CADA_ALARMA_MS);
		}
	}

	async alarm(): Promise<void> {
		let baseMirada = true;
		try {
			await this.reconciliarConLaBase();
		} catch (e: any) {
			// Sin la base se purga igual; lo que espera se vuelve a mirar en la próxima.
			baseMirada = false;
			console.warn("[agenda-web] la alarma no ha podido mirar la base:", String(e?.message || e));
		}
		const tenantId = negocioRecordado(this.sql);
		const ahoraMs = Date.now();
		// Sólo con lo visto en la base al día: sin él, se volvería a ofrecer lo que ya llegó.
		if (baseMirada && tenantId) {
			const reofrecidas = reofrecer(this.sql, ahoraMs - REOFRECER_TRAS_MS);
			if (reofrecidas > 0) {
				this.anotar({ event: "reserva_web_reofrecida", tenant_id: tenantId, cuantas: reofrecidas });
			}
			const atascadas = pendientesDesde(this.sql, ahoraMs - ATASCADA_TRAS_MS);
			if (atascadas > 0) this.anotar({ event: "reserva_web_atascada", tenant_id: tenantId, cuantas: atascadas });
		}
		// Mientras quede algo sin recoger, se vuelve a avisar: el aviso del alta pudo perderse (la Main
		// conectada no vuelve a pedir si nadie la avisa), y no cuesta nada si no hay Main.
		if (tenantId && pendientesDesde(this.sql, ahoraMs + 1) > 0) this.avisarALaMain(tenantId);
		// Los correos de «no se pudo registrar» que no salieron al contestar la Main.
		if (tenantId) {
			try {
				await this.avisarFallidas(tenantId);
			} catch (e: any) {
				console.warn("[agenda-web] la alarma no ha podido avisar de las fallidas:", String(e?.message || e));
			}
		}
		const quedaAlgo = purgar(this.sql, ahoraMs);
		if (quedaAlgo) await this.ctx.storage.setAlarm(Date.now() + CADA_ALARMA_MS);
	}

	/**
	 * Las altas que esperan y ya están en la base pasan a `vista` y olvidan sus datos personales, aunque
	 * nadie vuelva a preguntar por ese día. Sin esto, una reserva cuyo día nadie consulta guardaría
	 * nombre, correo y teléfono hasta que se purgase.
	 */
	private async reconciliarConLaBase(): Promise<void> {
		const tenantId = negocioRecordado(this.sql);
		if (!tenantId) return;
		const vistas = await this.reconciliarTipo(tenantId, "alta", darPorVistas);
		if (vistas > 0) this.anotar({ event: "reserva_web_vista", tenant_id: tenantId, cuantas: vistas });
		await this.reconciliarTipo(tenantId, "cancelacion", cancelacionesHechas);
	}

	/**
	 * Por lotes y avanzando aunque un lote no encuentre nada: si las más viejas no llegan nunca a
	 * la base, no pueden tapar a las de detrás. Lo que no da tiempo sigue en la siguiente vez.
	 *
	 * Lo que se pregunta a la base para dar por hecho lo que espera: un alta, si la reserva está; una
	 * cancelación, si está y ya no está por llegar (la lectura `enLaBase`). La Main sólo cancela una que
	 * aún no ha llegado (`cancelar_desde_la_web`): con el cliente ya sentado la deja, y esperar a verla
	 * cancelada sería volver a ofrecérsela cada hora.
	 */
	private async reconciliarTipo(
		tenantId: string,
		tipo: "alta" | "cancelacion",
		cerrar: (sql: SqlStorage, ids: string[], ahoraMs: number) => number,
	): Promise<number> {
		let cerradas = 0;
		let cursor = cursorDeLaAlarma(this.sql, tipo);
		for (let lote = 0; lote < LOTES_POR_ALARMA; lote++) {
			const grupo = esperando(this.sql, tipo, MAX_RECONCILIAR, cursor);
			if (!grupo.length) {
				cursor = null;
				break;
			}
			const ids = grupo.map((a) => a.id_reserva);
			const enLaBase = await this.leer(tenantId, { que: "enLaBase", tipo, ids });
			cerradas += cerrar(this.sql, enLaBase, Date.now());
			// Un lote incompleto es el último: la siguiente vez se empieza otra vez por lo más viejo.
			cursor = grupo.length < MAX_RECONCILIAR ? null : grupo[grupo.length - 1];
			if (!cursor) break;
		}
		guardarCursorDeLaAlarma(this.sql, tipo, cursor);
		return cerradas;
	}

	/** Sólo para diagnóstico y tests: de qué negocio es esta agenda. */
	negocio(): string | null {
		return negocioRecordado(this.sql);
	}
}

/** El correo de un alta, mientras la agenda guarda sus datos. */
function correoDelAlta(alta: FilaPeticion | null): string | null {
	if (!alta?.datos_json) return null;
	try {
		const email = JSON.parse(alta.datos_json).email;
		return typeof email === "string" && email ? email : null;
	} catch {
		return null;
	}
}

/** Una petición tal como se le entrega a la Main. Sin el hash del correo ni lo interno. */
function paraLaMain(f: FilaPeticion): PeticionReservaWebDto {
	let datos: PeticionReservaWebDto["datos"] = null;
	if (f.tipo === "alta" && f.datos_json) {
		const d = JSON.parse(f.datos_json);
		datos = { nombre: d.nombre, email: d.email, telefono: d.telefono, nota: d.nota ?? null };
	}
	return {
		id_peticion: f.id_peticion,
		tipo: f.tipo,
		id_reserva: f.id_reserva,
		id_mesa: f.id_mesa,
		dia_ymd: f.dia_ymd,
		hora: f.hora,
		personas: f.comensales,
		creada_local: f.creada_local,
		datos,
	};
}
