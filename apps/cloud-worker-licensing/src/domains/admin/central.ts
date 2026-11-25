// src/domains/admin/central.ts
//
// La base central desde la administración: cómo está, sus copias, copiarla ahora, darle esquema o
// restaurarla desde una copia, y devolverla a un instante. Va montado en `admin.routes.ts`, detrás de
// `requireAdmin` (`ADMIN_API_TOKEN`), que no lee la central: todo esto funciona también con ella sin
// aprovisionar. El CLI lo llama con `pnpm central:*` (`scripts/tpv-license.mjs`).
//
//   GET  /v1/admin/central/estado        → si está aprovisionada, sus migraciones, si tiene avería o
//                                          algo a medias, sus filas por tabla y lo que ocupa
//   GET  /v1/admin/central/copias        → sus copias en R2, de la más reciente a la más vieja, y
//                                          hasta cuántas filas se restauran de una vez
//   POST /v1/admin/central/copiar-ahora  → una copia ahora, con la hora en la clave: no pisa la del día
//   POST /v1/admin/central/aprovisionar  → a un objeto sin aprovisionar, el esquema vacío o, con
//                                          `claveDeCopia`, la base de esa copia
//   POST /v1/admin/central/volver        → a un instante de los últimos 30 días, o a un marcador; o,
//                                          con `reiniciar`, aplica una vuelta ya preparada
//
// Lo que cambia algo deja rastro en Axiom y en el log (`rastro`), no en `admin_audit`: es una tabla
// de la propia central, y restaurarla o devolverla a un instante la reescriben. Restaurar y volver lo
// dejan antes de llamar al objeto (`empieza`), y si la llamada no vuelve, también (`sin_respuesta`):
// una restauración que pasa de 30 s reinicia el objeto, y una vuelta se aplica aunque la respuesta no
// llegue. Aplicar una vuelta ya preparada lo deja antes de reiniciar (`reinicia`). El rastro sólo lleva
// lo nuestro: códigos, claves y marcadores que han pasado su gramática (`esClaveDeCopiaDeLaCentral`,
// `esMarcador`), recuentos. El `detalle` del objeto (lo que dicen SQLite, R2 o la plataforma) va en
// la respuesta, a quien administra, y nunca al rastro.

import { Hono, type Context } from "hono";
import * as z from "zod";

import type { Env } from "../../env";
import { enSegundoPlano } from "../../lib/enSegundoPlano";
import { centralDe } from "../../lib/objetosDelNegocio";
import { recortar } from "../../lib/texto";
import { cuerpo } from "../../lib/validacion";
import { reportarAdministracionDeLaCentral } from "../../observability/axiom";
import { estadoHttpDe } from "../../server/central/cliente";
import {
	COPIA_A_MANO,
	esClaveDeCopiaDeLaCentral,
	listarCopiasDeLaCentral,
	NOMBRES_DE_UNA_COPIA,
} from "../../durableObjects/baseCentral.copia";
import type {
	CodigoDeLaCentral,
	EstadoDeLaCentral,
	FalloDeLaCentral,
	VueltaPreparada,
} from "../../durableObjects/baseCentral.rpc";
import { FILAS_QUE_SE_RESTAURAN_DE_UNA_VEZ } from "../../durableObjects/baseCentral.restaurar";
import type { CopiaInservible } from "../../durableObjects/cargaDeCopias";
import { esMarcador } from "../../durableObjects/instantes";

export const centralRoutes = new Hono<{ Bindings: Env }>();

/** Cuántas copias devuelve la lista, como mucho (el techo va en la respuesta). */
const TECHO_COPIAS = 100;

/** Tras reiniciarla, cuántas veces se le pregunta a la central cómo está, y cada cuánto. */
const INTENTOS_TRAS_REINICIAR = 10;
const PAUSA_TRAS_REINICIAR_MS = 500;

