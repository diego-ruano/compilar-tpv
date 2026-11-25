// src/domains/admin/basesDeNegocios.ts
//
// DO-03 · La base de un negocio, desde la administración: cómo está, sus copias y devolverla a un
// instante. Va montado en `admin.routes.ts`, detrás de `requireAdmin` (`ADMIN_API_TOKEN`), y el CLI
// lo llama con `pnpm negocio:*` (`scripts/tpv-license.mjs`). El procedimiento entero, con lo que
// hay que hacer después en la Main, está en docs/guias/restaurar-un-negocio.md.
//
//   POST /v1/admin/negocios/estado    → si nació, si tiene base, su próxima copia y sus copias en R2
//   POST /v1/admin/negocios/copiar    → la copia de hoy, ahora
//   POST /v1/admin/negocios/instante  → devuelve su TenantHub a un instante (o a un marcador)
//   POST /v1/admin/negocios/restaurar-copia → DO-PERDIDA: a un objeto vacío, la base de una copia de R2
//   POST /v1/admin/negocios/base-vacia      → DO-PERDIDA: a un objeto vacío, una base nueva y vacía
//   POST /v1/admin/negocios/subida/reabrir  → DO-SUBIDA: reabre la subida completa de la Main si se
//                                             agotó su presupuesto, caducó o se quedó huérfana
//
// Las dos de DO-PERDIDA son la salida de un negocio que ya nació y cuya base no está en su objeto
// (`lib/basePerdida.ts`): la activación y `/v1/sync/initialize-empty` se niegan a crearla, a
// propósito, y esto es hacerlo a sabiendas. Sólo con un negocio nacido y un objeto vacío.
//
// Las tres que abren el log de la réplica (la vuelta a un instante y las dos de DO-PERDIDA) le dicen
// al objeto hasta dónde numeraron los logs de antes, que un objeto vacío no recuerda (`seqConocido`):
// el `inicio` que cada una apunta en `admin_audit` y el `seq` de las copias de R2. Ese `inicio` se
// apunta antes de llamar al objeto (`reservarLog`), no al acabar: un log abierto sin su rastro haría
// que la siguiente base devuelta se abriera otra vez en el mismo número.
//
// Todo va por POST con el negocio en el cuerpo, como el resto de la administración que lleva datos.
// Lo que cambia algo deja rastro en `admin_audit` (con el motivo) y en Axiom (sin él: es texto
// libre). Una copia que el objeto no restaura no cambia nada, y deja rastro sólo en Axiom: el código
// y, si la copia no vale, por qué (`detalle`).

import { Hono } from "hono";
import * as z from "zod";

import type { Env } from "../../env";
import { hubDe } from "../../lib/hub";
import { negocioNacido } from "../../lib/basePerdida";
import { recortar } from "../../lib/texto";
import { cuerpo } from "../../lib/validacion";
import { ingestToAxiom } from "../../observability/axiom";
import { auditAdmin } from "../../server/licenseStore";
import { getDb } from "../../server/db";
import { claveDeCopia, listarCopias, seqDeLasCopias } from "../../durableObjects/tenantHub.copia";
import { zDia } from "../../lib/fechas";
import { esInstanteDeLaVentana } from "../../durableObjects/instantes";
import { SALTO_DE_SEQ, type ModoDeVuelta } from "../../durableObjects/tenantHub.instante";
import type { VueltaAplicada, VueltaPreparada } from "../../durableObjects/tenantHub.rpc";

export const basesDeNegociosRoutes = new Hono<{ Bindings: Env }>();

const zNegocio = z
	.string()
	.overwrite(recortar)
	.min(1, "Falta el negocio.")
	.max(100, "Ese no es el id de un negocio.")
	.refine((t) => !t.includes("/"), "Ese no es el id de un negocio.");

const zMotivo = z.string().overwrite(recortar).min(3, "Escribe el motivo.").max(300, "El motivo es demasiado largo.");

const zModo = z.enum(["nube", "main"], { message: "Elige quién manda después: «nube» o «main»." });

const negocioSchema = z.object({ tenantId: zNegocio });

/** Un evento de administración en Axiom. Sin el motivo, que es texto libre. Nunca lanza. */
async function rastro(env: Env, evento: string, campos: Record<string, unknown>): Promise<void> {
	const dataset = env.AXIOM_DATASET_SYNC || env.AXIOM_DATASET;
	if (!dataset) return;
	await ingestToAxiom(env, dataset, [{ _time: new Date().toISOString(), service: "tpv-api", event: evento, ...campos }]);
}

