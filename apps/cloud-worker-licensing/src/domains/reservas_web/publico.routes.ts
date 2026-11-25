// src/domains/reservas_web/publico.routes.ts
//
// Reservas desde la web (docs/estudios/reservas-web.md §4.2): lo que llama el widget, montado en
// `/v1/publico/reservas/:clave/…`. Sin `tenantAuth`: el negocio sale de la clave y todo lo que
// decide si se pasa es la puerta (`puerta.ts`), delante del validador.
//
//   GET  /negocio                         lo del negocio y el calendario: qué días se pueden reservar
//   GET  /dia?dia=                        las horas de llegada de ese día
//   GET  /plano                           salones y mesas, para dibujar
//   GET  /disponibles?dia=&hora=&personas= las mesas libres (o horas cercanas que tienen)
//   POST /reservas                        reservar (Turnstile en `X-Turnstile-Token`)
//   POST /reserva  { token }              el resumen para la página de cancelar
//   POST /cancelar { token }              cancelar desde el enlace del correo
//
// Lo que no depende de lo pendiente se lee directamente de la base, una lectura entera por viaje a su
// TenantHub (`leerParaLaWeb`); lo que sí (qué mesas están libres, reservar, cancelar), lo decide la
// agenda del negocio. Ninguna respuesta lleva datos
// personales de una reserva, y el token del enlace sólo viaja en el correo (§4.8): `/reserva` va
// por POST para que no salga en ninguna URL ni en ningún log.
//
// Los correos al cliente (`correos.ts`) salen de aquí al reservar y al cancelar, y van a la
// dirección del alta: nunca a una que llegue en el cuerpo de otra cosa.

import { Hono } from "hono";
import type {
	Disponibles,
	InfoNegocio,
	Plano,
	Reserva,
	ResumenReserva,
	Tramo,
} from "@altarialights/reservas-web-tpv/tipos";

import type { Env } from "../../env";
import { agendaDe } from "../../durableObjects/agendaWeb";
import { codigoDeReserva, type CorreoParaRepetir, type RechazoAgenda } from "../../durableObjects/agendaWeb.motor";
import { reportarReservaWeb } from "../../observability/axiom";
import { capturarError } from "../../observability/errors";
import { enSegundoPlano } from "../../lib/enSegundoPlano";
import { msDelId } from "../../lib/ids";
import { consulta, cuerpo } from "../../lib/validacion";
import { RETENCION_ENVIOS_MS } from "../../server/purga";
import { ipDeLaPeticion } from "../pairing/pairing.avisos";
import { diasAbiertos, maxPersonas, motivoDelDia, tramosDelDia } from "./disponibilidad";
import { enlaceDeCancelar, enviarCorreoReservaWeb, type NegocioDelCorreo, type ResultadoCorreo } from "./correos";
import { leerParaLaWeb } from "./lecturasDeLaWeb";
import { origenDelWidget } from "./claves";
import { corsPublico } from "./cors";
import {
	huellasDeLaConexion,
	limitadorAltas,
	puertaPublica,
	topeDelCuerpo,
	verificacionHumana,
	type PublicoVars,
} from "./puerta";
import {
	altaPublicaSchema,
	diaQuerySchema,
	disponiblesQuerySchema,
	tokenEnlaceSchema,
} from "./reservasWeb.schemas";

type Ctx = { Bindings: Env; Variables: PublicoVars };

/**
 * Lo que contesta cada ruta es lo que dice el SDK (`packages/reservas-web-sdk/src/tipos.ts`), que es
 * lo que leen el widget y las webs que hacen su propio formulario: con `satisfies`, un campo que
 * cambia aquí sin cambiar allí (o al revés) no compila.
 */
type ConOk<T> = T & { ok: true };

export const reservasWebPublicoRoutes = new Hono<Ctx>();

// Las webs del negocio pueden leer las respuestas desde el navegador (`cors.ts`); el preflight va en
// `index.ts`, delante del `OPTIONS` de todo el worker.
reservasWebPublicoRoutes.use("/:clave/*", corsPublico);

