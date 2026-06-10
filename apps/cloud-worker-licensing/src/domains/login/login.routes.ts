// src/domains/login/login.routes.ts

import { Hono } from "hono";
import { z } from "zod";

import type { Env } from "../../env";
import { applyViaHub, HubError, type ApplyCommand } from "../../lib/hub";
import { tenantQuery } from "../../lib/tenantClient";
import { tenantAuth, type TenantVars } from "../../middleware/tenant";

import * as cmd from "./login.commands";
import { hashPin, verifyPin } from "./login.crypto";
import * as q from "./login.queries";
import * as S from "./login.schemas";

type Ctx = { Bindings: Env; Variables: TenantVars };

export const loginRoutes = new Hono<Ctx>();

loginRoutes.use("*", tenantAuth);

function badRequest(c: any, error: string, err?: z.ZodError) {
	return c.json({ error, issues: err?.issues }, 400);
}

function parseId(raw: string | undefined): number | null {
	const n = Number(raw);
	return Number.isInteger(n) && n > 0 ? n : null;
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
	const record = await tenantQuery(c.env, c.get("tenantId"), (db) =>
		q.getLoginRecord(db, p.data.id_usuario),
	);
	if (!record) return c.json({ error: "Usuario no encontrado" }, 404);
	const badPin = await ensurePin(c, p.data.pin, String(record.password_hash));
	if (badPin) return badPin;
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

loginRoutes.post("/punch", async (c) => {
	const p = await parseBody(c, S.punchSchema);
	if (!p.ok) return p.res;
	const record = await tenantQuery(c.env, c.get("tenantId"), (db) =>
		q.getLoginRecord(db, p.data.id_usuario),
	);
	if (!record) return c.json({ error: "Usuario no encontrado" }, 404);
	const badPin = await ensurePin(c, p.data.pin, String(record.password_hash));
	if (badPin) return badPin;

	const fecha =
		p.data.fecha ||
		(await tenantQuery(c.env, c.get("tenantId"), async (db) => {
			const status = await q.punchStatus(db, p.data.id_usuario);
			return status.fecha;
		}));

	if (p.data.tipo === "entrada") {
		const parte = await tenantQuery(c.env, c.get("tenantId"), (db) =>
			q.nextPunchPart(db, p.data.id_usuario, fecha),
		);
		await apply(
			c,
			cmd.punchEntrada({
				id_usuario: p.data.id_usuario,
				fecha,
				hora_evento: p.data.hora_evento,
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
				fecha,
				hora_evento: p.data.hora_evento,
				id_fichaje: Number(open.id_fichaje),
			}),
		);
	}

	return c.json(
		await tenantQuery(c.env, c.get("tenantId"), (db) =>
			q.punchStatusForDate(db, p.data.id_usuario, fecha),
		),
	);
});
