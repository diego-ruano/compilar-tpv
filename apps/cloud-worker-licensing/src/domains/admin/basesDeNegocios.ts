// src/domains/admin/basesDeNegocios.ts
//
// DO-03 · La base de un negocio, desde la administración: cómo está, sus copias y devolverla a un
// instante. Va montado en `admin.routes.ts`, detrás de `requireAdmin` (`ADMIN_API_TOKEN`), y el CLI
// lo llama con `pnpm negocio:*` (`scripts/tpv-license.mjs`). El procedimiento entero, con lo que
// hay que hacer después en la Main, está en docs/guias/restaurar-un-negocio.md.
//
//   POST /v1/admin/negocios/estado    → si nació, si tiene base, su próxima copia y sus copias en R2
//   POST /v1/admin/negocios/copiar    → la copia de hoy, ahora
//   POST /v1/admin/negocios/instante  → devuelve su TenantHub a un instante (o a un marcador), o
//                                       aplica una vuelta preparada (`reiniciar`, VUELTA-REPETIR)
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

import { Hono, type Context } from "hono";
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
import type { ResultadoDeAdministracion, VueltaAplicada, VueltaPreparada } from "../../durableObjects/tenantHub.rpc";

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
 *
 * La de una vuelta a un instante lleva además su `deshacer` y quién manda (`modo`): es lo que queda de
 * ella fuera del objeto, que la vuelta deja sin su marca, y con lo que se aplica aparte si el objeto
 * se ha reiniciado por su cuenta (`reservaDeLaVuelta`, VUELTA-REPETIR).
 */
async function reservarLog(
	env: Env,
	{
		tenantId,
		operacion,
		seqAntes,
		vuelta,
	}: {
		tenantId: string;
		operacion: "instante" | "base_vacia" | "copia";
		seqAntes: number;
		vuelta?: { deshacer: string; modo: ModoDeVuelta };
	},
): Promise<void> {
	await auditAdmin(getDb(env), "negocio_log_reservado", null, {
		tenantId,
		operacion,
		seqAntes,
		inicio: seqAntes + SALTO_DE_SEQ,
		...vuelta,
	});
}

/**
 * VUELTA-REPETIR · La reserva del log de la vuelta de `tenantId` que se deshace con `deshacer`, la
 * última si hay varias, o `null`. Lanza si la base central no contesta.
 */
