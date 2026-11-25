// src/domains/admin/central.ts
//
// La base central desde la administración: cómo está, sus copias, copiarla ahora, darle esquema o
// restaurarla desde una copia, y devolverla a un instante. Va montado en `admin.routes.ts`, detrás de
// `requireAdmin` (`ADMIN_API_TOKEN`), que no lee la central: todo esto funciona también con ella sin
// aprovisionar. El CLI lo llama con `pnpm central:*` (`scripts/tpv-license.mjs`).
//
//   GET  /v1/admin/central/estado        → si está aprovisionada, sus migraciones, si tiene avería o
//                                          algo a medias, sus filas por tabla y lo que ocupa
//   GET  /v1/admin/central/copias        → sus copias en R2, de la más reciente a la más vieja
//   POST /v1/admin/central/copiar-ahora  → una copia ahora, con la hora en la clave: no pisa la del día
//   POST /v1/admin/central/aprovisionar  → a un objeto sin aprovisionar, el esquema vacío o, con
//                                          `claveDeCopia`, la base de esa copia
//   POST /v1/admin/central/volver        → a un instante de los últimos 30 días, o a un marcador
//
// Lo que cambia algo deja rastro en Axiom y en el log (`rastro`), no en `admin_audit`: es una tabla
// de la propia central, y restaurarla o devolverla a un instante la reescriben. El rastro sólo lleva
// lo nuestro: códigos, claves y marcadores que han pasado su gramática (`esClaveDeCopiaDeLaCentral`,
// `esMarcador`), recuentos. El `detalle` del objeto (lo que dice SQLite o R2, o lo que trae una copia)
// va en la respuesta, a quien administra, y nunca al rastro.

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
} from "../../durableObjects/baseCentral.copia";
import type { CodigoDeLaCentral, EstadoDeLaCentral, FalloDeLaCentral } from "../../durableObjects/baseCentral.rpc";
import type { CopiaInservible } from "../../durableObjects/cargaDeCopias";
import { esMarcador } from "../../durableObjects/instantes";

export const centralRoutes = new Hono<{ Bindings: Env }>();

/** Cuántas copias devuelve la lista, como mucho (el techo va en la respuesta). */
const TECHO_COPIAS = 100;

/** Tras reiniciarla, cuántas veces se le pregunta a la central cómo está, y cada cuánto. */
const INTENTOS_TRAS_REINICIAR = 10;
const PAUSA_TRAS_REINICIAR_MS = 500;

/** Lo que se le dice a quien administra cuando la central no ha hecho lo que se le pedía. */
const QUE_PASA: Partial<Record<CodigoDeLaCentral, string>> = {
	central_sin_aprovisionar: "La central no está aprovisionada: dale esquema o restáurala con pnpm central:aprovisionar.",
	central_ya_aprovisionada: "La central ya está aprovisionada, y no se ha tocado: sólo se aprovisiona un objeto vacío.",
	central_restauracion_a_medias:
		"Hay una restauración a medias y la central no atiende: vuelve a restaurar desde una copia (pnpm central:aprovisionar -- --copia <clave> --si).",
	central_copia_inservible: "Esa copia no se puede restaurar: la central se queda sin aprovisionar, como estaba.",
	central_vuelta_en_curso:
		"Hay una vuelta a un instante preparada y sin aplicar: la central no atiende hasta reiniciarse. Se reinicia repitiendo la misma orden de pnpm central:volver.",
	central_vuelta_a_la_vez:
		"Otra vuelta a un instante se estaba preparando a la vez, y sólo sigue una: mira cuál con pnpm central:estado antes de repetir nada.",
	central_instante_fuera_de_plazo: "Sólo se puede volver a un instante pasado de los últimos 30 días.",
	central_vuelta_no_disponible: "Este despliegue no puede devolver un objeto a un instante (en local no existe).",
	central_copia_fallida: "La copia no ha llegado a R2.",
	central_migracion_alterada: "Una migración ya aplicada ha cambiado: la central no atiende.",
	central_migracion_fallida: "Una migración no ha podido aplicarse: la central no atiende.",
};

/**
 * La respuesta de lo que la central contesta que no ha hecho: su código, qué pasa (`message`, con lo
 * que haya pasado `antes`) y, si el objeto lo dice, por qué (`detalle`, el motivo técnico, que el CLI
 * enseña aparte). `extra` va tal cual.
 */
function noHecho(
	c: Context<{ Bindings: Env }>,
	fallo: FalloDeLaCentral,
	opciones: { antes?: string; extra?: Record<string, unknown> } = {},
) {
	const quePasa = QUE_PASA[fallo.error] ?? "La central no lo ha hecho.";
	return c.json(
		{
			ok: false,
			error: fallo.error,
			message: opciones.antes ? `${opciones.antes} ${quePasa}` : quePasa,
			...(fallo.detalle ? { detalle: fallo.detalle } : {}),
			...opciones.extra,
		},
		estadoHttpDe(fallo.error) as 500,
	);
}

