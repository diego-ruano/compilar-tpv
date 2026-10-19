// src/durableObjects/agendaWeb.motor.ts
//
// La agenda de reservas web de un negocio (docs/estudios/reservas-web.md §4.3): decide la mesa,
// guarda la reserva hasta que la Main la tiene y lleva los enlaces de cancelar.
//
// Reglas que no se rompen aquí:
//   · **Nunca escribe en Turso** (ADR 0007). Lee la base del negocio y escribe sólo en su SQLite.
//   · **Comprobar y apuntar van en el mismo bloque síncrono**, sin `await` en medio: lo que hace que
//     dos altas a la vez para la misma mesa no salgan las dos (`agendaWeb.almacen.ts`). Lo que es
//     asíncrono (Turso, los hashes) va antes.
//   · **Sin estado en campos de instancia que importe**: lo que hay que recordar va en el SQLite
//     (`estado`), como en el `TenantHub` (SYNC-16). `leer` es una costura para los tests, no estado.
//   · Las respuestas no llevan datos personales de ninguna reserva.

import type { Client } from "@libsql/client/web";
import type { PendientesReservaWebDto, PeticionReservaWebDto } from "@tpv/contracts";

import type { Env } from "../env";
import { nuevoId } from "../lib/ids";
import { lecturaConHora } from "../lib/tenantClient";
import { sha256HexStr } from "../server/utils/crypto";
import { reportarReservaWeb } from "../observability/axiom";
import {
	alternativas,
	horaEnTramos,
	intervalo,
	libres,
	mesasAdecuadas,
	motivoDelDia,
	tramosDelDia,
	type AjustesWeb,
	type FranjaWeb,
	type MesaWeb,
	type Ocupacion,
} from "../domains/reservas_web/disponibilidad";
import { horaDelNegocio } from "../domains/reservas_web/horaDelNegocio";
import {
	ajustesWeb,
	cierresEntre,
	mesasYFranjas,
	numeroDeMesa,
	ocupacionAlrededorDe,
	reservasVivasDelCorreo,
} from "../domains/reservas_web/lecturas";
import type { AltaReservaWeb } from "../domains/reservas_web/reservasWeb.schemas";
import {
	altasDesde,
	cancelacionesHechas,
	esperando,
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
	purgar,
	recordarNegocio,
	reofrecer,
	reservaDelEnlace,
	respuestaDelIntento,
	vivasDelCorreoEnLaAgenda,
	type FilaPeticion,
	type ResultadoDeLaMain,
} from "./agendaWeb.almacen";

/** Reservas vivas por correo, contando las de Turso y las que esperan aquí. */
export const MAX_RESERVAS_POR_CORREO = 10;
/** Altas por negocio en 24 h: el control exacto detrás del limitador por IP. */
export const MAX_ALTAS_DIA_NEGOCIO = 200;
/** Cada cuánto despierta la alarma mientras haya algo guardado. */
const CADA_ALARMA_MS = 60 * 60_000;
/** Lo entregado a la Main que no se ve en Turso (ni contesta) en este tiempo se le vuelve a ofrecer. */
const REOFRECER_TRAS_MS = 60 * 60_000;
/** Una petición que sigue sin recoger tanto tiempo es una anomalía que mirar (§9). */
const ATASCADA_TRAS_MS = 72 * 60 * 60_000;
// Lo que se pregunta a Turso para dar por hecho lo que espera: un alta, si la reserva está; una
// cancelación, si está y ya no se puede usar (cancelada, terminada o no presentada).
const SQL_ESTAN_EN_TURSO = `SELECT ID_Reserva AS id FROM Reservas WHERE ID_Reserva IN (SELECT value FROM json_each(?1));`;
const SQL_CANCELADAS_EN_TURSO = `SELECT ID_Reserva AS id FROM Reservas
	WHERE ID_Reserva IN (SELECT value FROM json_each(?1)) AND Estado NOT IN ('PROXIMA', 'ACTIVA');`;