function rechazada(c: any, r: RechazoAgenda) {
	return c.json({ ok: false, error: r.error }, r.status);
}

/** El evento a Axiom, retenido más allá de la respuesta (ver `observability/axiom.ts`). */
function anotar(c: any, campos: Parameters<typeof reportarReservaWeb>[1]): void {
	enSegundoPlano(c, reportarReservaWeb(c.env, campos));
}

reservasWebPublicoRoutes.get("/:clave/negocio", puertaPublica, async (c) => {
	const d = await leerParaLaWeb(c.env, c.get("tenantId"), { que: "negocio" });

	// El interruptor general del negocio. Con el nombre y el teléfono, para que el widget diga a
	// quién llamar.
	if (!d.ajustes.activa) {
		return c.json(
			{ ok: false, error: "reserva_web_cerrada", negocio: { nombre: d.negocio.nombre, telefono: d.negocio.telefono } },
			409,
		);
	}
	return c.json({
		ok: true,
		negocio: d.negocio,
		hoy: d.hoy,
		primer_dia: d.primero,
		ultimo_dia: d.ultimo,
		dias_abiertos: diasAbiertos(d.hoy, d.ajustes, d.cierres, d.mesas, d.franjas),
		max_personas: maxPersonas(d.mesas, d.franjas),
		duracion_min: d.ajustes.duracion,
		turnstile: c.env.TURNSTILE_SITE_KEY ?? null,
	} satisfies ConOk<InfoNegocio>);
});

reservasWebPublicoRoutes.get("/:clave/dia", puertaPublica, consulta(diaQuerySchema), async (c) => {
	const { dia } = c.req.valid("query");
	const d = await leerParaLaWeb(c.env, c.get("tenantId"), { que: "dia", dia });
	const motivo = motivoDelDia(dia, d.hoy, d.ajustes, d.cierres);
	if (motivo) return c.json({ ok: false, error: motivo }, motivo === "reserva_web_cerrada" ? 409 : 400);
	return c.json({ ok: true, dia, tramos: tramosDelDia(d.mesas, d.franjas, dia, d.ajustes) } satisfies ConOk<{ dia: string; tramos: Tramo[] }>);
});

reservasWebPublicoRoutes.get("/:clave/plano", puertaPublica, async (c) => {
	const plano = await leerParaLaWeb(c.env, c.get("tenantId"), { que: "plano" });
	c.header("Cache-Control", "public, max-age=60");
	return c.json({ ok: true, ...plano } satisfies ConOk<Plano>);
});

reservasWebPublicoRoutes.get(
	"/:clave/disponibles",
	puertaPublica,
	consulta(disponiblesQuerySchema),
	async (c) => {
		const q = c.req.valid("query");
		const r = await agendaDe(c.env, c.get("tenantId")).disponibles({ tenantId: c.get("tenantId"), ...q });
		if (!r.ok) return rechazada(c, r);
		return c.json({ ok: true, mesas: r.mesas, alternativas: r.alternativas } satisfies ConOk<Disponibles>);
	},
);

/** Lo del negocio para un correo. Si no se puede leer, el correo sale igual, sin ello. */
async function negocioParaElCorreo(c: any, tenantId: string): Promise<NegocioDelCorreo> {
	try {
		return await leerParaLaWeb(c.env, tenantId, { que: "negocioDelCorreo" });
	} catch (e: any) {
		console.warn("[reservas-web] no se ha podido leer el negocio para el correo:", String(e?.message || e));
		return { nombre: "", direccion: "", telefono: "", correo: null };
	}
}

/**
 * RW-ALTAS · El id del correo de confirmación de una reserva, mientras su traza siga en
 * `email_sends`. La purga la borra a los 90 días (`RETENCION_ENVIOS_MS`), y una reserva web se puede
 * hacer con hasta un año de antelación: pasado ese plazo (menos un día, lo que tarda en pasar el
 * cron) ya no se puede saber si salió, y el «has cancelado» sale sin mirarlo. La edad sale del
 * propio id, un UUIDv7 que pone la agenda al apuntar el alta.
 */