/** Lo que dice la ruta de una vuelta, además de lo que contesta la central. */
type CodigoDeLaVuelta = "central_vuelta_sin_comprobar" | "central_vuelta_sin_aplicar";

/**
 * Lo que se dice de una vuelta que devuelve con qué se deshace, por si se pierde: el objeto lo deja
 * en R2 antes de pedirla (`baseCentral.instante.ts`), y si aun así no está, se deshace volviendo a un
 * instante de justo antes, el de `cerradaDesde` en la respuesta (V-OP-3).
 */
const SI_SE_PIERDE_EL_MARCADOR =
	"El marcador para deshacerla queda también en R2 (pnpm central:copias, columna marcador); si aun así se pierde, se deshace volviendo con --instante a justo antes de la vuelta, cuando se cerró la central (cerradaDesde, con la hora del worker).";

/**
 * Lo que se dice cuando, al ir a reiniciar la central para aplicar una vuelta recién preparada, el
 * objeto contesta que ya no la tiene (C1): otra ha empezado encima, o ya no hay ninguna.
 */
const OTRA_AL_REINICIAR =
	"Al ir a reiniciar la central para aplicar esta vuelta, la que había en curso era otra, que empezó después: no se ha reiniciado para ésta, que ya no sigue. Mira cómo está con pnpm central:estado antes de repetir nada: si la otra ya se ha aplicado, la central está donde la dejó ella.";
const NINGUNA_AL_REINICIAR =
	"Al ir a reiniciar la central para aplicar esta vuelta, ya no había ninguna preparada: o la central se ha reiniciado entretanto y ha vuelto a ésta, u otra vuelta se ha preparado encima y es la que se ha aplicado. No se sabe cuál: en pnpm central:copias, si después de la copia de antes de ésta hay otra antes-de-volver con hora en «pedida», se aplicó la otra; si no, ésta. Míralo antes de repetir nada.";

/** Por dónde se sale de una vuelta que deja la central sin atender. */
const SALIDAS_DE_LA_VUELTA = "deshaciendo la vuelta, o volviendo a otro instante: pnpm central:volver lo hace con la central así.";

/**
 * Lo que se dice de una vuelta que deja la central sin esquema, en vez de lo de `QUE_PASA`: antes de
 * volver tenía sus licencias, y el esquema vacío la pondría a atender sin ninguna.
 */
const SIN_ESQUEMA_TRAS_VOLVER =
	"La vuelta la ha dejado sin esquema. No le des el esquema vacío (pnpm central:aprovisionar sin --copia): atendería sin ninguna licencia, y los TPV que preguntaran por la suya la borrarían.";

