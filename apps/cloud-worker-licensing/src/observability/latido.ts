// src/observability/latido.ts
//
// El latido del cron diario (PROD-01).
//
// Un monitor HTTP no puede ver esto: el worker contesta 200 igual de bien aunque su `scheduled`
// lleve meses sin dispararse —un despliegue que se dejó el trigger por el camino, o Cloudflare que
// deja de invocarlo—. Lo que se pierde entonces, en silencio, son los avisos de caducidad de
// licencia; y eso no lo echa de menos nadie hasta que un cliente se queda sin programa sin haber
// recibido ninguno. Un latido invierte la pregunta: la monitorización avisa cuando DEJA de llegar.
//
// La URL es un SECRETO (`wrangler secret put BETTERSTACK_HEARTBEAT_URL`) y no una variable de
// `wrangler.json`: ese fichero está en git, y quien tenga esta URL puede silenciar la alarma.

const TIMEOUT_MS = 10_000;

export async function latir(env: { BETTERSTACK_HEARTBEAT_URL?: string }): Promise<void> {
	const url = String(env.BETTERSTACK_HEARTBEAT_URL || "").trim();
	// Sin secreto configurado, no-op silencioso: esto se puede desplegar antes de crear el
	// heartbeat, igual que pasa con el DSN de Sentry.
	if (!url) return;

	try {
		const res = await fetch(url, { method: "GET", signal: AbortSignal.timeout(TIMEOUT_MS) });
		if (!res.ok) {
			// Una URL mal escrita pero bien formada contesta 404, y `fetch` no lanza nada: el
			// latido «sale» y no llega a ninguna parte. Se acaba notando —el heartbeat no se pone
			// verde y la monitorización avisa al día siguiente—, pero entonces la causa hay que
			// adivinarla. Esta línea la convierte en un vistazo al log.
			//
			// No se registra la URL: es el secreto con el que se silencia la alarma.
			console.error(`[cron] el latido salió con ${res.status}: ¿es esa la URL del heartbeat?`);
		}
	} catch (err) {
		// No propaga NUNCA, y es la misma regla que ya siguen las dos tareas del cron: que la
		// monitorización esté caída no puede impedir avisar a un cliente de que le vence la
		// licencia. El latido es lo accesorio de este cron, no su trabajo.
		console.error("[cron] el latido no salió:", (err as any)?.message || err);
	}
}
