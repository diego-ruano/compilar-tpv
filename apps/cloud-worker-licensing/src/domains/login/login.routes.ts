// src/domains/login/login.routes.ts

import { Hono } from "hono";
import { z } from "zod";

import type { Env } from "../../env";
import { applyViaHub, HubError, type ApplyCommand } from "../../lib/hub";
import { isTpvDevice } from "../../lib/deviceAuth";
import { tenantQuery } from "../../lib/tenantClient";
import { tenantAuth, type TenantVars } from "../../middleware/tenant";
import { getDb } from "../../server/db";
import { ensureLicensingSchema } from "../../server/licenseStore";

import * as cmd from "./login.commands";
import { hashPin, verifyPin } from "./login.crypto";
import * as q from "./login.queries";
import * as S from "./login.schemas";
import { solicitarCodigoPin, verificarCodigoPin } from "./recuperarPin";
import { badRequest } from "../../server/utils/response";

type Ctx = { Bindings: Env; Variables: TenantVars };

export const loginRoutes = new Hono<Ctx>();

loginRoutes.use("*", tenantAuth);

function parseId(raw: string | undefined): string | null {
	const t = (raw ?? "").trim();
	return t.length ? t : null;
}

async function parseBody<S extends z.ZodTypeAny>(
	c: any,
	schema: S,
): Promise<{ ok: true; data: z.infer<S> } | { ok: false; res: Response }> {
	const body = await c.req.json().catch(() => null);
	const parsed = schema.safeParse(body);
	if (!parsed.success) {
		return { ok: false, res: badRequest(c, "validation_error", parsed.error) };
	}
	return { ok: true, data: parsed.data };
}

async function apply(
	c: any,
	built: { commandName: string; command: ApplyCommand; cloudPayload: any },
): Promise<any> {
	const opId = (c.req.header("X-Idempotency-Key") || "").trim();
	if (!opId) throw new HubError("missing_op_id", 400);
	return applyViaHub(c.env, {
		tenantId: c.get("tenantId"),
		deviceId: c.get("deviceId"),
		clientNow: c.req.header("X-Client-Now") || undefined,
		opId,
		commandName: built.commandName,
		command: built.command,
		cloudPayload: built.cloudPayload,
	});
}

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
	c.json(await tenantQuery(c.env, c.get("tenantId"), (db) => q.listLoginUsers(db))),
);

loginRoutes.post("/login", async (c) => {
	const p = await parseBody(c, S.loginUserSchema);
	if (!p.ok) return p.res;
	// LOGIN-01: bloqueo por intentos fallidos (anti brute-force).
	const secs = await tenantQuery(c.env, c.get("tenantId"), (db) =>
		q.throttleSecondsLeft(db, p.data.id_usuario),
	);
	if (secs > 0) {
		return c.json({ error: `Demasiados intentos fallidos. Prueba de nuevo en ${secs} s.` }, 429);
	}
	const record = await tenantQuery(c.env, c.get("tenantId"), (db) =>
		q.getLoginRecord(db, p.data.id_usuario),
	);
	if (!record) return c.json({ error: "Usuario no encontrado" }, 404);
	const badPin = await ensurePin(c, p.data.pin, String(record.password_hash));
	if (badPin) {
		await tenantQuery(c.env, c.get("tenantId"), (db) =>
			q.throttleFail(db, p.data.id_usuario),
		);
		return badPin;
	}
	await tenantQuery(c.env, c.get("tenantId"), (db) => q.throttleReset(db, p.data.id_usuario));
	const ok = await tenantQuery(c.env, c.get("tenantId"), (db) =>
		q.loginOk(db, p.data.id_usuario),
	);
	return c.json(ok);
});

loginRoutes.get("/:id/punch-status", async (c) => {
	const id = parseId(c.req.param("id"));
	if (id == null) return badRequest(c, "id_usuario invalido");
	return c.json(await tenantQuery(c.env, c.get("tenantId"), (db) => q.punchStatus(db, id)));
});

loginRoutes.post("/turno-partido", async (c) => {
	const p = await parseBody(c, S.setTurnoPartidoSchema);
	if (!p.ok) return p.res;
	await apply(c, cmd.setTurnoPartido(p.data));
	return c.json({ ok: true });
});

loginRoutes.post("/complete-initial-setup", async (c) => {
	const p = await parseBody(c, S.completeInitialSetupSchema);
	if (!p.ok) return p.res;
	const record = await tenantQuery(c.env, c.get("tenantId"), (db) =>
		q.getLoginRecord(db, p.data.id_usuario),
	);
	if (!record) return c.json({ error: "Usuario no encontrado" }, 404);
	const badPin = await ensurePin(c, p.data.pin_actual, String(record.password_hash));
	if (badPin) return badPin;
	const inUse = await tenantQuery(c.env, c.get("tenantId"), (db) =>
		q.emailInUse(db, p.data.email_nuevo, p.data.id_usuario),
	);
	if (inUse) return c.json({ error: "email already in use" }, 409);
	const passwordHash = await hashPin(p.data.pin_nuevo);
	await apply(
		c,
		cmd.completeInitialSetup({
			id_usuario: p.data.id_usuario,
			email_nuevo: p.data.email_nuevo,
			password_hash: passwordHash,
		}),
	);
	return c.json({ ok: true });
});