/**
 * Lo que apunta en `admin_audit` el `inicio` de un log: la reserva de antes de abrirlo
 * (`reservarLog`) y el rastro de cada orden que lo ha abierto.
 */
const AL_ABRIR_UN_LOG = [
	"negocio_log_reservado",
	"negocio_volver_a_instante",
	"negocio_restaurar_copia",
	"negocio_base_vacia",
] as const;

/**
 * DO-PERDIDA · Hasta dónde ha numerado nunca el log de este negocio, según lo que sobrevive a perder
 * su objeto: el `inicio` más alto de los logs que se le han abierto desde aquí (cada uno lo deja en
 * `admin_audit`) y el `seq` de sus copias de R2 (`seqDeLasCopias`). Lo que un log numeró después de
 * eso lo cubre `SALTO_DE_SEQ`, que va encima (`abrirLogTrasVolver`).
 *
 * Sin esto, un objeto vacío abriría el log en `SALTO_DE_SEQ` justo: bien la primera vez que se
 * pierde, pero tras otra pérdida o una vuelta a un instante el log perdido ya numeraba por encima
 * del salto, y la Main, con el checkpoint por encima del log nuevo, no bajaría lo que éste numerase
 * por debajo (con `nube`, ni vería que tiene que traerse la nube). Lanza si la base central o R2 no
 * contestan: sin saberlo no se abre ningún log.
 *
 * Una reserva cuya orden no llegó a abrir el log (el objeto ya tenía base, la copia no valía) también
 * cuenta: la siguiente se abre un salto más arriba, que no estorba. Lo que no puede pasar es lo
 * contrario, un log abierto que no conste.
 */
async function seqConocido(env: Env, tenantId: string): Promise<number> {
	const [auditado, deLasCopias] = await Promise.all([
		getDb(env).execute({
			sql: `SELECT MAX(CAST(json_extract(detail, '$.inicio') AS INTEGER)) AS seq FROM admin_audit
			      WHERE action IN (SELECT value FROM json_each(?1)) AND json_extract(detail, '$.tenantId') = ?2;`,
			args: [JSON.stringify(AL_ABRIR_UN_LOG), tenantId],
		}),
		seqDeLasCopias(env.COPIAS_NEGOCIOS, tenantId),
	]);
	return Math.max(Number((auditado.rows[0] as { seq?: unknown } | undefined)?.seq ?? 0) || 0, deLasCopias);
}

/**
 * DO-PERDIDA · Apunta en `admin_audit`, antes de llamar al objeto, el `inicio` con el que se va a abrir
 * el log (`seqAntes` + `SALTO_DE_SEQ`, como `abrirLogTrasVolver`), para `seqConocido`. El rastro de la
 * orden va después de que el objeto conteste, y puede no llegar: la base central falla en ese momento,
 * o se pierde la respuesta del objeto con el log ya abierto, y repetir la orden no lo arregla (el
 * objeto ya tiene base). Sin la reserva, la siguiente base devuelta antes de la copia de la noche
 * leería el `seqConocido` de antes y abriría su log en el mismo número que éste, por debajo del
 * checkpoint de la Main. Lanza si la base central no contesta: sin apuntarlo no se abre ningún log.
 *
 * Con un objeto vacío el `inicio` es exacto: tras `llenar` no queda nada numerado. Tras volver a un
 * instante, lo vuelto es de antes de lo que se leyó al prepararlo (`seqAntes`).
 */
async function reservarLog(
	env: Env,
	{ tenantId, operacion, seqAntes }: { tenantId: string; operacion: "instante" | "base_vacia" | "copia"; seqAntes: number },
): Promise<void> {
	await auditAdmin(getDb(env), "negocio_log_reservado", null, {
		tenantId,
		operacion,
		seqAntes,
		inicio: seqAntes + SALTO_DE_SEQ,
	});
}

basesDeNegociosRoutes.post("/estado", cuerpo(negocioSchema), async (c) => {
	const { tenantId } = c.req.valid("json");
	const [nacido, base, copias] = await Promise.all([
		negocioNacido(getDb(c.env), tenantId),
		hubDe(c.env, tenantId).estadoDeLaBase(tenantId),
		listarCopias(c.env.COPIAS_NEGOCIOS, tenantId),
	]);
	if (!base.ok) return c.json({ ok: false, error: base.error }, base.status as 500);
	const { ok: _ok, ...estado } = base;
	return c.json({ ok: true, tenantId, nacido, ...estado, copias });
});