async function reservaDeLaVuelta(
	env: Env,
	tenantId: string,
	deshacer: string,
): Promise<{ seqAntes: number; modo: ModoDeVuelta } | null> {
	const r = await getDb(env).execute({
		sql: `SELECT json_extract(detail, '$.seqAntes') AS seqAntes, json_extract(detail, '$.modo') AS modo FROM admin_audit
		      WHERE action = 'negocio_log_reservado' AND json_extract(detail, '$.operacion') = 'instante'
		        AND json_extract(detail, '$.tenantId') = ?1 AND json_extract(detail, '$.deshacer') = ?2
		      ORDER BY at_ms DESC, audit_id DESC LIMIT 1;`,
		args: [tenantId, deshacer],
	});
	const fila = r.rows[0] as { seqAntes?: unknown; modo?: unknown } | undefined;
	if (!fila || (fila.modo !== "nube" && fila.modo !== "main")) return null;
	return { seqAntes: Number(fila.seqAntes) || 0, modo: fila.modo };
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
		/**
		 * VUELTA-REPETIR · O, en vez de volver, el `deshacer` de una vuelta preparada y sin aplicar: la
		 * aplica, sólo si sigue preparada. Va sola: adónde se vuelve y quién manda los eligió la vuelta.
		 */
		reiniciar: z.string().min(1).max(200).optional(),
		modo: zModo.optional(),
		motivo: zMotivo,
	})
	.superRefine((b, ctx) => {
		if (b.reiniciar !== undefined) {
			if (b.instanteMs !== undefined || b.marcador !== undefined || b.modo !== undefined) {
				ctx.addIssue({
					code: "custom",
					message: "Aplicar una vuelta preparada va solo: sin instante, marcador ni modo, que ya los eligió la vuelta.",
				});
			}
			return;
		}
		if ((b.instanteMs === undefined) === (b.marcador === undefined)) {
			ctx.addIssue({ code: "custom", message: "Di a qué se vuelve: un instante o un marcador, uno de los dos." });
		}
		if (b.modo === undefined) {
			ctx.addIssue({ code: "custom", path: ["modo"], message: "Elige quién manda después: «nube» o «main»." });
		}
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

/** VUELTA-REPETIR · La orden que aplica la vuelta preparada de `tenantId` que se deshace con `deshacer`. */
const ordenQueLaAplica = (tenantId: string, deshacer: string) =>
	`pnpm negocio:instante -- --tenant ${tenantId} --reiniciar ${deshacer} --motivo "…"`;

/**
 * VUELTA-REPETIR · Lo que se dice de una vuelta preparada que no se ha aplicado, para aplicarla: con su
 * `deshacer`, aparte, y nunca repitiendo la orden de la vuelta, que si el objeto se ha reiniciado
 * entretanto volvería otra vez y se llevaría lo escrito entre medias.
 */
const paraAplicarla = (tenantId: string, deshacer: string) =>
	`Se aplica con ${ordenQueLaAplica(tenantId, deshacer)}: sólo reinicia el objeto si esta vuelta sigue preparada, y si ya se ha aplicado, no vuelve otra vez. No repitas la orden de la vuelta: si el objeto se ha reiniciado entretanto, ya ha vuelto, y volvería otra vez.`;

const QUE_PASA = {
	log_sin_reservar:
		"La vuelta está preparada, pero la base central no ha contestado y sin ella no se abre el log: la base sigue cerrada.",
	vuelta_sin_aplicar: "La vuelta está preparada pero el objeto no ha vuelto todavía, y su base sigue cerrada.",
	vuelta_a_la_vez:
		"La vuelta preparada de este negocio es otra, o se le está dando base: no se ha reiniciado nada. Mira cómo está con pnpm negocio:estado.",
	sin_vuelta_preparada:
		"Este negocio no tiene ninguna vuelta preparada con ese deshacer, ni consta que se preparase: no se ha reiniciado nada. Mira cómo está con pnpm negocio:estado.",
	vuelta_ya_aplicada: "Esa vuelta ya se ha aplicado, y su log ya está abierto: no se ha hecho nada.",
} as const;

/**
 * Devuelve el TenantHub de un negocio a un instante de los últimos 30 días, o a un marcador; o, con
 * `reiniciar`, aplica una vuelta que quedó preparada (`aplicarLaPreparada`).
 *
 * Son tres llamadas al objeto, cada una con un stub nuevo (el reinicio deja inservible el anterior):
 *
 * 1. `prepararVuelta`: deja la vuelta preparada, lee lo que la nube había numerado, cierra la base
 *    y echa a las sesiones. Contesta el marcador con el que se deshace.
 * 2. `reiniciarParaAplicar(deshacer)`: `ctx.abort()`, sólo si la vuelta preparada es ésta. La llamada
 *    falla, y es lo esperado: el objeto se ha reiniciado y al arrancar vuelve.
 * 3. `trasVolver`: ya en el objeto vuelto, abre el log por encima de lo numerado y, con `nube`,
 *    obliga a las Main a traerse la nube. Si el objeto todavía no ha vuelto, se reinicia otra vez y
 *    se repite una vez.
 *
 * VUELTA-REPETIR · Lo que no sale entero (`log_sin_reservar`, `vuelta_sin_aplicar`) da el `deshacer`
 * y la orden que la aplica, no «repite la misma orden»: la vuelta ya está preparada, y si el objeto se
 * reinicia por su cuenta (un despliegue) se aplica sola, sin que nadie lo vea; repetir la orden
 * prepararía otra al mismo destino y se llevaría lo escrito entre medias.
 */
basesDeNegociosRoutes.post("/instante", cuerpo(instanteSchema), async (c) => {
	const env = c.env;
	const { tenantId, instanteMs, marcador, reiniciar, modo: elegido, motivo } = c.req.valid("json");
	if (reiniciar !== undefined) return aplicarLaPreparada(c, { tenantId, deshacer: reiniciar, motivo });
	// Sin `reiniciar`, el esquema lo exige.
	const modo = elegido as ModoDeVuelta;
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
	const prep = await hub().prepararVuelta({ tenantId, instanteMs, marcador, modo });
	if (!prep.ok) {
		const message =
			prep.error === "vuelta_no_disponible"
				? "Este despliegue no puede devolver un objeto a un instante (en local no existe)."
				: undefined;
		return c.json({ ok: false, error: prep.error, ...(message ? { message } : {}) }, prep.status as 500);
	}

	const seqAntes = Math.max(prep.seqAntes, conocido);
	const { deshacer } = prep;
	try {
		await reservarLog(env, { tenantId, operacion: "instante", seqAntes, vuelta: { deshacer, modo } });
	} catch {
		return sinAplicar(c, "log_sin_reservar", 503, { tenantId, deshacer, modo });
	}
	const tras = await reiniciarYAbrir(hub, { tenantId, seqAntes, modo, deshacer });

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

	if (!tras.ok) return noAplicada(c, tras, { tenantId, deshacer, modo });
	return c.json({ ok: true, ...resultado, queHacer: queHacerDespues(modo, deshacer, tenantId) });
});

/**
 * VUELTA-REPETIR · Aplica la vuelta preparada de `tenantId` que se deshace con `deshacer`, sin volver
 * a pedirle nada a la plataforma (como la central, `domains/admin/central.ts::aplicarLaPreparada`):
 *
 * - **Sigue preparada** (la marca del objeto es la suya): reserva el log si no se reservó (la base
 *   central no contestó), reinicia el objeto (`reiniciarParaAplicar`, que vuelve a mirar que sea la
 *   suya) y abre el log, como la orden de la vuelta.
 * - **Ya no está preparada, pero consta su reserva**: el objeto se ha reiniciado por su cuenta y ya ha
 *   vuelto. No se reinicia: sólo se abre el log, con lo que apuntó la reserva. Si ya estaba abierto, se
 *   ha aplicado entera (`vuelta_ya_aplicada`), y no se hace nada.
 * - **Otra vuelta preparada**, o dándole base al objeto: `vuelta_a_la_vez`. **Ninguna, ni su reserva**:
 *   `sin_vuelta_preparada`. Ninguna de las dos reinicia ni abre nada.
 *
 * Quién manda y desde dónde se abre el log son los que eligió la vuelta: los lleva su marca, y su
 * reserva en la base central.
 */
async function aplicarLaPreparada(
	c: Context<{ Bindings: Env }>,
	{ tenantId, deshacer, motivo }: { tenantId: string; deshacer: string; motivo: string },
) {
	const env = c.env;
	const hub = () => hubDe(env, tenantId);
	const estado = await hub().cierreDeLaBase(tenantId);
	if (!estado.ok) return c.json({ ok: false, error: estado.error }, estado.status as 500);
	const { vuelta } = estado;
	if (estado.vueltaEnCurso && vuelta?.deshacer !== deshacer) {
		return c.json({ ok: false, error: "vuelta_a_la_vez", message: QUE_PASA.vuelta_a_la_vez, vuelta }, 409);
	}
	const reserva = await reservaDeLaVuelta(env, tenantId, deshacer);
	if (!vuelta && !reserva) {
		return c.json({ ok: false, error: "sin_vuelta_preparada", message: QUE_PASA.sin_vuelta_preparada }, 409);
	}

	let seqAntes: number;
	let modo: ModoDeVuelta;
	if (reserva) {
		({ seqAntes, modo } = reserva);
	} else {
		// Preparada y sin reservar: la base central no contestó al reservarla. Se reserva como entonces.
		modo = vuelta!.modo;
		seqAntes = Math.max(vuelta!.seqAntes, await seqConocido(env, tenantId));
		try {
			await reservarLog(env, { tenantId, operacion: "instante", seqAntes, vuelta: { deshacer, modo } });
		} catch {
			return sinAplicar(c, "log_sin_reservar", 503, { tenantId, deshacer, modo });
		}
	}

	const tras = vuelta
		? await reiniciarYAbrir(hub, { tenantId, seqAntes, modo, deshacer })
		: await hub().trasVolver({ tenantId, seqAntes, modo });
	if (!tras.ok && tras.error !== "vuelta_sin_aplicar") {
		const message = QUE_PASA[tras.error as keyof typeof QUE_PASA];
		return c.json({ ok: false, error: tras.error, ...(message ? { message } : {}) }, tras.status as 409);
	}

	const resultado = {
		tenantId,
		modo,
		destino: vuelta?.destino ?? null,
		deshacer,
		seqAntes,
		aplicada: true,
		...(tras.ok ? soloLoAplicado(tras) : { error: tras.error }),
	};
	await auditAdmin(getDb(env), "negocio_volver_a_instante", null, { ...resultado, motivo });
	await rastro(env, "nube_devuelta", { tenant_id: tenantId, ...resultado });

	if (!tras.ok) return noAplicada(c, tras, { tenantId, deshacer, modo });
	return c.json({ ok: true, ...resultado, queHacer: queHacerDespues(modo, deshacer, tenantId) });
}

/** La vuelta preparada que no se ha aplicado: por qué, su `deshacer` y la orden que la aplica. */
function sinAplicar(
	c: Context<{ Bindings: Env }>,
	error: "log_sin_reservar" | "vuelta_sin_aplicar",
	status: 503,
	{ tenantId, deshacer, modo }: { tenantId: string; deshacer: string; modo: ModoDeVuelta },
) {
	return c.json({ ok: false, error, message: `${QUE_PASA[error]} ${paraAplicarla(tenantId, deshacer)}`, deshacer, modo }, status);
}

/** Lo que contesta una vuelta que no ha salido al reiniciar o al abrir el log. */
function noAplicada(
	c: Context<{ Bindings: Env }>,
	tras: { error: string; status: number },
	vuelta: { tenantId: string; deshacer: string; modo: ModoDeVuelta },
) {
	if (tras.error === "vuelta_sin_aplicar") return sinAplicar(c, "vuelta_sin_aplicar", 503, vuelta);
	const message = QUE_PASA[tras.error as keyof typeof QUE_PASA];
	return c.json(
		{ ok: false, error: tras.error, ...(message ? { message } : {}), deshacer: vuelta.deshacer, modo: vuelta.modo },
		tras.status as 409,
	);
}

/**
 * Reinicia el objeto para aplicar la vuelta que se deshace con `deshacer` (`reiniciarParaAplicar`) y,
 * ya vuelto, abre el log. Si al ir a reiniciarlo ya no está preparada, el objeto se ha reiniciado por
 * su cuenta: se abre el log igual. Si no ha vuelto todavía, una vez más.
 */
async function reiniciarYAbrir(
	hub: () => ReturnType<typeof hubDe>,
	params: { tenantId: string; seqAntes: number; modo: ModoDeVuelta; deshacer: string },
): Promise<ResultadoDeAdministracion<VueltaAplicada>> {
	const { deshacer, ...abrir } = params;
	for (let vez = 0; ; vez++) {
		try {
			const r = await hub().reiniciarParaAplicar(params.tenantId, deshacer);
			if (!r.ok && r.error !== "sin_vuelta_preparada") return r;
		} catch {
			// `ctx.abort()` corta la llamada que lo pide: es lo que tiene que pasar.
		}
		const tras = await hub().trasVolver(abrir);
		if (tras.ok || tras.error !== "vuelta_sin_aplicar" || vez > 0) return tras;
	}
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