// Subida del setup inicial Main -> nube. Escritura DIRECTA en Turso (sin hub), porque la Main
// no está conectada por WebSocket; el hub la rechazaría con `main_offline`. Deja la nube con
// las credenciales reales del admin para que el login de la Handy funcione.
loginRoutes.post("/sync-initial-setup", async (c) => {
	const p = await parseBody(c, S.syncInitialSetupSchema);
	if (!p.ok) return p.res;

	const okTpv = await isTpvDevice(c.env, c.get("tenantId"), c.get("deviceId"));
	if (!okTpv) return c.json({ error: "forbidden_not_tpv" }, 403);

	const passwordHash = await hashPin(p.data.pin);

	await tenantQuery(c.env, c.get("tenantId"), (db) =>
		q.applyInitialSetupDirect(db, {
			idUsuario: p.data.id_usuario,
			email: p.data.email,
			passwordHash,
		}),
	);

	return c.json({ ok: true });
});

// ── Recuperar el PIN de un administrador (LOGIN-07) ─────────────────────────────────────────
// Sólo desde la Main: el PIN que se recupera vive en su base local, y que la petición vaya firmada
// con la clave de ESE equipo es la mitad de la prueba (la otra mitad es el buzón). La lógica y sus
// porqués están en `recuperarPin.ts`.

async function soloLaMainRecuperaPin(c: any): Promise<Response | null> {
	if (await isTpvDevice(c.env, c.get("tenantId"), c.get("deviceId"))) return null;
	return c.json(
		{
			ok: false,
			code: "validation",
			error: "recuperar_pin_solo_en_main",
			message: "El PIN se recupera desde el TPV principal.",
		},
		403,
	);
}

loginRoutes.post("/recuperar-pin/solicitar", async (c) => {
	const p = await parseBody(c, S.solicitarCodigoPinSchema);
	if (!p.ok) return p.res;

	const noMain = await soloLaMainRecuperaPin(c);
	if (noMain) return noMain;

	const db = getDb(c.env);
	await ensureLicensingSchema(db);

	const r = await solicitarCodigoPin(db, c.env, {
		tenantId: c.get("tenantId"),
		deviceId: c.get("deviceId"),
		licHash: c.get("licHash"),
		idUsuario: p.data.id_usuario,
		ahora: Date.now(),
	});
	return c.json(r.body, r.status);
});

loginRoutes.post("/recuperar-pin/verificar", async (c) => {
	const p = await parseBody(c, S.verificarCodigoPinSchema);
	if (!p.ok) return p.res;

	const noMain = await soloLaMainRecuperaPin(c);
	if (noMain) return noMain;

	const db = getDb(c.env);
	await ensureLicensingSchema(db);

	const r = await verificarCodigoPin(
		db,
		c.env,
		{
			tenantId: c.get("tenantId"),
			deviceId: c.get("deviceId"),
			licHash: c.get("licHash"),
			idUsuario: p.data.id_usuario,
			codigo: p.data.codigo,
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

loginRoutes.post("/punch", async (c) => {
	const p = await parseBody(c, S.punchSchema);
	if (!p.ok) return p.res;
	// LOGIN-01: el fichaje también verifica PIN → mismo throttle anti brute-force.
	const secs = await tenantQuery(c.env, c.get("tenantId"), (db) =>
		q.throttleSecondsLeft(db, p.data.id_usuario),
	);
	if (secs > 0) {
		return c.json({ error: `Demasiados intentos fallidos. Prueba de nuevo en ${secs} s.` }, 429);
	}
	const record = await tenantQuery(c.env, c.get("tenantId"), (db) =>
		q.getLoginRecord(db, p.data.id_usuario),
	);
	if (!record) return c.json({ error: "Usuario no encontrado" }, 404);
	const badPin = await ensurePin(c, p.data.pin, String(record.password_hash));
	if (badPin) {
		await tenantQuery(c.env, c.get("tenantId"), (db) =>
			q.throttleFail(db, p.data.id_usuario),
		);
		return badPin;
	}
	await tenantQuery(c.env, c.get("tenantId"), (db) => q.throttleReset(db, p.data.id_usuario));

	// TRAB-02: se IGNORA la fecha/hora que envía el cliente (podría falsear el control horario) y se
	// usa siempre la del servidor. La fecha del fichaje se calcula aquí en servidor.
	const fecha = await tenantQuery(c.env, c.get("tenantId"), async (db) => {
		const status = await q.punchStatus(db, p.data.id_usuario);
		return status.fecha;
	});

	if (p.data.tipo === "entrada") {
		const parte = await tenantQuery(c.env, c.get("tenantId"), (db) =>
			q.nextPunchPart(db, p.data.id_usuario, fecha),
		);
		await apply(
			c,
			cmd.punchEntrada({
				id_usuario: p.data.id_usuario,
				fecha,
				parte,
			}),
		);
	} else {
		const open = await tenantQuery(c.env, c.get("tenantId"), (db) =>
			q.getOpenPunch(db, p.data.id_usuario, fecha),
		);
		if (!open) {
			return c.json({ error: "No hay fichaje abierto para cerrar (primero ficha entrada)." }, 409);
		}
		await apply(
			c,
			cmd.punchSalida({
				id_usuario: p.data.id_usuario,
				id_fichaje: String(open.id_fichaje),
			}),
		);
	}

	return c.json(
		await tenantQuery(c.env, c.get("tenantId"), (db) =>
			q.punchStatusForDate(db, p.data.id_usuario, fecha),
		),
	);
});