/** Lo que se le dice a quien administra cuando la central no ha hecho lo que se le pedía. */
const QUE_PASA: Partial<Record<CodigoDeLaCentral | CodigoDeLaVuelta, string>> = {
	central_sin_aprovisionar: "La central no está aprovisionada: dale esquema o restáurala con pnpm central:aprovisionar.",
	central_ya_aprovisionada: "La central ya está aprovisionada, y no se ha tocado: sólo se aprovisiona un objeto vacío.",
	central_restauracion_a_medias: `Hay una restauración a medias y la central no atiende: vuelve a restaurar desde una copia (pnpm central:aprovisionar -- --copia <clave> --si). Si la anterior se cortó por tiempo (no hubo respuesta), con una copia de más de ${FILAS_QUE_SE_RESTAURAN_DE_UNA_VEZ} filas (las dice pnpm central:copias) se volverá a cortar: hace falta una copia con menos filas o cargarla por partes.`,
	central_copia_inservible: "Esa copia no se puede restaurar: la central se queda sin aprovisionar, como estaba.",
	central_vuelta_en_curso:
		"Hay una vuelta a un instante en curso, y la central no atiende hasta que se aplique. Si está preparada, se aplica con pnpm central:volver -- --reiniciar <deshacer> --si (pnpm central:estado da la orden entera); si se está preparando, espera a que acabe.",
	central_vuelta_a_la_vez:
		"Otra vuelta a un instante se estaba preparando a la vez, y sólo sigue una: mira cuál con pnpm central:estado antes de repetir nada.",
	central_sin_vuelta_preparada:
		"Ya no hay ninguna vuelta preparada con ese marcador: o se ha aplicado (la central se ha reiniciado desde entonces), o no llegó a pedirse. No se ha reiniciado nada: mira cómo está con pnpm central:estado.",
	central_instante_fuera_de_plazo: "Sólo se puede volver a un instante pasado de los últimos 30 días.",
	central_vuelta_no_disponible: "Este despliegue no puede devolver un objeto a un instante (en local no existe).",
	central_vuelta_rechazada:
		"La plataforma no ha aceptado la vuelta: no se ha pedido, y la central se queda como estaba. Lo que se haya subido a R2 para ella (en pnpm central:copias, sin hora en pedida) no es de ninguna vuelta: no hay nada que deshacer.",
	central_copia_fallida: "La copia no ha llegado a R2, y no se ha hecho nada. Al volver a un instante, sin la copia (o, con la central sin atender, sin su marcador) no se pide la vuelta.",
	central_vuelta_sin_comprobar: `La vuelta está preparada y la central se ha reiniciado, pero no contesta todavía: mira cómo está con pnpm central:estado. ${SI_SE_PIERDE_EL_MARCADOR}`,
	central_vuelta_sin_aplicar: `La vuelta está preparada pero la central no se ha reiniciado, y sigue cerrada. Se aplica con pnpm central:volver -- --reiniciar <deshacer> --si, con el deshacer de esta respuesta: sólo reinicia la central si esta vuelta sigue preparada, y si ya se ha aplicado, no hace nada. No repitas la orden de la vuelta: si la central se ha reiniciado entretanto, ya ha vuelto, y volvería otra vez. ${SI_SE_PIERDE_EL_MARCADOR}`,
	central_migracion_alterada: "Una migración ya aplicada ha cambiado: la central no atiende.",
	central_migracion_fallida: "Una migración no ha podido aplicarse: la central no atiende.",
};

/**
 * La respuesta de lo que la central contesta que no ha hecho: su código, qué pasa (`message`, entre
 * lo que haya pasado `antes` y lo que se puede hacer `despues`) y, si el objeto lo dice, por qué
 * (`detalle`, el motivo técnico, que el CLI enseña aparte). `quePasa` sustituye a lo que dice
 * `QUE_PASA` de ese código, cuando en ese sitio no es lo que hay que hacer. `extra` va tal cual.
 */
function noHecho(
	c: Context<{ Bindings: Env }>,
	fallo: FalloDeLaCentral,
	opciones: { antes?: string; quePasa?: string; despues?: string; extra?: Record<string, unknown> } = {},
) {
	const quePasa = opciones.quePasa ?? QUE_PASA[fallo.error] ?? "La central no lo ha hecho.";
	return c.json(
		{
			ok: false,
			error: fallo.error,
			message: [opciones.antes, quePasa, opciones.despues].filter(Boolean).join(" "),
			...(fallo.detalle ? { detalle: fallo.detalle } : {}),
			...opciones.extra,
		},
		estadoHttpDe(fallo.error) as 500,
	);
}

type CamposDelRastro = Parameters<typeof reportarAdministracionDeLaCentral>[1];

/** El rastro de lo que cambia algo: en el log y en Axiom. Sin datos personales ni texto que no sea nuestro. */
function rastro(c: Context<{ Bindings: Env }>, campos: CamposDelRastro): void {
	console.log(`[central] ${JSON.stringify(campos)}`);
	enSegundoPlano(c, reportarAdministracionDeLaCentral(c.env, campos));
}

/**
 * Una llamada al objeto que cambia algo, con su rastro de que empieza antes de hacerla. Si no vuelve
 * (el objeto se ha reiniciado a mitad, o la plataforma no la ha llevado), lo deja también en el rastro,
 * y el fallo sigue su camino.
 */
