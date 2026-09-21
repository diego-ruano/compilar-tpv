// src/domains/login/login.routes.ts

import { Hono } from "hono";

import type { Env } from "../../env";
import { isTpvDevice } from "../../lib/deviceAuth";
import { tenantQuery } from "../../lib/tenantClient";
import { tenantAuth, type TenantVars } from "../../middleware/tenant";
import { getDb } from "../../server/db";

import * as cmd from "./login.commands";
import { hashPin, verifyPin } from "./login.crypto";
import * as q from "./login.queries";
import * as S from "./login.schemas";
import { solicitarCodigoPin, verificarCodigoPin } from "./recuperarPin";
import {
	confirmarCambioCorreo,
	estadoCorreoRecuperacion,
	solicitarCambioCorreo,
	usarCorreoDeLaCompra,
} from "./correoRecuperacion";
import { badRequest } from "../../server/utils/response";
import { cuerpo } from "../../lib/validacion";
import { apply, parseId } from "../../lib/rutas";

type Ctx = { Bindings: Env; Variables: TenantVars };

export const loginRoutes = new Hono<Ctx>();

loginRoutes.use("*", tenantAuth);

// Verifica el PIN; si es incorrecto (o el hash esta mal formado) devuelve un 401 con el
// mensaje, en vez de dejar que el throw caiga al onError como 500 internal_error.
async function ensurePin(
	c: any,
	pin: string,
	hash: string,
): Promise<Response | null> {
	try {
		await verifyPin(pin, hash);
		return null;
	} catch (e: any) {
		return c.json({ error: String(e?.message || "PIN incorrecto") }, 401);
	}
}

loginRoutes.get("/users", async (c) =>
	c.json(await tenantQuery(c, (db) => q.listLoginUsers(db))),
);

loginRoutes.post("/login", cuerpo(S.loginUserSchema), async (c) => {
	const datos = c.req.valid("json");
	// LOGIN-01: bloqueo por intentos fallidos (anti brute-force).
	const secs = await tenantQuery(c, (db) =>
		q.throttleSecondsLeft(db, datos.id_usuario),
	);
	if (secs > 0) {
		return c.json({ error: `Demasiados intentos fallidos. Prueba de nuevo en ${secs} s.` }, 429);
	}
	const record = await tenantQuery(c, (db) =>
		q.getLoginRecord(db, datos.id_usuario),
	);
	if (!record) return c.json({ error: "Usuario no encontrado" }, 404);
	const badPin = await ensurePin(c, datos.pin, String(record.password_hash));
	if (badPin) {
		await tenantQuery(c, (db) =>
			q.throttleFail(db, datos.id_usuario),
		);
		return badPin;
	}
	await tenantQuery(c, (db) => q.throttleReset(db, datos.id_usuario));
	const ok = await tenantQuery(c, (db) =>
		q.loginOk(db, datos.id_usuario),
	);
	return c.json(ok);
});

loginRoutes.get("/:id/punch-status", async (c) => {
	const id = parseId(c.req.param("id"));
	if (id == null) return badRequest(c, "id_usuario invalido");
	return c.json(await tenantQuery(c, (db) => q.punchStatus(db, id)));
});

loginRoutes.post("/turno-partido", cuerpo(S.setTurnoPartidoSchema), async (c) => {
	const datos = c.req.valid("json");
	await apply(c, cmd.setTurnoPartido(datos));
	return c.json({ ok: true });
});

// REV-06: aquí vivía `POST /complete-initial-setup`, que elegía el PIN inicial DESDE la nube
// verificando el PIN anterior. Se ha retirado, y su ausencia es la corrección:
//   · Verificaba un PIN **sin el bloqueo por intentos de LOGIN-01**, que sí tienen `/login` y
//     `/punch`. Un PIN son cuatro cifras: diez mil combinaciones, ningún freno, y al acertar se le
//     cambiaban PIN y correo a cualquier usuario activo, administrador incluido. Hacía falta una
//     Handy vinculada (`tenantAuth` exige device-proof), que es exactamente a quien SEC-01 dice
//     proteger contra esto.
//   · Y tampoco miraba `Requiere_Setup`, que en la Main es el ÚNICO cerrojo (allí el PIN ni se
//     comprueba: en el primer arranque no hay ninguno que confirmar). O sea que las dos
//     implementaciones del mismo comando tenían el cerrojo cambiado: cada una la mitad de la otra.
//   · No cubría ningún caso real. El setup lo hace la Main contra su SQLite y luego sube el
//     resultado por `/sync-initial-setup` (aquí abajo); la Handy no entra nunca a este flujo,
//     porque una Main con el setup pendiente no pasa de su propia pantalla de setup y por tanto no
//     llega a Configuración ni puede vincular ninguna Handy.
// Es la misma decisión que `cobro_solo_en_main`, `soloLaMainEscribeCaja` y `fiscalSoloMain`: quien
// tiene autoridad sobre esa fila es la Main, así que la nube no ofrece un segundo camino hacia ella.
// Lo vigila `test/pinSiempreConFreno.test.ts`, que además exige el freno a toda ruta que mire un PIN.