basesDeNegociosRoutes.post("/copiar", cuerpo(negocioSchema), async (c) => {
	const { tenantId } = c.req.valid("json");
	const r = await hubDe(c.env, tenantId).copiarAhora(tenantId);
	if (!r.ok) return c.json({ ok: false, error: r.error }, r.status as 404);
	await auditAdmin(getDb(c.env), "negocio_copiar", null, { tenantId, clave: r.clave, filas: r.filas, bytes: r.bytes });
	return c.json({ ...r, tenantId });
});

const instanteSchema = z
	.object({
		tenantId: zNegocio,
		/** El instante, en milisegundos desde 1970. El CLI lo saca de una fecha ISO. */
		instanteMs: z.number().int().positive().optional(),
		/** O un marcador de una vuelta anterior: el `deshacer` que devolvió, para deshacerla. */
		marcador: z.string().min(1).max(200).optional(),
		modo: zModo,
		motivo: zMotivo,
	})
	.refine((b) => (b.instanteMs === undefined) !== (b.marcador === undefined), {
		message: "Di a qué se vuelve: un instante o un marcador, uno de los dos.",
	});

/**
 * Lo que tiene que pasar después en los equipos, según quién manda (`tenantHub.instante.ts`). Va en
 * la respuesta para quien lo lanza desde el CLI.
 */
function queHacerDespues(modo: ModoDeVuelta, deshacer: string, tenantId: string): string[] {
	const pasos =
		modo === "nube"
			? [
					"La nube es ahora la del instante. Cada Main del negocio verá al conectar que su base es anterior a la nube y sólo ofrecerá «Recuperar el estado actual de la nube»: lo que hizo después del instante se queda en su equipo, en backups/antes-de-la-nube-*.",
					"Lo cobrado después del instante no vuelve a la nube: si hace falta, sale de esa copia apartada.",
				]
			: [
					"La Main sigue con su base, se pone al día por encima de la vuelta y sube lo que tenga pendiente.",
					"Después sube su base entera (DO-SUBIDA): lo que la nube ha perdido desde el instante vuelve a ella, empezando por lo imprescindible para las Handy. Mira cómo va con pnpm negocio:estado (subida).",
				];
	return [
		...pasos,
		"Las Handy y la Main se han desconectado y reconectan solas.",
		`Para deshacerlo: pnpm negocio:instante -- --tenant ${tenantId} --marcador ${deshacer} --modo ${modo} --motivo "…"`,
	];
}

/**
 * Devuelve el TenantHub de un negocio a un instante de los últimos 30 días, o a un marcador.
 *
 * Son tres llamadas al objeto, cada una con un stub nuevo (el reinicio deja inservible el anterior):
 *
 * 1. `prepararVuelta`: deja la vuelta preparada, lee lo que la nube había numerado, cierra la base
 *    y echa a las sesiones. Contesta el marcador con el que se deshace.
 * 2. `reiniciar`: `ctx.abort()`. La llamada falla siempre, y es lo esperado: el objeto se ha
 *    reiniciado y al arrancar vuelve.
 * 3. `trasVolver`: ya en el objeto vuelto, abre el log por encima de lo numerado y, con `nube`,
 *    obliga a las Main a traerse la nube. Si el objeto todavía no ha vuelto, se reinicia otra vez y
 *    se repite una vez.
 */