async function conRastro<T>(
	c: Context<{ Bindings: Env }>,
	campos: Omit<CamposDelRastro, "resultado">,
	llamada: () => Promise<T>,
): Promise<T> {
	rastro(c, { ...campos, resultado: "empieza" });
	try {
		return await llamada();
	} catch (error) {
		rastro(c, { ...campos, resultado: "sin_respuesta" });
		throw error;
	}
}

/** Los códigos con los que el cargador dice que una copia no sirve (`CopiaInservible`). */
const MOTIVOS_DE_UNA_COPIA: Record<CopiaInservible["codigo"], true> = {
	copia_no_encontrada: true,
	copia_de_otra_version: true,
	copia_cortada: true,
	copia_no_valida: true,
};

/**
 * Lo único del `detalle` de una restauración que va al rastro: el código con el que empieza, si es
 * uno de los de una copia que no sirve (`copia_cortada: …`). Lo de detrás no es nuestro.
 */
function motivoDe(detalle: string | undefined): string | undefined {
	const codigo = detalle?.split(":", 1)[0] ?? "";
	return Object.prototype.hasOwnProperty.call(MOTIVOS_DE_UNA_COPIA, codigo) ? codigo : undefined;
}

centralRoutes.get("/estado", async (c) => {
	return c.json({ ok: true, ...(await centralDe(c.env).estado()) });
});

/**
 * Las copias, y hasta cuántas filas se restauran de una vez (copias-4): con más, la restauración puede
 * pasar de 30 s, cortarse y dejar la central a medias. El CLI avisa antes de restaurar una así.
 */
centralRoutes.get("/copias", async (c) => {
	const { copias, hayMas } = await listarCopiasDeLaCentral(c.env.COPIAS, TECHO_COPIAS);
	return c.json({ ok: true, copias, hayMas, filasQueSeRestauranDeUnaVez: FILAS_QUE_SE_RESTAURAN_DE_UNA_VEZ });
});

centralRoutes.post("/copiar-ahora", async (c) => {
	const r = await centralDe(c.env).copiar(COPIA_A_MANO);
	if (!r.ok) {
		rastro(c, { accion: "copiar", resultado: r.error });
		return noHecho(c, r);
	}
	rastro(c, { accion: "copiar", resultado: "ok", clave: r.valor.clave, filas: r.valor.filas, tablas: r.valor.tablas });
	return c.json({ ok: true, ...r.valor });
});

const aprovisionarSchema = z.object({
	/** La copia desde la que se restaura (`base-central/<nombre>.sql.gz`, `NOMBRES_DE_UNA_COPIA`). Sin ella, el esquema vacío. */
	claveDeCopia: z
		.string()
		.overwrite(recortar)
		.refine(esClaveDeCopiaDeLaCentral, `Esa no es la clave de una copia de la central: sácala de pnpm central:copias. Va como ${NOMBRES_DE_UNA_COPIA}.`)
		.optional(),
});

centralRoutes.post("/aprovisionar", cuerpo(aprovisionarSchema), async (c) => {
	const { claveDeCopia } = c.req.valid("json");
	const accion = claveDeCopia === undefined ? "aprovisionar" : "restaurar";
	const r = await conRastro(c, { accion, clave: claveDeCopia }, async () =>
		centralDe(c.env).aprovisionar(claveDeCopia === undefined ? {} : { claveDeCopia }),
	);
	if (!r.ok) {
		rastro(c, { accion, resultado: r.error, clave: claveDeCopia, motivo: motivoDe(r.detalle) });
		return noHecho(c, r);
	}
	rastro(c, { accion, resultado: "ok", clave: claveDeCopia, filas: r.valor.copia?.filas, tablas: r.valor.copia?.tablas });
	return c.json({ ok: true, ...r.valor });
});