// Subida del setup inicial Main -> nube. Escritura DIRECTA en Turso (sin hub), porque la Main
// no está conectada por WebSocket; el hub la rechazaría con `main_offline`. Deja la nube con
// las credenciales reales del admin para que el login de la Handy funcione.
loginRoutes.post("/sync-initial-setup", cuerpo(S.syncInitialSetupSchema), async (c) => {
	const datos = c.req.valid("json");

	const okTpv = await isTpvDevice(c.env, c.get("tenantId"), c.get("deviceId"));
	if (!okTpv) return c.json({ error: "forbidden_not_tpv" }, 403);

	const passwordHash = await hashPin(datos.pin);

	await tenantQuery(c, (db) =>
		q.applyInitialSetupDirect(db, {
			idUsuario: datos.id_usuario,
			email: datos.email,
			passwordHash,
		}),
	);

	return c.json({ ok: true });
});

// ── Recuperar el PIN de un administrador (LOGIN-07) ─────────────────────────────────────────
// Sólo desde la Main: el PIN que se recupera vive en su base local, y que la petición vaya firmada
// con la clave de ESE equipo es la mitad de la prueba (la otra mitad es el buzón). La lógica y sus
// porqués están en `recuperarPin.ts`.

async function soloLaMain(c: any): Promise<Response | null> {
	if (await isTpvDevice(c.env, c.get("tenantId"), c.get("deviceId"))) return null;
	return c.json(
		{
			ok: false,
			code: "validation",
			error: "recuperacion_solo_en_main",
			message: "Esto se hace desde el TPV principal.",
		},
		403,
	);
}

/** Para los avisos por correo, que no pueden retener la respuesta. */
function diferirEn(c: any): (p: Promise<unknown>) => void {
	return (promesa) => {
		// Sin `executionCtx` (tests) lanza: perder el aviso no puede tumbar la respuesta.
		try {
			c.executionCtx.waitUntil(promesa);
		} catch {
			void promesa;
		}
	};
}

loginRoutes.post("/recuperar-pin/solicitar", cuerpo(S.solicitarCodigoPinSchema), async (c) => {
	const datos = c.req.valid("json");

	const noMain = await soloLaMain(c);
	if (noMain) return noMain;

	const db = getDb(c.env);

	const r = await solicitarCodigoPin(db, c.env, {
		tenantId: c.get("tenantId"),
		deviceId: c.get("deviceId"),
		licHash: c.get("licHash"),
		idUsuario: datos.id_usuario,
		ahora: Date.now(),
	});
	return c.json(r.body, r.status);
});

loginRoutes.post("/recuperar-pin/verificar", cuerpo(S.verificarCodigoPinSchema), async (c) => {
	const datos = c.req.valid("json");

	const noMain = await soloLaMain(c);
	if (noMain) return noMain;

	const db = getDb(c.env);

	const r = await verificarCodigoPin(
		db,
		c.env,
		{
			tenantId: c.get("tenantId"),
			deviceId: c.get("deviceId"),
			licHash: c.get("licHash"),
			idUsuario: datos.id_usuario,
			codigo: datos.codigo,
			ahora: Date.now(),
		},
		(promesa) => {
			// Sin `executionCtx` (tests) lanza: perder el aviso no puede tumbar la respuesta.
			try {
				c.executionCtx.waitUntil(promesa);
			} catch {
				void promesa;
			}
		},
	);
	return c.json(r.body, r.status);
});

// ── Correo de recuperación (LOGIN-08) ───────────────────────────────────────────────────────
// A dónde llegan los códigos de recuperar el PIN. Que quien lo cambia sea administrador lo exige la
// Main (sesión); aquí cuenta el código enviado al correo nuevo y el aviso al anterior. Ver
// `correoRecuperacion.ts`.

function contextoCorreo(c: any) {
	return {
		tenantId: c.get("tenantId") as string,
		deviceId: c.get("deviceId") as string,
		licHash: c.get("licHash") as string,
		ahora: Date.now(),
	};
}

