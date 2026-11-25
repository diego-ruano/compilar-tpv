// src/index.ts
//
// Entry del worker `tpv-api`: la API (`app.ts`) envuelta con Sentry, el cron diario y los tres
// Durable Objects. Las rutas y lo que sirve cada una están en `app.ts`.

import * as Sentry from "@sentry/cloudflare";

import type { Env } from "./env";
import { app } from "./app";
import { sentryOptions } from "./observability/sentry";
import { capturarError } from "./observability/errors";
import { getDb } from "./server/db";
import { avisarDeCaducidades } from "./domains/licensing/avisosDeCaducidad";
import { purgarBaseCentral } from "./server/purga";
import { centralDe } from "./lib/objetosDelNegocio";
import { ErrorDeLaCentral } from "./server/central/cliente";
import { registrarSinLaCentral } from "./server/central/sinLaCentral";
import { latir, latirA } from "./observability/latido";
import { FILAS_QUE_SE_RESTAURAN_DE_UNA_VEZ } from "./durableObjects/baseCentral.restaurar";

// El Durable Object vive ahora en este worker (antes en `tpv-server`). Se instrumenta con Sentry
// para capturar las excepciones de su ciclo de vida (apply idempotente, WebSocket, broadcast).
//
// AUD-46: hasta `@sentry/cloudflare` 10.66, este envoltorio dejaba en cada evento del DO un vaciado
// por `waitUntil` que se esperaba a sí mismo (getsentry/sentry-javascript#22328), y el objeto no
// hibernaba nunca con un socket abierto: un negocio con la Main conectada facturaba duración las
// 24 horas. `test/elHubPuedeHibernar.test.ts` falla si vuelve.
import { TenantHub as TenantHubClass } from "./durableObjects/tenantHub";
export const TenantHub = Sentry.instrumentDurableObjectWithSentry(
	sentryOptions,
	TenantHubClass,
);

// La agenda de reservas web (docs/estudios/reservas-web.md §4.3), instrumentada igual.
import { AgendaWeb as AgendaWebClass } from "./durableObjects/agendaWeb";
export const AgendaWeb = Sentry.instrumentDurableObjectWithSentry(sentryOptions, AgendaWebClass);

// La base central, en su propio Durable Object (`durableObjects/baseCentral.ts`), instrumentada igual.
import { BaseCentral as BaseCentralClass } from "./durableObjects/baseCentral";
export const BaseCentral = Sentry.instrumentDurableObjectWithSentry(sentryOptions, BaseCentralClass);

/**
 * Lo que este worker hace por su cuenta, una vez al día: avisar de las licencias que caducan
 * (REV-13), recoger la basura de la base central (`server/purga.ts`) y pedirle que se copie a R2
 * (`durableObjects/baseCentral.copia.ts`, PROD-02).
 *
 * Va aquí y no en una ruta porque nadie lo va a llamar: el cliente no sabe que su licencia se
 * acaba hasta que deja de funcionar. El cron está en `wrangler.json` (`triggers.crons`), y los dos
 * cuerpos son idempotentes — un día perdido se recupera solo al siguiente.
 *
 * Cada tarea va en su propio `try` y ninguna propaga: son independientes, y la purga —que es
 * mantenimiento— no puede llevarse por delante un aviso que alguien está esperando para renovar.
 */
async function programado(env: Env, ctx: ExecutionContext): Promise<void> {
	const enSegundoPlano = (promesa: Promise<unknown>) => ctx.waitUntil(promesa);
	try {
		const r = await avisarDeCaducidades(env, getDb(env), Date.now(), enSegundoPlano);
		console.log(
			`[cron] avisos de caducidad: ${r.enviados} enviados, ${r.yaAvisadas} ya avisadas, ` +
				`${r.fallidos} fallidos, de ${r.revisadas} revisadas`,
		);
	} catch (err) {
		// Lo que llega aquí es la lectura de las que caducan (`licenciasPorCaducar`): la central que no
		// la atiende queda como en el resto del ciclo (`registrarSinLaCentral`, su evento en Axiom, y
		// Sentry sólo si no es carga ni un fallo pasajero); lo demás, a Sentry.
		const operacion = "cron.license_expiry";
		if (!registrarSinLaCentral(err, { env, enSegundoPlano, operacion, metodo: "cron", ruta: operacion })) {
			capturarError(err, operacion);
			console.error("[cron] avisos de caducidad falló:", (err as any)?.message || err);
		}
	}

	try {
		const r = await purgarBaseCentral(getDb(env));
		console.log(
			`[cron] purga: ${r.fallosDeEmparejamiento} fallos de emparejamiento, ` +
				`${r.trazasDeCorreo} trazas de correo, ${r.eventosDeCodigo} eventos de código de cambio de equipo, ` +
				`${r.codigosDeEmparejamiento} códigos de emparejamiento, ${r.retosDeEmparejamiento} retos de emparejamiento`,
		);
	} catch (err) {
		capturarError(err, "cron.purge");
		console.error("[cron] purga falló:", (err as any)?.message || err);
	}

	// PROD-02 · La copia va DESPUÉS de la purga, para no guardar lo que se acaba de tirar. Su latido
	// es el único que se condiciona al éxito, y es lo contrario de lo que se hace con el de abajo por
	// la misma razón: cada latido responde a una pregunta, y la de éste es «¿hay una copia de hoy?».
	try {
		const copia = await centralDe(env).copiar(new Date().toISOString().slice(0, 10));
		if (!copia.ok) throw new ErrorDeLaCentral(copia.error, copia.detalle);
		const r = copia.valor;
		console.log(
			`[cron] copia de la base central: ${r.clave}, ${r.tablas} tablas, ${r.filas} filas, ` +
				`${r.bytes} bytes`,
		);
		// La copia vale, pero el día que hiciera falta no se restauraría de una vez: se avisa con tiempo.
		if (r.filas > FILAS_QUE_SE_RESTAURAN_DE_UNA_VEZ) {
			const aviso =
				`La copia de la base central tiene ${r.filas} filas, más de las ${FILAS_QUE_SE_RESTAURAN_DE_UNA_VEZ} que se ` +
				"restauran con holgura de una vez: hay que partir la restauración (baseCentral.restaurar.ts).";
			console.warn(`[cron] ${aviso}`);
			capturarError(new Error(aviso), "cron.backup");
		}
		await latirA(env.BETTERSTACK_HEARTBEAT_COPIAS_URL, "el latido de la copia");
	} catch (err) {
		capturarError(err, "cron.backup");
		console.error("[cron] copia de la base central falló:", (err as any)?.message || err);
	}

	// El latido va AQUÍ, fuera de los `try` y sin condicionarlo a que hayan ido bien: responde a
	// «¿se está ejecutando el cron?», no a «¿funcionó todo?». Las dos tareas son idempotentes y se
	// recuperan solas al día siguiente, así que atar el latido a su éxito convertiría una caída
	// pasajera de la base central en un aviso de «cron muerto» — y una falsa alarma enseña a ignorar
	// la buena. Lo que sí falló ya lo cuentan el log y Sentry.
	await latir(env);
}

// El wrapper de Sentry captura las excepciones no controladas del worker (requiere el flag
// `nodejs_compat`, ver wrangler.json). Si no hay `SENTRY_DSN`, es un no-op transparente.
export default Sentry.withSentry(sentryOptions, {
	fetch: (request, env, ctx) => app.fetch(request, env, ctx),
	scheduled: (_evento, env, ctx) => ctx.waitUntil(programado(env, ctx)),
} satisfies ExportedHandler<Env>);
