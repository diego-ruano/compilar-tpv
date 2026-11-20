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
import { listarCopias } from "../../durableObjects/tenantHub.copia";
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

