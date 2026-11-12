// src/domains/login/login.routes.ts

import { Hono } from "hono";

import type { Env } from "../../env";
import { tenantQuery } from "../../lib/tenantClient";
import { soloLaMain, tenantAuth, type TenantVars } from "../../middleware/tenant";
import { alHub } from "../../lib/enElHub";
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

loginRoutes.use("*", tenantAuth, alHub);

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

/**
 * ¿Entra sin PIN (`Usuarios.Sin_PIN = 1`)? Entonces ni se comprueba el PIN ni se mira el freno: no
 * hay secreto que adivinar, y un bloqueo que le quedara de antes le dejaría fuera. Igual en la Main
 * (`comprobar_pin` de `tpv-infra-sqlite/src/login.rs`).
 */
function entraSinPin(record: any): boolean {
	return Number(record?.sin_pin) === 1;
}

loginRoutes.post("/login", cuerpo(S.loginUserSchema), async (c) => {
	const datos = c.req.valid("json");
	const record = await tenantQuery(c, (db) =>
		q.getLoginRecord(db, datos.id_usuario),
	);
	if (!record) return c.json({ error: "Usuario no encontrado" }, 404);
	if (!entraSinPin(record)) {
		// LOGIN-01: bloqueo por intentos fallidos (anti brute-force). AUD-05: el intento se reserva
		// ANTES de verificar el PIN; sin reserva no se verifica nada.
		const reserva = await tenantQuery(c, (db) =>
			q.reservarIntento(db, datos.id_usuario),
		);
		if (!reserva.concedido) {
			return c.json({ error: `Demasiados intentos fallidos. Prueba de nuevo en ${reserva.segundos} s.` }, 429);
		}
		const badPin = await ensurePin(c, datos.pin, String(record.password_hash));
		// El fallo ya está contado: es el intento reservado.
		if (badPin) return badPin;
		await tenantQuery(c, (db) => q.throttleReset(db, datos.id_usuario, reserva.bloqueadoHastaMs));
	}
	const ok = await tenantQuery(c, (db) =>
		q.loginOk(db, datos.id_usuario),
	);
	return c.json(ok);
});

loginRoutes.get("/:id/punch-status", async (c) => {
	const id = parseId(c.req.param("id"));
	if (id == null) return badRequest(c, "id_usuario_invalido");
	return c.json(await tenantQuery(c, (db) => q.punchStatus(db, id)));
});

