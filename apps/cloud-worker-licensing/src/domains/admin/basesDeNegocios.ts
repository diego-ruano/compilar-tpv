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
//
// Las dos de DO-PERDIDA son la salida de un negocio que ya nació y cuya base no está en su objeto
// (`lib/basePerdida.ts`): la activación y `/v1/sync/initialize-empty` se niegan a crearla, a
// propósito, y esto es hacerlo a sabiendas. Sólo con un negocio nacido y un objeto vacío.
//
// Todo va por POST con el negocio en el cuerpo, como el resto de la administración que lleva datos.
// Lo que cambia algo deja rastro en `admin_audit` (con el motivo) y en Axiom (sin él: es texto
// libre).

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
import { claveDeCopia, listarCopias } from "../../durableObjects/tenantHub.copia";
import { zDia } from "../../lib/fechas";
import { VENTANA_DE_VUELTA_MS, type ModoDeVuelta } from "../../durableObjects/tenantHub.instante";
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
					"Lo que la nube ha perdido desde el instante y la Main ya había subido lo repara el contraste de la Main, en su siguiente momento tranquilo; hasta entonces las Handy ven la nube del instante.",
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
	const ahora = Date.now();
	if (instanteMs !== undefined && (instanteMs >= ahora || instanteMs < ahora - VENTANA_DE_VUELTA_MS)) {
		return c.json(
			{
				ok: false,
				error: "instante_fuera_de_plazo",
				message: "Sólo se puede volver a un instante de los últimos 30 días.",
			},
			400,
		);
	}

	const hub = () => hubDe(env, tenantId);
	const prep = await hub().prepararVuelta({ tenantId, instanteMs, marcador });
	if (!prep.ok) {
		const message =
			prep.error === "vuelta_no_disponible"
				? "Este despliegue no puede devolver un objeto a un instante (en local no existe)."
				: undefined;
		return c.json({ ok: false, error: prep.error, ...(message ? { message } : {}) }, prep.status as 500);
	}

	let tras = await reiniciarYAbrir(hub, { tenantId, seqAntes: prep.seqAntes, modo });
	if (!tras.ok && tras.error === "vuelta_sin_aplicar") {
		tras = await reiniciarYAbrir(hub, { tenantId, seqAntes: prep.seqAntes, modo });
	}

	const resultado = {
		tenantId,
		modo,
		instanteMs: instanteMs ?? null,
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
					"Manda la Main: sigue con su base, se pone al día por encima del log nuevo y sube lo que tenga pendiente. Lo que la nube no tenga y la Main ya había subido lo repara su contraste, en su siguiente momento tranquilo.",
				]),
		"Las Handy y la Main reconectan solas.",
	];
}

/**
 * La base de una copia diaria de R2, a un objeto vacío (`MotorTenantHub.restaurarDesdeCopia`). Sin
 * `dia`, la más reciente. Si la copia no vale, el objeto se queda vacío y se dice por qué.
 */
basesDeNegociosRoutes.post("/restaurar-copia", cuerpo(restaurarSchema), async (c) => {
	const env = c.env;
	const { tenantId, dia, modo, motivo } = c.req.valid("json");
	if (!(await negocioNacido(getDb(env), tenantId))) return c.json(sinNacer(tenantId), 409);

	const clave = dia ? claveDeCopia(tenantId, dia) : (await listarCopias(env.COPIAS_NEGOCIOS, tenantId))[0]?.clave;
	if (!clave) {
		return c.json({ ok: false, error: "copia_no_encontrada", message: "Este negocio no tiene ninguna copia." }, 404);
	}
	const r = await hubDe(env, tenantId).restaurarDesdeCopia({ tenantId, clave, modo });
	if (!r.ok) return c.json({ ok: false, error: r.error, clave }, r.status as 409);

	const resultado = { tenantId, modo, clave: r.clave, filas: r.filas, tablas: r.tablas, inicio: r.inicio, purgadoHasta: r.purgadoHasta };
	await auditAdmin(getDb(env), "negocio_restaurar_copia", null, { ...resultado, motivo });
	await rastro(env, "base_restaurada_de_copia", resultado);
	return c.json({ ok: true, ...resultado, queHacer: queHacerTrasDarBase(modo) });
});

/** Una base nueva y vacía, a un objeto vacío de un negocio nacido (`MotorTenantHub.crearBaseVacia`). */
basesDeNegociosRoutes.post("/base-vacia", cuerpo(baseSchema), async (c) => {
	const env = c.env;
	const { tenantId, modo, motivo } = c.req.valid("json");
	if (!(await negocioNacido(getDb(env), tenantId))) return c.json(sinNacer(tenantId), 409);

	const r = await hubDe(env, tenantId).crearBaseVacia({ tenantId, modo });
	if (!r.ok) return c.json({ ok: false, error: r.error }, r.status as 409);

	const resultado = { tenantId, modo, inicio: r.inicio, purgadoHasta: r.purgadoHasta };
	await auditAdmin(getDb(env), "negocio_base_vacia", null, { ...resultado, motivo });
	await rastro(env, "base_vacia_creada", resultado);
	return c.json({ ok: true, ...resultado, queHacer: queHacerTrasDarBase(modo) });
});