/** Un marcador en el cuerpo de `/volver`, con la forma de los de Cloudflare (`esMarcador`). */
const marcadorSchema = z
	.string()
	.overwrite(recortar)
	.min(1, "Falta el marcador.")
	.refine(esMarcador, "Ese no es un marcador: cópialo tal cual lo dio la vuelta (cifras y letras de la a a la f, en grupos separados por guiones).");

const volverSchema = z
	.object({
		/** El instante, en milisegundos desde 1970. El CLI lo saca de una fecha ISO. */
		instanteMs: z.number().int().positive().optional(),
		/** O un marcador: el `deshacer` de una vuelta anterior, para deshacerla. */
		marcador: marcadorSchema.optional(),
		/**
		 * O, en vez de volver, el `deshacer` de una vuelta preparada y sin aplicar: reinicia la central
		 * para aplicarla, sólo si sigue preparada. Si ya se ha aplicado, no hace nada.
		 */
		reiniciar: marcadorSchema.optional(),
	})
	.refine((b) => [b.instanteMs, b.marcador, b.reiniciar].filter((v) => v !== undefined).length === 1, {
		message: "Di a qué se vuelve (un instante o un marcador) o qué vuelta preparada se aplica (reiniciar): una sola cosa.",
	});

/**
 * Devuelve la central a un instante, o a un marcador (`durableObjects/baseCentral.instante.ts`), esté
 * como esté: deshacer una vuelta que la ha dejado sin atender, o volver a otro instante, es la salida.
 * Son dos llamadas al objeto, cada una con su stub (el reinicio deja inservible el anterior):
 *
 * 1. `prepararVuelta`: cierra la central, deja la copia de antes en R2 (si se puede copiar) y la
 *    vuelta preparada. Contesta el marcador con el que se deshace.
 * 2. `reiniciar(deshacer)`: `ctx.abort()`, sólo si la vuelta preparada es ésta. La llamada falla, y
 *    es lo esperado: al arrancar, vuelve.
 *
 * Con `reiniciar` en el cuerpo, sólo la segunda: aplica una vuelta que quedó preparada y sin aplicar
 * (`aplicarLaPreparada`).
 */
centralRoutes.post("/volver", cuerpo(volverSchema), async (c) => {
	const { instanteMs, marcador, reiniciar } = c.req.valid("json");
	if (reiniciar !== undefined) return aplicarLaPreparada(c, reiniciar);
	const destino = marcador !== undefined ? marcador : new Date(instanteMs!).toISOString();
	const prep = await conRastro(c, { accion: "volver", destino }, async () =>
		centralDe(c.env).prepararVuelta(marcador !== undefined ? { marcador } : { instanteMs: instanteMs! }),
	);
	if (!prep.ok) {
		rastro(c, { accion: "volver", resultado: prep.error, destino });
		return noHecho(c, prep);
	}
	const { deshacer, copiaDeAntes } = prep.valor;
	rastro(c, { accion: "volver", resultado: "preparada", destino, deshacer, copiaDeAntes: copiaDeAntes ?? undefined });
	return aplicar(c, destino, prep.valor);
});

/**
 * Aplica la vuelta preparada que se deshace con `deshacer`: la que no llegó a reiniciarse
 * (`central_vuelta_sin_aplicar`). Sólo si sigue preparada: si ya se ha aplicado (el objeto se ha
 * reiniciado desde entonces, por lo que sea) o no llegó a pedirse, no reinicia nada
 * (`central_sin_vuelta_preparada`), y con otra en curso, tampoco (`central_vuelta_a_la_vez`). Así,
 * repetirla no vuelve dos veces, que es lo que haría repetir la orden de la vuelta.
 */