loginRoutes.post("/correo-recuperacion/estado", async (c) => {
	const noMain = await soloLaMain(c);
	if (noMain) return noMain;

	const db = getDb(c.env);

	const r = await estadoCorreoRecuperacion(db, contextoCorreo(c));
	return c.json(r.body, r.status);
});

loginRoutes.post("/correo-recuperacion/solicitar", cuerpo(S.solicitarCambioCorreoSchema), async (c) => {
	const datos = c.req.valid("json");

	const noMain = await soloLaMain(c);
	if (noMain) return noMain;

	const db = getDb(c.env);

	const r = await solicitarCambioCorreo(db, c.env, { ...contextoCorreo(c), correo: datos.correo });
	return c.json(r.body, r.status);
});

loginRoutes.post("/correo-recuperacion/confirmar", cuerpo(S.confirmarCambioCorreoSchema), async (c) => {
	const datos = c.req.valid("json");

	const noMain = await soloLaMain(c);
	if (noMain) return noMain;

	const db = getDb(c.env);

	const r = await confirmarCambioCorreo(
		db,
		c.env,
		{ ...contextoCorreo(c), codigo: datos.codigo },
		diferirEn(c),
	);
	return c.json(r.body, r.status);
});

loginRoutes.post("/correo-recuperacion/usar-el-de-la-compra", async (c) => {
	const noMain = await soloLaMain(c);
	if (noMain) return noMain;

	const db = getDb(c.env);

	const r = await usarCorreoDeLaCompra(db, c.env, contextoCorreo(c), diferirEn(c));
	return c.json(r.body, r.status);
});

loginRoutes.post("/punch", cuerpo(S.punchSchema), async (c) => {
	const datos = c.req.valid("json");
	// LOGIN-01: el fichaje también verifica PIN → mismo throttle anti brute-force.
	const secs = await tenantQuery(c, (db) =>
		q.throttleSecondsLeft(db, datos.id_usuario),
	);
	if (secs > 0) {
		return c.json({ error: `Demasiados intentos fallidos. Prueba de nuevo en ${secs} s.` }, 429);
	}
	const record = await tenantQuery(c, (db) =>
		q.getLoginRecord(db, datos.id_usuario),
	);
	if (!record) return c.json({ error: "Usuario no encontrado" }, 404);
	const badPin = await ensurePin(c, datos.pin, String(record.password_hash));
	if (badPin) {
		await tenantQuery(c, (db) =>
			q.throttleFail(db, datos.id_usuario),
		);
		return badPin;
	}
	await tenantQuery(c, (db) => q.throttleReset(db, datos.id_usuario));

	// La fecha del fichaje. Sale de una consulta (`date('now','localtime')`) que `tenantQuery`
	// resuelve con la hora local de quien ficha (REV-03), que es la MISMA con la que el Durable
	// Object fija la `Hora_Entrada` de la fila. Antes la ponía Turso, que corre en UTC: a las 00:30
	// se guardaba un fichaje fechado ayer con una hora de hoy — una fila que se contradice a sí
	// misma y que viaja así a la Main, al registro de jornada.
	//
	// TRAB-02, el control horario ha de ser VERAZ: por eso la petición ya **no lleva** fecha ni hora
	// — las llevó, y nadie las leía. Un valor del cuerpo es cualquier cosa; `X-Client-Now` es el
	// reloj del equipo que ficha, el mismo que en la Main escribe el fichaje, y llega con su
	// guardia de deriva.
	const fecha = await tenantQuery(c, async (db) => {
		const status = await q.punchStatus(db, datos.id_usuario);
		return status.fecha;
	});

	if (datos.tipo === "entrada") {
		const parte = await tenantQuery(c, (db) =>
			q.nextPunchPart(db, datos.id_usuario, fecha),
		);
		await apply(
			c,
			cmd.punchEntrada({
				id_usuario: datos.id_usuario,
				fecha,
				parte,
			}),
		);
	} else {
		const open = await tenantQuery(c, (db) =>
			q.getOpenPunch(db, datos.id_usuario, fecha),
		);
		if (!open) {
			return c.json({ error: "No hay fichaje abierto para cerrar (primero ficha entrada)." }, 409);
		}
		await apply(
			c,
			cmd.punchSalida({
				id_usuario: datos.id_usuario,
				id_fichaje: String(open.id_fichaje),
			}),
		);
	}

	return c.json(
		await tenantQuery(c, (db) =>
			q.punchStatusForDate(db, datos.id_usuario, fecha),
		),
	);
});