/** El rastro de lo que cambia algo: en el log y en Axiom. Sin datos personales ni texto que no sea nuestro. */
function rastro(c: Context<{ Bindings: Env }>, campos: Parameters<typeof reportarAdministracionDeLaCentral>[1]): void {
	console.log(`[central] ${JSON.stringify(campos)}`);
	enSegundoPlano(c, reportarAdministracionDeLaCentral(c.env, campos));
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

centralRoutes.get("/copias", async (c) => {
	const { copias, hayMas } = await listarCopiasDeLaCentral(c.env.COPIAS, TECHO_COPIAS);
	return c.json({ ok: true, copias, hayMas });
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
	/** La copia desde la que se restaura (`base-central/<nombre>.sql.gz`). Sin ella, el esquema vacío. */
	claveDeCopia: z
		.string()
		.overwrite(recortar)
		.refine(esClaveDeCopiaDeLaCentral, "La copia va como base-central/<nombre>.sql.gz: sácala de pnpm central:copias.")
		.optional(),
});

centralRoutes.post("/aprovisionar", cuerpo(aprovisionarSchema), async (c) => {
	const { claveDeCopia } = c.req.valid("json");
	const accion = claveDeCopia === undefined ? "aprovisionar" : "restaurar";
	const r = await centralDe(c.env).aprovisionar(claveDeCopia === undefined ? {} : { claveDeCopia });
	if (!r.ok) {
		rastro(c, { accion, resultado: r.error, clave: claveDeCopia, motivo: motivoDe(r.detalle) });
		return noHecho(c, r);
	}
	rastro(c, { accion, resultado: "ok", clave: claveDeCopia, filas: r.valor.copia?.filas, tablas: r.valor.copia?.tablas });
	return c.json({ ok: true, ...r.valor });
});

const volverSchema = z
	.object({
		/** El instante, en milisegundos desde 1970. El CLI lo saca de una fecha ISO. */
		instanteMs: z.number().int().positive().optional(),
		/** O un marcador: el `deshacer` de una vuelta anterior, para deshacerla. Con la forma de los de Cloudflare. */
		marcador: z
			.string()
			.overwrite(recortar)
			.min(1, "Falta el marcador.")
			.refine(esMarcador, "Ese no es un marcador: cópialo tal cual lo dio la vuelta (cifras y letras de la a a la f, en grupos separados por guiones).")
			.optional(),
	})
	.refine((b) => (b.instanteMs === undefined) !== (b.marcador === undefined), {
		message: "Di a qué se vuelve: un instante o un marcador, uno de los dos.",
	});

/**
 * Devuelve la central a un instante, o a un marcador (`durableObjects/baseCentral.instante.ts`). Son
 * dos llamadas al objeto, cada una con su stub (el reinicio deja inservible el anterior):
 *
 * 1. `prepararVuelta`: cierra la central, deja la copia de antes en R2 y la vuelta preparada.
 *    Contesta el marcador con el que se deshace.
 * 2. `reiniciar`: `ctx.abort()`. La llamada falla siempre, y es lo esperado: al arrancar, vuelve.
 *
 * Después se espera a que conteste: si sigue con la vuelta sin aplicar, se reinicia otra vez. Lo que
 * se devuelve, también si algo no sale, es con qué se deshace y dónde está la copia de antes; y queda
 * en el rastro en cuanto la vuelta está preparada, antes de reiniciar, por si esta llamada no llega a
 * terminar. Una central que ha vuelto pero no atiende (vuelve a un instante con algo a medias, o una
 * migración no entra) no se da por buena.
 */
centralRoutes.post("/volver", cuerpo(volverSchema), async (c) => {
	const env = c.env;
	const { instanteMs, marcador } = c.req.valid("json");
	const destino = marcador !== undefined ? marcador : new Date(instanteMs!).toISOString();
	const prep = await centralDe(env).prepararVuelta(marcador !== undefined ? { marcador } : { instanteMs: instanteMs! });
	if (!prep.ok) {
		rastro(c, { accion: "volver", resultado: prep.error, destino });
		return noHecho(c, prep);
	}
	const { deshacer, copiaDeAntes } = prep.valor;
	rastro(c, { accion: "volver", resultado: "preparada", destino, deshacer, copiaDeAntes });

	let estado: EstadoDeLaCentral | null = null;
	try {
		estado = await reiniciarYEsperar(env);
		if (estado.enCurso.vuelta) estado = await reiniciarYEsperar(env);
	} catch {
		// No contesta: no se sabe si ha vuelto. Se dice, con lo necesario para deshacerlo.
	}
	const aplicada = estado !== null && !estado.enCurso.vuelta;
	const resultado = !estado
		? "central_vuelta_sin_comprobar"
		: !aplicada
			? "central_vuelta_sin_aplicar"
			: (estado.averia?.error ?? "ok");
	rastro(c, { accion: "volver", resultado, destino, deshacer, copiaDeAntes });

	if (!estado) {
		return c.json(
			{
				ok: false,
				error: "central_vuelta_sin_comprobar",
				message:
					"La vuelta está preparada y la central se ha reiniciado, pero no contesta todavía: mira cómo está con pnpm central:estado.",
				deshacer,
				copiaDeAntes,
			},
			503,
		);
	}
	if (!aplicada) {
		return c.json(
			{
				ok: false,
				error: "central_vuelta_sin_aplicar",
				message: "La vuelta está preparada pero la central no se ha reiniciado, y sigue cerrada. Repite la misma orden.",
				deshacer,
				copiaDeAntes,
			},
			503,
		);
	}
	if (estado.averia) {
		return noHecho(c, estado.averia, {
			antes: "La central ha vuelto, pero no atiende.",
			extra: { deshacer, copiaDeAntes, estado },
		});
	}
	return c.json({ ok: true, destino: prep.valor.marcador, deshacer, copiaDeAntes, estado });
});

/** Reinicia la central y espera a que vuelva a contestar: cómo está después. Lanza si no contesta. */
async function reiniciarYEsperar(env: Env): Promise<EstadoDeLaCentral> {
	try {
		await centralDe(env).reiniciar();
	} catch {
		// `ctx.abort()` corta la llamada que lo pide: es lo que tiene que pasar.
	}
	for (let intento = 1; ; intento++) {
		try {
			return await centralDe(env).estado();
		} catch (error) {
			if (intento >= INTENTOS_TRAS_REINICIAR) throw error;
			await new Promise((r) => setTimeout(r, PAUSA_TRAS_REINICIAR_MS));
		}
	}
}