basesDeNegociosRoutes.post("/instante", cuerpo(instanteSchema), async (c) => {
	const env = c.env;
	const { tenantId, instanteMs, marcador, modo, motivo } = c.req.valid("json");
	if (instanteMs !== undefined && !esInstanteDeLaVentana(instanteMs, Date.now())) {
		return c.json(
			{
				ok: false,
				error: "instante_fuera_de_plazo",
				message: "Sólo se puede volver a un instante de los últimos 30 días.",
			},
			400,
		);
	}

	// DO-PERDIDA: lo que la base actual numeró lo lee `prepararVuelta`; esto es lo de las anteriores, si
	// la Main todavía tiene el checkpoint de una (no ha conectado desde que se perdió). Antes de tocar
	// nada: sin saberlo, no se vuelve.
	const conocido = await seqConocido(env, tenantId);
	const hub = () => hubDe(env, tenantId);
	const prep = await hub().prepararVuelta({ tenantId, instanteMs, marcador });
	if (!prep.ok) {
		const message =
			prep.error === "vuelta_no_disponible"
				? "Este despliegue no puede devolver un objeto a un instante (en local no existe)."
				: undefined;
		return c.json({ ok: false, error: prep.error, ...(message ? { message } : {}) }, prep.status as 500);
	}

	const seqAntes = Math.max(prep.seqAntes, conocido);
	try {
		await reservarLog(env, { tenantId, operacion: "instante", seqAntes });
	} catch {
		return c.json(
			{
				ok: false,
				error: "log_sin_reservar",
				message:
					"La vuelta está preparada, pero la base central no ha contestado y sin ella no se abre el log: la base sigue cerrada. Repite la misma orden.",
				deshacer: prep.deshacer,
			},
			503,
		);
	}
	let tras = await reiniciarYAbrir(hub, { tenantId, seqAntes, modo });
	if (!tras.ok && tras.error === "vuelta_sin_aplicar") {
		tras = await reiniciarYAbrir(hub, { tenantId, seqAntes, modo });
	}

	const resultado = {
		tenantId,
		modo,
		instanteMs: instanteMs ?? null,
		seqConocido: conocido,
		...soloLoPreparado(prep),
		...(tras.ok ? soloLoAplicado(tras) : { error: tras.error }),
	};
	await auditAdmin(getDb(env), "negocio_volver_a_instante", null, { ...resultado, motivo });
	await rastro(env, "nube_devuelta", { tenant_id: tenantId, ...resultado });

	if (!tras.ok) {
		return c.json(
			{
				ok: false,
				error: tras.error,
				message:
					"La vuelta está preparada pero el objeto no ha vuelto todavía, y su base sigue cerrada. Repite la misma orden: se aplica en el siguiente reinicio.",
				deshacer: prep.deshacer,
			},
			tras.status as 503,
		);
	}
	return c.json({ ok: true, ...resultado, queHacer: queHacerDespues(modo, prep.deshacer, tenantId) });
});

async function reiniciarYAbrir(
	hub: () => ReturnType<typeof hubDe>,
	params: { tenantId: string; seqAntes: number; modo: ModoDeVuelta },
) {
	try {
		await hub().reiniciar();
	} catch {
		// `ctx.abort()` corta la llamada que lo pide: es lo que tiene que pasar.
	}
	return hub().trasVolver(params);
}

function soloLoPreparado(p: VueltaPreparada) {
	return {
		destino: p.destino,
		actual: p.actual,
		deshacer: p.deshacer,
		seqAntes: p.seqAntes,
		aprovisionadoAntes: p.aprovisionadoAntes,
	};
}

function soloLoAplicado(t: VueltaAplicada) {
	return { aprovisionado: t.aprovisionado, inicio: t.inicio, purgadoHasta: t.purgadoHasta };
}

// ---- DO-PERDIDA · Darle base a un objeto vacío -------------------------------------------------

const baseSchema = z.object({ tenantId: zNegocio, modo: zModo, motivo: zMotivo });

const restaurarSchema = z.object({
	tenantId: zNegocio,
	/** El día de la copia (`AAAA-MM-DD`). Sin él, la más reciente. */
	dia: zDia("El día de la copia va como AAAA-MM-DD.").optional(),
	modo: zModo,
	motivo: zMotivo,
});

/** Un negocio que no ha nacido no tiene base que haya perdido: la crea la activación de su licencia. */
function sinNacer(tenantId: string) {
	return {
		ok: false as const,
		error: "negocio_sin_nacer",
		message: `El negocio ${tenantId} no ha activado nunca una licencia: su base la crea la activación, no esto.`,
	};
}

/** Lo que tiene que pasar después en los equipos, según quién manda. */
function queHacerTrasDarBase(modo: ModoDeVuelta): string[] {
	return [
		...(modo === "nube"
			? [
					"Manda la nube. Cada Main del negocio verá al conectar que su base es anterior a la nube y sólo ofrecerá «Recuperar el estado actual de la nube»: lo suyo se queda en su equipo, en backups/antes-de-la-nube-*.",
				]
			: [
					"Manda la Main: sigue con su base, se pone al día por encima del log nuevo y sube lo que tenga pendiente. Después sube su base entera (DO-SUBIDA): primero lo imprescindible para que trabajen las Handy, luego los últimos 30 días y al final el histórico. Mira cómo va con pnpm negocio:estado (subida).",
				]),
		"Las Handy y la Main reconectan solas.",
	];
}