async function aplicarLaPreparada(c: Context<{ Bindings: Env }>, deshacer: string) {
	const antes = await centralDe(c.env).estado();
	const vuelta = antes.enCurso.vuelta;
	if (!vuelta?.preparada || !esLaPreparada(antes, deshacer)) {
		const error = vuelta ? "central_vuelta_a_la_vez" : "central_sin_vuelta_preparada";
		rastro(c, { accion: "volver", resultado: error, deshacer });
		return noHecho(c, { ok: false, error }, {
			...(vuelta
				? {
						quePasa:
							"La vuelta en curso no es la de ese marcador, y la central no se ha reiniciado: mira cuál es con pnpm central:estado antes de repetir nada.",
					}
				: {}),
			extra: { estado: antes },
		});
	}
	const { copiaDeAntes } = vuelta.preparada;
	rastro(c, { accion: "volver", resultado: "reinicia", destino: vuelta.destino, deshacer, copiaDeAntes: copiaDeAntes ?? undefined });
	return aplicar(c, vuelta.destino, vuelta.preparada);
}

/**
 * La segunda mitad de la vuelta preparada `preparada`, a `destino`: reiniciar, esperar a que la central
 * conteste y decir cómo ha quedado.
 *
 * Si sigue con esta vuelta sin aplicar, se reinicia otra vez. Si la que hay en curso es otra, no se
 * toca: es de quien la está preparando, y reiniciar cortaría su preparación o aplicaría su vuelta
 * (`central_vuelta_a_la_vez`). Lo que se devuelve, también si algo no sale, es con qué se deshace y
 * dónde está la copia de antes; y ya está en el rastro, antes de reiniciar, por si esta llamada no
 * llega a terminar. Antes de eso, el objeto lo ha dejado en R2, por si no llega ni la respuesta de
 * `prepararVuelta`. Una central que ha vuelto pero no atiende (vuelve a un instante con algo a
 * medias, sin esquema, o una migración no entra) no se da por buena.
 *
 * Si el objeto contesta que no reinicia para ésta (C1), es lo que se dice, aunque después la central
 * conteste sana y sin marca: ya no la tenía preparada, y una central sana sin marca no dice qué vuelta
 * se ha aplicado, si ésta (se reinició por su cuenta) u otra preparada encima.
 */