function confirmacionQueSigueApuntada(idReserva: string): string | undefined {
	const creadaMs = msDelId(idReserva);
	if (creadaMs === null || Date.now() - creadaMs > RETENCION_ENVIOS_MS - 86_400_000) return undefined;
	return `rw:confirmacion:${idReserva}`;
}

/**
 * RESERVA-CORREOS · Un correo al cliente que no ha salido porque la base central no contesta (no se
 * sabe si ya salió) o el binding ha fallado, o que otro está mandando: se apunta en la agenda, cuya
 * alarma lo repite en unos minutos con el mismo id (si el primero sí salió, no sale otro). Lo que no
 * sale por el tope, porque no salió el correo de antes o porque el destinatario no es una dirección
 * (`invalido`), no se repite. Devuelve si queda apuntado.
 */
async function repetirSiNoHaSalido(c: any, tenantId: string, resultado: ResultadoCorreo, correo: CorreoParaRepetir): Promise<boolean> {
	if (resultado !== "fallido" && resultado !== "en_curso") return false;
	try {
		await agendaDe(c.env, tenantId).apuntarCorreoPendiente({ tenantId, correo });
		return true;
	} catch (e: any) {
		capturarError(e, "reservas_web.correo.repetir");
		return false;
	}
}

/** Una `Idempotency-Key` del widget: un UUID, o algo de su estilo. */
const CLAVE_DE_INTENTO = /^[A-Za-z0-9_-]{16,64}$/;

reservasWebPublicoRoutes.post(
	"/:clave/reservas",
	puertaPublica,
	limitadorAltas,
	verificacionHumana,
	topeDelCuerpo,
	cuerpo(altaPublicaSchema),
	async (c) => {
		const alta = c.req.valid("json");
		const tenantId = c.get("tenantId");
		// La clave del intento: la misma mientras el widget repite un alta cuya respuesta no le llegó.
		// Una sin la forma esperada se ignora: el alta sigue, sólo que sin esa protección.
		const clave = c.req.header("Idempotency-Key");
		const intento = clave && CLAVE_DE_INTENTO.test(clave) ? clave : null;
		// RW-ALTAS · La conexión (y en IPv6 su red), para sus topes en la agenda: sólo sus huellas,
		// nunca la IP.
		const huellas = await huellasDeLaConexion(c.env, tenantId, ipDeLaPeticion(c.req.raw));
		const r = await agendaDe(c.env, tenantId).reservar({
			tenantId,
			alta,
			intento,
			conexion: huellas?.conexion ?? null,
			red: huellas?.red ?? null,
		});
		if (!r.ok) {
			anotar(c, { event: "reserva_web_rechazo", tenant_id: tenantId, motivo: r.error });
			return rechazada(c, r);
		}
		anotar(c, { event: r.repetida ? "reserva_web_alta_repetida" : "reserva_web_alta", tenant_id: tenantId, id_reserva: r.id_reserva });

		// La confirmación, con el enlace de cancelar: el token NO va en la respuesta, sólo aquí. Una
		// repetición ya no lo tiene (de él sólo queda el hash): su correo fue el del alta de verdad, y
		// `correo_enviado: null` dice que no se sabe si llegó. Un correo que falla no deshace la reserva:
		// si lo repite la alarma de la agenda, tampoco se sabe aún si llegará (`null`); si no, el widget
		// dice que no ha salido y enseña el código.
		let correoEnviado: boolean | null = null;
		if (r.token) {
			const origen = origenDelWidget(c.env, c.req.url);
			const clave = c.req.param("clave");
			const enviado = await enviarCorreoReservaWeb(c.env, {
				tenantId,
				id: `rw:confirmacion:${r.id_reserva}`,
				tipo: "confirmacion",
				para: alta.email,
				negocio: await negocioParaElCorreo(c, tenantId),
				reserva: { dia: r.dia, hora: r.hora, personas: r.personas, mesa: r.mesa, codigo: r.codigo },
				enlace: enlaceDeCancelar(origen, clave, r.token),
				dispositivo: "web",
			});
			const seRepite = await repetirSiNoHaSalido(c, tenantId, enviado, {
				tipo: "confirmacion",
				id_reserva: r.id_reserva,
				para: alta.email,
				dia: r.dia,
				hora: r.hora,
				personas: r.personas,
				mesa: r.mesa,
				enlace: { origen, clave },
			});
			// En curso por otro lado no se sabe aún: lo mismo que una repetición.
			correoEnviado = enviado === "en_curso" || seRepite ? null : enviado === "enviado" || enviado === "ya_enviado";
		}
		return c.json({
			ok: true,
			codigo: r.codigo,
			dia: r.dia,
			hora: r.hora,
			personas: r.personas,
			mesa: r.id_mesa,
			mesa_nombre: r.mesa,
			correo_enviado: correoEnviado,
		} satisfies ConOk<Reserva>);
	},
);