/**
 * La base de una copia diaria de R2, a un objeto vacío (`MotorTenantHub.restaurarDesdeCopia`). Sin
 * `dia`, la más reciente. Si la copia no vale, el objeto se queda vacío y se dice por qué: el código y
 * lo que dice el cargador (`detalle`: la línea, el carácter y un código, que el gzip no se deja leer,
 * o en qué líneas están unas filas que SQLite no acepta; nada de la copia), que el CLI enseña como
 * motivo. Lo que el objeto no hace queda también en Axiom (`copia_no_restaurada`).
 */
basesDeNegociosRoutes.post("/restaurar-copia", cuerpo(restaurarSchema), async (c) => {
	const env = c.env;
	const { tenantId, dia, modo, motivo } = c.req.valid("json");
	if (!(await negocioNacido(getDb(env), tenantId))) return c.json(sinNacer(tenantId), 409);

	const clave = dia ? claveDeCopia(tenantId, dia) : (await listarCopias(env.COPIAS_NEGOCIOS, tenantId))[0]?.clave;
	if (!clave) {
		return c.json({ ok: false, error: "copia_no_encontrada", message: "Este negocio no tiene ninguna copia." }, 404);
	}
	const conocido = await seqConocido(env, tenantId);
	await reservarLog(env, { tenantId, operacion: "copia", seqAntes: conocido });
	const r = await hubDe(env, tenantId).restaurarDesdeCopia({ tenantId, clave, modo, seqConocido: conocido });
	if (!r.ok) {
		const porQue = { error: r.error, ...(r.detalle ? { detalle: r.detalle } : {}) };
		await rastro(env, "copia_no_restaurada", { tenantId, modo, clave, ...porQue });
		return c.json({ ok: false, clave, ...porQue }, r.status as 409);
	}

	const resultado = {
		tenantId,
		modo,
		clave: r.clave,
		filas: r.filas,
		tablas: r.tablas,
		seqConocido: conocido,
		inicio: r.inicio,
		purgadoHasta: r.purgadoHasta,
	};
	await auditAdmin(getDb(env), "negocio_restaurar_copia", null, { ...resultado, motivo });
	await rastro(env, "base_restaurada_de_copia", resultado);
	return c.json({ ok: true, ...resultado, queHacer: queHacerTrasDarBase(modo) });
});

const reabrirSchema = z.object({ tenantId: zNegocio, motivo: zMotivo });

/**
 * DO-SUBIDA · Reabre la subida completa de la Main (`MotorTenantHub.reabrirSubida`): una agotada (su
 * techo total, que la Main no puede volver a abrir sola), una caducada (la Main no empezó en 14 días)
 * o una huérfana (un traslado a mitad). Vuelve a esperar sin dueño: la primera Main vigente que salude
 * se la queda (a la que ya está conectada el objeto la echa para que vuelva a saludar). Deja rastro
 * con el motivo.
 */
basesDeNegociosRoutes.post("/subida/reabrir", cuerpo(reabrirSchema), async (c) => {
	const env = c.env;
	const { tenantId, motivo } = c.req.valid("json");
	const r = await hubDe(env, tenantId).reabrirSubida(tenantId);
	if (!r.ok) return c.json({ ok: false, error: r.error }, r.status as 409);
	await auditAdmin(getDb(env), "negocio_subida_reabierta", null, { tenantId, antes: r.antes, motivo });
	await rastro(env, "subida_reabierta", { tenantId, antes: r.antes });
	return c.json({ ok: true, tenantId, antes: r.antes });
});

/** Una base nueva y vacía, a un objeto vacío de un negocio nacido (`MotorTenantHub.crearBaseVacia`). */
basesDeNegociosRoutes.post("/base-vacia", cuerpo(baseSchema), async (c) => {
	const env = c.env;
	const { tenantId, modo, motivo } = c.req.valid("json");
	if (!(await negocioNacido(getDb(env), tenantId))) return c.json(sinNacer(tenantId), 409);

	const conocido = await seqConocido(env, tenantId);
	await reservarLog(env, { tenantId, operacion: "base_vacia", seqAntes: conocido });
	const r = await hubDe(env, tenantId).crearBaseVacia({ tenantId, modo, seqConocido: conocido });
	if (!r.ok) return c.json({ ok: false, error: r.error }, r.status as 409);

	const resultado = { tenantId, modo, seqConocido: conocido, inicio: r.inicio, purgadoHasta: r.purgadoHasta };
	await auditAdmin(getDb(env), "negocio_base_vacia", null, { ...resultado, motivo });
	await rastro(env, "base_vacia_creada", resultado);
	return c.json({ ok: true, ...resultado, queHacer: queHacerTrasDarBase(modo) });
});
