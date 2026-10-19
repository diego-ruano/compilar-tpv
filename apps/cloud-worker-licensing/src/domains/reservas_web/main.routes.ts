// src/domains/reservas_web/main.routes.ts
//
// Reservas desde la web (docs/estudios/reservas-web.md): lo que pide la Main. Todo por `tenantAuth`
// y sólo la Main (la configuración y la entrega son suyas), salvo `/avisos`, que también manda la
// Handy cuando cambia una reserva web.
//
//   POST /v1/reservas-web/clave → { ok, clave, codigo }: la clave pública del negocio (la crea si
//   no tiene) y la línea que se pega en su web.
//   POST /v1/reservas-web/pendientes → { ok, peticiones, hay_mas }: lo que la agenda tiene para la
//   Main (altas y cancelaciones), que pasa a entregado.
//   POST /v1/reservas-web/recogidas { resultados } → { ok, apuntadas }: cómo le ha ido con cada una.
//   POST /v1/reservas-web/avisos { id_aviso, id_reserva, tipo, … } → { ok, enviado }: el correo al
//   cliente por un cambio del restaurante (§5.7). 404 si la reserva aún no está en la nube: quien
//   lo manda lo repite más tarde.
//
// La Main pide las pendientes al conectar, al terminar una recuperación y cuando el `TenantHub` le
// manda `{"type":"reservas_web"}` (docs/estudios/reservas-web.md §5.4).

import { Hono } from "hono";

import type { Env } from "../../env";
import { soloLaMain, tenantAuth, type TenantVars } from "../../middleware/tenant";
import { agendaDe } from "../../durableObjects/agendaWeb";
import { cuerpo } from "../../lib/validacion";
import { getDb } from "../../server/db";
import { claveDelNegocio, codigoParaLaWeb } from "./claves";
import { enviarCorreoReservaWeb, negocioDelCorreo } from "./correos";
import { avisoReservaWebSchema, recogidasSchema } from "./reservasWeb.schemas";
import { codigoDeReserva } from "../../durableObjects/agendaWeb.motor";
import { tenantQuery } from "../../lib/tenantClient";

type Ctx = { Bindings: Env; Variables: TenantVars };

export const reservasWebMainRoutes = new Hono<Ctx>();

reservasWebMainRoutes.use("*", tenantAuth);

reservasWebMainRoutes.post("/clave", soloLaMain("forbidden_not_tpv", 403), async (c) => {
	const clave = await claveDelNegocio(getDb(c.env), c.get("tenantId"), Date.now());
	// El widget se sirve desde este mismo worker: el origen de la petición es el suyo.
	const codigo = codigoParaLaWeb(new URL(c.req.url).origin, clave);
	return c.json({ ok: true, clave, codigo });
});

reservasWebMainRoutes.post("/pendientes", soloLaMain("forbidden_not_tpv", 403), async (c) => {
	const tenantId = c.get("tenantId");
	return c.json(await agendaDe(c.env, tenantId).pendientes({ tenantId }));
});

reservasWebMainRoutes.post(
	"/recogidas",
	soloLaMain("forbidden_not_tpv", 403),
	cuerpo(recogidasSchema),
	async (c) => {
		const tenantId = c.get("tenantId");
		const { resultados } = c.req.valid("json");
		return c.json(await agendaDe(c.env, tenantId).recogidas({ tenantId, resultados }));
	},
);

/**
 * El correo al cliente de una reserva web que el restaurante ha cambiado o cancelado. A quién lo
 * dice la nube, no el cuerpo: el cliente de esa reserva, y sólo si es una reserva web (acotado a
 * quién, como los pedidos con FABLE-C). Idempotente por `id_aviso`: repetirlo no manda otro.
 */
reservasWebMainRoutes.post("/avisos", cuerpo(avisoReservaWebSchema), async (c) => {
	const tenantId = c.get("tenantId");
	const aviso = c.req.valid("json");
	const leido = await tenantQuery(c, async (db) => {
		const rs = await db.execute({
			sql: `SELECT R.Origen AS origen, C.ID_Cliente AS id_cliente, NULLIF(TRIM(C.Email), '') AS email
			      FROM Reservas R LEFT JOIN Clientes C ON C.ID_Cliente = R.ID_Cliente
			      WHERE R.ID_Reserva = ?1;`,
			args: [aviso.id_reserva],
		});
		const r: any = rs.rows?.[0];
		return r
			? {
					origen: String(r.origen),
					idCliente: typeof r.id_cliente === "string" ? r.id_cliente : null,
					email: typeof r.email === "string" ? r.email : null,
					negocio: await negocioDelCorreo(db),
				}
			: null;
	});
	// Aún no ha subido (la Main lo hizo sin conexión, o su outbox va detrás): se repite más tarde.
	if (!leido) return c.json({ ok: false, error: "reserva_inexistente" }, 404);
	if (leido.origen !== "WEB") return c.json({ ok: false, error: "reserva_no_web" }, 409);
	// La nube aún tiene otro cliente en esa reserva (la Main lo cambió y no ha subido): escribirle al
	// de aquí sería contarle a otra persona la reserva. Se repite cuando esté al día.
	if (leido.idCliente !== aviso.id_cliente) return c.json({ ok: false, error: "reserva_no_al_dia" }, 404);
	// Sin correo no hay a quién decírselo: hecho.
	if (!leido.email) return c.json({ ok: true, enviado: false });

	const r = await enviarCorreoReservaWeb(c.env, {
		tenantId,
		id: `rw:aviso:${aviso.id_aviso}`,
		tipo: aviso.tipo === "modificada" ? "modificada" : "cancelada_restaurante",
		para: leido.email,
		negocio: leido.negocio,
		reserva: {
			dia: aviso.dia_ymd,
			hora: aviso.hora,
			personas: aviso.personas,
			mesa: aviso.mesa,
			codigo: codigoDeReserva(aviso.id_reserva),
		},
		dispositivo: c.get("deviceId"),
	});
	if (r === "tope") return c.json({ ok: false, error: "email_limite_diario" }, 429);
	// Lo intenta otra vez quien lo manda.
	if (r === "fallido") return c.json({ ok: false, error: "correo_no_enviado" }, 502);
	return c.json({ ok: true, enviado: true });
});