/** Cuántas peticiones se entregan a la Main de una vez. */
const MAX_ENTREGA = 50;
/**
 * Cuánto antes de empezar a leer Turso se mira si otra petición dio un alta por vista
 * (`agendaWeb.almacen.ts::Lectura`). Cubre que la lectura de Turso llegue con algo de retraso.
 */
const MARGEN_LECTURA_MS = 60_000;
/**
 * Cuántas altas que esperan mira la alarma en Turso por consulta, y cuántas consultas hace cada vez.
 * Lo que no le dé tiempo lo sigue en la siguiente, desde donde lo dejó (`cursor_alarma`).
 */
const MAX_RECONCILIAR = 500;
const LOTES_POR_ALARMA = 5;

type ErrorAgenda =
	| "reserva_web_cerrada"
	| "dia_no_reservable"
	| "hora_fuera_de_franja"
	| "mesa_no_disponible"
	| "limite_reservas_correo"
	| "tope_reservas_negocio"
	| "reserva_no_cancelable"
	| "enlace_no_valido";

/** Los rechazos de negocio cruzan el RPC como resultado, no como excepción (igual que `aplicar`). */
export type RechazoAgenda = { ok: false; error: ErrorAgenda; status: 400 | 404 | 409 | 429 };

const STATUS: Record<ErrorAgenda, RechazoAgenda["status"]> = {
	reserva_web_cerrada: 409,
	dia_no_reservable: 400,
	hora_fuera_de_franja: 400,
	mesa_no_disponible: 409,
	limite_reservas_correo: 409,
	tope_reservas_negocio: 429,
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
	| { ok: true; dia: string; hora: string; personas: number; mesa: string; estado: EstadoPublico; cancelable: boolean }
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

/** La forma de un token de enlace: lo demás no se busca. */
const TOKEN_RE = /^[A-Za-z0-9_-]{22}$/;

/** Lo que se lee de Turso para decidir sobre un día. */
type DiaLeido = {
	/** Cuándo se empezó a leer: de ahí sale `Lectura.vistasDesdeMs`. */
	leidaMs: number;
	ahora: string;
	ajustes: AjustesWeb;
	cierres: Set<string>;
	mesas: MesaWeb[];
	franjas: FranjaWeb[];
	ocupaciones: Ocupacion[];
	idsEnTurso: Set<string>;
};

/** El estado de una reserva en Turso, para el enlace de cancelar, con el correo de su cliente. */
type ReservaEnTurso = { dia: string; hora: string; personas: number; id_mesa: string | null; estado: string; email: string | null };

export type Lector = <T>(tenantId: string, fn: (db: Client, ahora: string) => Promise<T>) => Promise<T>;

export class MotorAgendaWeb {
	/** Cómo se lee Turso. Los tests lo cambian por un cliente sobre SQLite. */
	leer: Lector;

	constructor(
		private readonly ctx: DurableObjectState,
		private readonly env: Env,
	) {
		prepararAlmacen(ctx.storage.sql);
		this.leer = (tenantId, fn) => lecturaConHora(env, tenantId, horaDelNegocio, fn);
	}

	/**
	 * El empujón a la Main: que venga a recoger (`TenantHub.avisarReservasWeb`). Sin esperarlo y sin
	 * fallar si no contesta: lo que hay que entregar ya está guardado, y la Main lo recoge igual al
	 * conectar o cuando la alarma se lo vuelve a ofrecer.
	 */
	private avisarALaMain(tenantId: string): void {
		const hub = this.env.TenantHub.get(this.env.TenantHub.idFromName(tenantId));
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
		return this.ctx.storage.sql;
	}

	private async leerDia(tenantId: string, dia: string): Promise<DiaLeido> {
		const leidaMs = Date.now();
		return this.leer(tenantId, async (db, ahora) => {
			const ajustes = await ajustesWeb(db);
			const [cierres, { mesas, franjas }, ocupacion] = await Promise.all([
				cierresEntre(db, dia, dia),
				mesasYFranjas(db),
				ocupacionAlrededorDe(db, dia, ajustes.duracion),
			]);
			return { leidaMs, ahora, ajustes, cierres, mesas, franjas, ocupaciones: ocupacion.ocupaciones, idsEnTurso: ocupacion.ids };
		});
	}

	/** Si el día o la hora no valen, el rechazo. */
	private motivo(d: DiaLeido, dia: string, hora: string): RechazoAgenda | null {
		const delDia = motivoDelDia(dia, d.ahora.slice(0, 10), d.ajustes, d.cierres);
		if (delDia === "reserva_web_cerrada") return rechazo("reserva_web_cerrada");
		if (delDia) return rechazo("dia_no_reservable");
		if (!horaEnTramos(tramosDelDia(d.mesas, d.franjas, dia, d.ajustes), hora)) return rechazo("hora_fuera_de_franja");
		return null;
	}

	/** Las mesas libres a esa hora, contando Turso y lo que espera aquí. Síncrono. */
	private mesasLibres(d: DiaLeido, dia: string, hora: string, personas: number): MesaWeb[] {
		const lectura = { ids: d.idsEnTurso, vistasDesdeMs: d.leidaMs - MARGEN_LECTURA_MS };
		const ocupado = [...d.ocupaciones, ...ocupacionPendiente(this.sql, dia, d.ajustes.duracion, lectura)];
		const adecuadas = mesasAdecuadas(d.mesas, d.franjas, dia, hora, personas, d.ajustes);
		return libres(adecuadas, ocupado, dia, hora, d.ajustes.duracion);
	}

	async disponibles(p: { tenantId: string; dia: string; hora: string; personas: number }): Promise<ResultadoDisponibles> {
		recordarNegocio(this.sql, p.tenantId);
		const d = await this.leerDia(p.tenantId, p.dia);

		const motivo = this.motivo(d, p.dia, p.hora);
		if (motivo) return motivo;

		darPorVistas(this.sql, d.idsEnTurso, Date.now());
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
	 */
	async reservar(p: { tenantId: string; alta: AltaReservaWeb; intento?: string | null }): Promise<ResultadoReservar> {
		const { alta } = p;
		recordarNegocio(this.sql, p.tenantId);
		const repetida = this.repeticion(p.intento);
		if (repetida) return repetida;

		// Lo asíncrono, antes del bloque que decide.
		const token = nuevoToken();
		const [tokenHash, emailHash] = await Promise.all([sha256HexStr(token), sha256HexStr(alta.email)]);
		const leidaMs = Date.now();
		const leido = await this.leer(p.tenantId, async (db, ahora) => {
			const ajustes = await ajustesWeb(db);
			const hoy = ahora.slice(0, 10);
			const [cierres, { mesas, franjas }, ocupacion, delCorreo, numero] = await Promise.all([
				cierresEntre(db, alta.dia_ymd, alta.dia_ymd),
				mesasYFranjas(db),
				ocupacionAlrededorDe(db, alta.dia_ymd, ajustes.duracion),
				reservasVivasDelCorreo(db, alta.email, hoy),
				numeroDeMesa(db, alta.id_mesa),
			]);
			const dia: DiaLeido = {
				leidaMs,
				ahora,
				ajustes,
				cierres,
				mesas,
				franjas,
				ocupaciones: ocupacion.ocupaciones,
				idsEnTurso: ocupacion.ids,
			};
			return { dia, delCorreo, numero };
		});
		const d = leido.dia;

		// ── Desde aquí, síncrono hasta apuntarla ──
		// Otra vez: el mismo intento pudo apuntarse mientras éste leía Turso.
		const repetidaAlLeer = this.repeticion(p.intento);
		if (repetidaAlLeer) return repetidaAlLeer;

		const motivo = this.motivo(d, alta.dia_ymd, alta.hora);
		if (motivo) return motivo;

		const ahoraMs = Date.now();
		darPorVistas(this.sql, [...d.idsEnTurso, ...leido.delCorreo], ahoraMs);

		const libre = this.mesasLibres(d, alta.dia_ymd, alta.hora, alta.personas).some((m) => m.id_mesa === alta.id_mesa);
		if (!libre || leido.numero === null) return rechazo("mesa_no_disponible");

		const hoy = d.ahora.slice(0, 10);
		const lecturaDelCorreo = { ids: leido.delCorreo, vistasDesdeMs: leidaMs - MARGEN_LECTURA_MS };
		if (leido.delCorreo.size + vivasDelCorreoEnLaAgenda(this.sql, emailHash, hoy, lecturaDelCorreo) >= MAX_RESERVAS_POR_CORREO) {
			return rechazo("limite_reservas_correo");
		}
		if (altasDesde(this.sql, ahoraMs - 86_400_000) >= MAX_ALTAS_DIA_NEGOCIO) return rechazo("tope_reservas_negocio");

		const idReserva = nuevoId();
		// El enlace vale hasta un día después de la reserva. La hora es de pared del negocio y aquí se
		// lee como UTC: un día y medio de margen cubre cualquier desfase.
		const caducaMs = Date.parse(`${alta.dia_ymd}T${alta.hora}:00Z`) + 36 * 3_600_000;
		const respuesta = {
			id_reserva: idReserva,
			codigo: codigoDeReserva(idReserva),
			dia: alta.dia_ymd,
			hora: alta.hora,
			personas: alta.personas,
			mesa: leido.numero,
		};
		this.ctx.storage.transactionSync(() => {
			apuntarAlta(
				this.sql,
				{
					id_peticion: nuevoId(),
					tipo: "alta",
					id_reserva: idReserva,
					id_mesa: alta.id_mesa,
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
			if (p.intento) apuntarIntento(this.sql, p.intento, respuesta, ahoraMs);
		});
		// ── Fin del bloque ──

		this.avisarALaMain(p.tenantId);
		await this.asegurarAlarma();
		return { ok: true, ...respuesta, token, repetida: false };
	}

	/** Lo que contestó ya ese intento, si acabó en reserva. */
	private repeticion(intento: string | null | undefined): ResultadoReservar | null {
		const r = intento ? respuestaDelIntento(this.sql, intento, Date.now()) : null;
		return r ? { ok: true, ...r, token: null, repetida: true } : null;
	}

	/** El resumen para la página de cancelar. */
	async consultarEnlace(p: { tenantId: string; token: string }): Promise<ResultadoConsulta> {
		recordarNegocio(this.sql, p.tenantId);
		const idReserva = await this.reservaDelToken(p.token);
		if (!idReserva) return rechazo("enlace_no_valido");

		const { leidaMs, ahora, enTurso, numero } = await this.leerReserva(p.tenantId, idReserva);
		const alta = peticion(this.sql, "alta", idReserva);
		const datos = enTurso ?? (alta ? { dia: alta.dia_ymd, hora: alta.hora, personas: alta.comensales, id_mesa: alta.id_mesa } : null);
		if (!datos) return rechazo("enlace_no_valido");

		const estado = this.estadoPublico(idReserva, enTurso, ahora, datos, leidaMs);
		return {
			ok: true,
			dia: datos.dia,
			hora: datos.hora,
			personas: datos.personas,
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
		const idReserva = await this.reservaDelToken(p.token);
		if (!idReserva) return rechazo("enlace_no_valido");

		const { leidaMs, ahora, enTurso, numero } = await this.leerReserva(p.tenantId, idReserva);
		// ── Síncrono hasta el final ──
		const ahoraMs = Date.now();
		if (enTurso) darPorVistas(this.sql, [idReserva], ahoraMs);
		const alta = peticion(this.sql, "alta", idReserva);
		const datos = enTurso ?? (alta ? { dia: alta.dia_ymd, hora: alta.hora, personas: alta.comensales, id_mesa: alta.id_mesa } : null);
		if (!datos) return rechazo("enlace_no_valido");

		const estado = this.estadoPublico(idReserva, enTurso, ahora, datos, leidaMs);
		// Ya cancelada: ya se le dijo, no se le vuelve a escribir.
		if (estado === "cancelada") return { ok: true, aviso: null };
		if (estado === "pasada") return rechazo("reserva_no_cancelable");

		// A quién decírselo: al cliente de la reserva en Turso o, si aún no está, al correo del alta.
		// Antes de anularla, que se lleva los datos del alta.
		const email = enTurso?.email ?? correoDelAlta(alta);
		const aviso: AvisoDeCancelacion | null = email
			? { id_reserva: idReserva, email, dia: datos.dia, hora: datos.hora, personas: datos.personas, mesa: numero }
			: null;

		if (!enTurso && anularAlta(this.sql, idReserva, ahoraMs)) return { ok: true, aviso };
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
	 * visto lo que ya está en Turso, para no volver a entregarlo. Si Turso no contesta se entrega
	 * igual: registrarlo dos veces no lo duplica.
	 */
	async pendientes(p: { tenantId: string }): Promise<{ ok: true } & PendientesReservaWebDto> {
		recordarNegocio(this.sql, p.tenantId);
		try {
			await this.reconciliarConTurso();
		} catch (e: any) {
			console.warn("[agenda-web] no se ha podido mirar Turso antes de entregar:", String(e?.message || e));
		}
		const { peticiones, hayMas } = entregarPendientes(this.sql, MAX_ENTREGA, Date.now());
		if (peticiones.length) {
			this.anotar({ event: "reserva_web_entregada", tenant_id: p.tenantId, cuantas: peticiones.length });
			// La alarma es la que las vuelve a ofrecer si no llegan a Turso.
			await this.asegurarAlarma();
		}
		return { ok: true, peticiones: peticiones.map(paraLaMain), hay_mas: hayMas };
	}

	/** Lo que la Main contesta de lo entregado (`agendaWeb.almacen.ts::apuntarResultados`). */
	async recogidas(p: { tenantId: string; resultados: ResultadoDeLaMain[] }): Promise<{ ok: true; apuntadas: number }> {
		recordarNegocio(this.sql, p.tenantId);
		const { apuntadas, fallidas } = apuntarResultados(this.sql, p.resultados, Date.now());
		for (const f of fallidas) {
			// El correo al cliente es de la fase 5 (§4.8); hasta entonces queda en el log.
			this.anotar({ event: "reserva_web_fallida", tenant_id: p.tenantId, id_reserva: f.id_reserva, motivo: f.codigo ?? undefined });
		}
		return { ok: true, apuntadas };
	}

	/** Lo que ve quien abre el enlace. Síncrono. */
	private estadoPublico(
		idReserva: string,
		enTurso: ReservaEnTurso | null,
		ahora: string,
		datos: { dia: string; hora: string },
		leidaMs: number,
	): EstadoPublico {
		const alta = peticion(this.sql, "alta", idReserva);
		// Que no esté en esta lectura de Turso sólo quiere decir que se borró si se dio por vista antes
		// de empezar a leerla: si fue mientras, la lectura es simplemente más vieja (`Lectura`).
		const borrada =
			!enTurso && alta?.estado === "vista" && Number(alta.cerrada_ms ?? 0) < leidaMs - MARGEN_LECTURA_MS;
		const cancelada =
			enTurso?.estado === "CANCELADA" ||
			alta?.estado === "anulada" ||
			// La Main no pudo registrarla: al cliente se le avisa por correo y deja de valer.
			alta?.estado === "fallida" ||
			// Estuvo en Turso y ya no está: el restaurante la borró, que es cancelarla.
			borrada ||
			peticion(this.sql, "cancelacion", idReserva) !== null;
		if (cancelada) return "cancelada";
		// Sentados (ACTIVA), terminada o no se presentaron: ya no es una reserva por venir.
		if (enTurso && enTurso.estado !== "PROXIMA") return "pasada";
		// Hasta la hora de la reserva, en la hora del negocio.
		if (intervalo(datos.dia, datos.hora, 0).inicio <= ahora) return "pasada";
		return "confirmada";
	}

	private async reservaDelToken(token: string): Promise<string | null> {
		if (!TOKEN_RE.test(token)) return null;
		const hash = await sha256HexStr(token);
		return reservaDelEnlace(this.sql, hash, Date.now());
	}

	private async leerReserva(
		tenantId: string,
		idReserva: string,
	): Promise<{ leidaMs: number; ahora: string; enTurso: ReservaEnTurso | null; numero: string | null }> {
		const leidaMs = Date.now();
		return this.leer(tenantId, async (db, ahora) => {
			const rs = await db.execute({
				sql: `SELECT R.Dia_YMD AS dia, R.Hora AS hora, R.Comensales AS personas, R.ID_Mesa AS id_mesa,
				             R.Estado AS estado, NULLIF(TRIM(C.Email), '') AS email
				      FROM Reservas R LEFT JOIN Clientes C ON C.ID_Cliente = R.ID_Cliente
				      WHERE R.ID_Reserva = ?1;`,
				args: [idReserva],
			});
			const r: any = rs.rows?.[0];
			const enTurso: ReservaEnTurso | null = r
				? {
						dia: String(r.dia),
						hora: String(r.hora),
						personas: Number(r.personas),
						id_mesa: r.id_mesa ?? null,
						estado: String(r.estado),
						email: typeof r.email === "string" ? r.email : null,
					}
				: null;
			const idMesa = enTurso?.id_mesa ?? peticion(this.sql, "alta", idReserva)?.id_mesa ?? null;
			const numero = idMesa ? await numeroDeMesa(db, idMesa) : null;
			return { leidaMs, ahora, enTurso, numero };
		});
	}

	/** Una sola alarma, reprogramada mientras haya algo guardado. */
	private async asegurarAlarma(): Promise<void> {
		if ((await this.ctx.storage.getAlarm()) === null) {
			await this.ctx.storage.setAlarm(Date.now() + CADA_ALARMA_MS);
		}
	}

	async alarm(): Promise<void> {
		let turso = true;
		try {
			await this.reconciliarConTurso();
		} catch (e: any) {
			// Sin Turso se purga igual; lo que espera se vuelve a mirar en la próxima.
			turso = false;
			console.warn("[agenda-web] la alarma no ha podido mirar Turso:", String(e?.message || e));
		}
		const tenantId = negocioRecordado(this.sql);
		const ahoraMs = Date.now();
		// Sólo con lo visto en Turso al día: sin él, se volvería a ofrecer lo que ya llegó.
		if (turso && tenantId) {
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
		const quedaAlgo = purgar(this.sql, ahoraMs);
		if (quedaAlgo) await this.ctx.storage.setAlarm(Date.now() + CADA_ALARMA_MS);
	}

	/**
	 * Las altas que esperan y ya están en Turso pasan a `vista` y olvidan sus datos personales, aunque
	 * nadie vuelva a preguntar por ese día. Sin esto, una reserva cuyo día nadie consulta guardaría
	 * nombre, correo y teléfono hasta que se purgase.
	 */
	private async reconciliarConTurso(): Promise<void> {
		const tenantId = negocioRecordado(this.sql);
		if (!tenantId) return;
		const vistas = await this.reconciliarTipo(tenantId, "alta", SQL_ESTAN_EN_TURSO, darPorVistas);
		if (vistas > 0) this.anotar({ event: "reserva_web_vista", tenant_id: tenantId, cuantas: vistas });
		await this.reconciliarTipo(tenantId, "cancelacion", SQL_CANCELADAS_EN_TURSO, cancelacionesHechas);
	}

	/**
	 * Por lotes y avanzando aunque un lote no encuentre nada: si las más viejas no llegan nunca a
	 * Turso, no pueden tapar a las de detrás. Lo que no da tiempo sigue en la siguiente vez.
	 */
	private async reconciliarTipo(
		tenantId: string,
		tipo: "alta" | "cancelacion",
		sqlTurso: string,
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
			const enTurso = await this.leer(tenantId, async (db) => {
				const rs = await db.execute({ sql: sqlTurso, args: [JSON.stringify(ids)] });
				return (rs.rows ?? []).map((r: any) => String(r.id));
			});
			cerradas += cerrar(this.sql, enTurso, Date.now());
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