async function aplicar(c: Context<{ Bindings: Env }>, destino: string, preparada: VueltaPreparada) {
	const env = c.env;
	const { deshacer, copiaDeAntes } = preparada;
	/** Con qué se sale de la vuelta, en toda respuesta: su marcador, su copia de antes y cuándo se cerró la central. */
	const conQueSeSale = { deshacer, copiaDeAntes, cerradaDesde: new Date(preparada.desdeMs).toISOString() };
	let estado: EstadoDeLaCentral | null = null;
	/** Lo que ha contestado el objeto si no ha reiniciado para ésta: ya no es la que tiene preparada. */
	let rechazo: FalloDeLaCentral | null = null;
	try {
		rechazo = await reiniciarLaPreparada(env, deshacer);
		estado = await cuandoConteste(env);
		if (!rechazo && esLaPreparada(estado, deshacer)) {
			rechazo = await reiniciarLaPreparada(env, deshacer);
			estado = await cuandoConteste(env);
		}
	} catch {
		// No contesta: no se sabe si ha vuelto. Se dice, con lo necesario para deshacerlo.
	}
	const sinAplicar = !rechazo && estado !== null && esLaPreparada(estado, deshacer);
	// Otra vuelta en curso: ha empezado después de preparar ésta, y es de quien la prepara.
	const otra = !sinAplicar && Boolean(estado?.enCurso.vuelta);
	// Sin esquema no es una avería del objeto, pero tampoco atiende.
	const noAtiende: FalloDeLaCentral | null =
		estado?.averia ?? (estado && !estado.aprovisionada ? { ok: false, error: "central_sin_aprovisionar" } : null);
	const resultado = rechazo
		? rechazo.error
		: !estado
			? "central_vuelta_sin_comprobar"
			: sinAplicar
				? "central_vuelta_sin_aplicar"
				: otra
					? "central_vuelta_a_la_vez"
					: (noAtiende?.error ?? "ok");
	rastro(c, { accion: "volver", resultado, destino, deshacer, copiaDeAntes: copiaDeAntes ?? undefined });

	if (rechazo) {
		return noHecho(c, rechazo, {
			quePasa: rechazo.error === "central_vuelta_a_la_vez" ? OTRA_AL_REINICIAR : NINGUNA_AL_REINICIAR,
			extra: { ...conQueSeSale, estado },
		});
	}
	if (!estado) {
		return c.json(
			{
				ok: false,
				error: "central_vuelta_sin_comprobar",
				message: QUE_PASA.central_vuelta_sin_comprobar,
				...conQueSeSale,
			},
			503,
		);
	}
	if (sinAplicar) {
		return c.json(
			{
				ok: false,
				error: "central_vuelta_sin_aplicar",
				message: QUE_PASA.central_vuelta_sin_aplicar,
				...conQueSeSale,
			},
			503,
		);
	}
	if (otra) {
		return noHecho(c, { ok: false, error: "central_vuelta_a_la_vez" }, {
			quePasa:
				"Otra vuelta a un instante ha empezado después de preparar ésta, y es la que sigue: la central no se ha reiniciado, para no cortarla. Mira cómo va con pnpm central:estado antes de repetir nada.",
			extra: { ...conQueSeSale, estado },
		});
	}
	if (noAtiende) {
		// Sin esquema, lo de siempre («dale esquema») la pondría a atender sin licencias.
		const sinEsquema = noAtiende.error === "central_sin_aprovisionar";
		return noHecho(c, noAtiende, {
			antes: "La central ha vuelto, pero no atiende.",
			...(sinEsquema ? { quePasa: SIN_ESQUEMA_TRAS_VOLVER } : {}),
			despues: sinEsquema
				? `Se sale ${SALIDAS_DE_LA_VUELTA} O restaurándola desde una copia (pnpm central:aprovisionar -- --copia <clave> --si). ${SI_SE_PIERDE_EL_MARCADOR}`
				: `Se sale también ${SALIDAS_DE_LA_VUELTA} ${SI_SE_PIERDE_EL_MARCADOR}`,
			extra: { ...conQueSeSale, estado },
		});
	}
	return c.json({ ok: true, destino: preparada.marcador, ...conQueSeSale, estado });
}

/** ¿Es la vuelta en curso la preparada que se deshace con `deshacer`? */
function esLaPreparada(estado: EstadoDeLaCentral, deshacer: string): boolean {
	const vuelta = estado.enCurso.vuelta;
	return vuelta?.fase === "preparada" && vuelta.preparada?.deshacer === deshacer;
}

/**
 * Reinicia la central para aplicar la vuelta preparada que se deshace con `deshacer`. El objeto sólo
 * se reinicia si esa vuelta sigue preparada (`BaseCentral.reiniciar`): si no, contesta por qué
 * (`central_vuelta_a_la_vez`, `central_sin_vuelta_preparada`), y es lo que se devuelve. Si se
 * reinicia, la llamada falla, y es lo esperado: `null`.
 */
async function reiniciarLaPreparada(env: Env, deshacer: string): Promise<FalloDeLaCentral | null> {
	try {
		const r = await centralDe(env).reiniciar(deshacer);
		return r.ok ? null : r;
	} catch {
		// `ctx.abort()` corta la llamada que lo pide: es lo que tiene que pasar.
		return null;
	}
}

/** Espera a que la central vuelva a contestar tras reiniciarla: cómo está. Lanza si no contesta. */
async function cuandoConteste(env: Env): Promise<EstadoDeLaCentral> {
	for (let intento = 1; ; intento++) {
		try {
			return await centralDe(env).estado();
		} catch (error) {
			if (intento >= INTENTOS_TRAS_REINICIAR) throw error;
			await new Promise((r) => setTimeout(r, PAUSA_TRAS_REINICIAR_MS));
		}
	}
}