reservasWebPublicoRoutes.post("/:clave/reserva", puertaPublica, topeDelCuerpo, cuerpo(tokenEnlaceSchema), async (c) => {
	const { token } = c.req.valid("json");
	const r = await agendaDe(c.env, c.get("tenantId")).consultarEnlace({ tenantId: c.get("tenantId"), token });
	if (!r.ok) return rechazada(c, r);
	return c.json({
		ok: true,
		dia: r.dia,
		hora: r.hora,
		personas: r.personas,
		mesa: r.id_mesa,
		mesa_nombre: r.mesa,
		estado: r.estado,
		cancelable: r.cancelable,
	} satisfies ConOk<ResumenReserva>);
});

reservasWebPublicoRoutes.post("/:clave/cancelar", puertaPublica, topeDelCuerpo, cuerpo(tokenEnlaceSchema), async (c) => {
	const { token } = c.req.valid("json");
	const tenantId = c.get("tenantId");
	const r = await agendaDe(c.env, tenantId).cancelar({ tenantId, token });
	if (!r.ok) return rechazada(c, r);
	anotar(c, { event: "reserva_web_cancelada", tenant_id: tenantId });
	// «Has cancelado tu reserva», a su cliente. Sólo si se acaba de cancelar: la segunda vez no. Y sólo
	// si salió (o está saliendo) su confirmación (RW-ALTAS): una reserva que nunca se le confirmó a
	// nadie no gasta cupo al cancelarse. Con el enlace de un correo de cambio del restaurante no se
	// mira: ese correo lo pidió la Main, y es por donde le llegó el enlace aunque la confirmación fallara.
	// Si no sale porque la central no contesta, lo repite la alarma de la agenda (RESERVA-CORREOS).
	if (r.aviso) {
		const a = r.aviso;
		const trasElCorreo = a.con_enlace_de_un_cambio ? undefined : confirmacionQueSigueApuntada(a.id_reserva);
		const enviado = await enviarCorreoReservaWeb(c.env, {
			tenantId,
			id: `rw:cancelacion:${a.id_reserva}`,
			tipo: "cancelacion",
			para: a.email,
			negocio: await negocioParaElCorreo(c, tenantId),
			reserva: { dia: a.dia, hora: a.hora, personas: a.personas, mesa: a.mesa, codigo: codigoDeReserva(a.id_reserva) },
			dispositivo: "web",
			trasElCorreo,
		});
		await repetirSiNoHaSalido(c, tenantId, enviado, {
			tipo: "cancelacion",
			id_reserva: a.id_reserva,
			para: a.email,
			dia: a.dia,
			hora: a.hora,
			personas: a.personas,
			mesa: a.mesa,
			tras_el_correo: trasElCorreo ?? null,
		});
	}
	return c.json({ ok: true });
});