loginRoutes.post("/turno-partido", cuerpo(S.setTurnoPartidoSchema), async (c) => {
	const datos = c.req.valid("json");
	const cambiados = await apply(c, cmd.setTurnoPartido(datos));
    if (Number(cambiados) === 0) {
        return c.json({ ok: false, code: "conflict", error: "No puedes quitar el turno partido: ya hay un segundo tramo registrado" }, 409);
    }
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

// Subida del setup inicial Main -> nube. Escritura DIRECTA en la base (sin hub), porque la Main
// no está conectada por WebSocket; el hub la rechazaría con `main_offline`. Deja la nube con
// las credenciales reales del admin para que el login de la Handy funcione.
loginRoutes.post(
	"/sync-initial-setup",
	soloLaMain("forbidden_not_tpv", 403),
	cuerpo(S.syncInitialSetupSchema),
	async (c) => {
		const datos = c.req.valid("json");

		const passwordHash = await hashPin(datos.pin);

		await tenantQuery(c, (db) =>
			q.applyInitialSetupDirect(db, {
				idUsuario: datos.id_usuario,
				passwordHash,
			}),
		);

		return c.json({ ok: true });
	},
);

// ── Recuperar el PIN de un administrador (LOGIN-07) ─────────────────────────────────────────
// Sólo desde la Main: el PIN que se recupera vive en su base local, y que la petición vaya firmada
// con la clave de ESE equipo es la mitad de la prueba (la otra mitad es el buzón). La lógica y sus
// porqués están en `recuperarPin.ts`.

// Es el MIDDLEWARE compartido y no una comprobacion dentro del handler: tiene que decidir antes de
// que `cuerpo(...)` --que tambien es middleware-- lea y valide el cuerpo, o una Handy se llevaria un
// 400 describiendole el schema en vez de su 403 (ARQ-06). El `message` ya no se escribe aqui: sale
// de `MENSAJES` por `completarErrores`, que es donde viven las frases.
const soloLaMainRecupera = soloLaMain("recuperacion_solo_en_main", 403);

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

loginRoutes.post(
	"/recuperar-pin/solicitar",
	soloLaMainRecupera,
	cuerpo(S.solicitarCodigoPinSchema),
	async (c) => {
		const datos = c.req.valid("json");

		const db = getDb(c.env);

		const r = await solicitarCodigoPin(db, c.env, {
			tenantId: c.get("tenantId"),
			deviceId: c.get("deviceId"),
			licHash: c.get("licHash"),
			idUsuario: datos.id_usuario,
			ahora: Date.now(),
		});
		return c.json(r.body, r.status);
	},
);

loginRoutes.post(
	"/recuperar-pin/verificar",
	soloLaMainRecupera,
	cuerpo(S.verificarCodigoPinSchema),
	async (c) => {
		const datos = c.req.valid("json");

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
	},
);

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

loginRoutes.post("/correo-recuperacion/estado", soloLaMainRecupera, async (c) => {
	const db = getDb(c.env);

	const r = await estadoCorreoRecuperacion(db, contextoCorreo(c));
	return c.json(r.body, r.status);
});

loginRoutes.post(
	"/correo-recuperacion/solicitar",
	soloLaMainRecupera,
	cuerpo(S.solicitarCambioCorreoSchema),
	async (c) => {
		const datos = c.req.valid("json");

		const db = getDb(c.env);

		const r = await solicitarCambioCorreo(db, c.env, { ...contextoCorreo(c), correo: datos.correo });
		return c.json(r.body, r.status);
	},
);

loginRoutes.post(
	"/correo-recuperacion/confirmar",
	soloLaMainRecupera,
	cuerpo(S.confirmarCambioCorreoSchema),
	async (c) => {
		const datos = c.req.valid("json");

		const db = getDb(c.env);

		const r = await confirmarCambioCorreo(
			db,
			c.env,
			{ ...contextoCorreo(c), codigo: datos.codigo },
			diferirEn(c),
		);
		return c.json(r.body, r.status);
	},
);

loginRoutes.post("/correo-recuperacion/usar-el-de-la-compra", soloLaMainRecupera, async (c) => {
	const db = getDb(c.env);

	const r = await usarCorreoDeLaCompra(db, c.env, contextoCorreo(c), diferirEn(c));
	return c.json(r.body, r.status);
});

loginRoutes.post("/punch", cuerpo(S.punchSchema), async (c) => {
	const datos = c.req.valid("json");
	const record = await tenantQuery(c, (db) =>
		q.getLoginRecord(db, datos.id_usuario),
	);
	if (!record) return c.json({ error: "Usuario no encontrado" }, 404);
	if (!entraSinPin(record)) {
		// LOGIN-01: el fichaje también verifica PIN → mismo throttle anti brute-force, con el
		// intento reservado antes de verificar (AUD-05).
		const reserva = await tenantQuery(c, (db) =>
			q.reservarIntento(db, datos.id_usuario),
		);
		if (!reserva.concedido) {
			return c.json({ error: `Demasiados intentos fallidos. Prueba de nuevo en ${reserva.segundos} s.` }, 429);
		}
		const badPin = await ensurePin(c, datos.pin, String(record.password_hash));
		// El fallo ya está contado: es el intento reservado.
		if (badPin) return badPin;
		await tenantQuery(c, (db) => q.throttleReset(db, datos.id_usuario, reserva.bloqueadoHastaMs));
	}

	// La fecha del fichaje. Sale de una consulta (`date('now','localtime')`) que `tenantQuery`
	// resuelve con la hora local de quien ficha (REV-03), que es la MISMA con la que el Durable
	// Object fija la `Hora_Entrada` de la fila. Antes la ponía la base, que corre en UTC: a las 00:30
	// se guardaba un fichaje fechado ayer con una hora de hoy — una fila que se contradice a sí
	// misma y que viaja así a la Main, al registro de jornada.
	//
	// TRAB-02, el control horario ha de ser VERAZ: por eso la petición ya **no lleva** fecha ni hora
	// — las llevó, y nadie las leía. Un valor del cuerpo es cualquier cosa; `X-Client-Now` es el
	// reloj del equipo que ficha, el mismo que en la Main escribe el fichaje, y llega con su
	// guardia de deriva.
	//
	// RI-05: la fecha del estado que se devuelve es la de la jornada fichada. Una entrada abre la de
	// hoy; una salida cierra la jornada en curso, que en un turno de noche empezó ayer.
	let fecha: string;
	if (datos.tipo === "entrada") {
		fecha = await tenantQuery(c, (db) => q.hoy(db));
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
		const open = await tenantQuery(c, (db) => q.getOpenPunch(db, datos.id_usuario));
		if (!open) {
			return c.json({ error: "No hay fichaje abierto para cerrar (primero ficha entrada)." }, 409);
		}
		fecha = open.fecha;
		await apply(
			c,
			cmd.punchSalida({
				id_usuario: datos.id_usuario,
				id_fichaje: open.id_fichaje,
			}),
		);
	}

	return c.json(
		await tenantQuery(c, (db) =>
			q.punchStatusForDate(db, datos.id_usuario, fecha),
		),
	);
});
