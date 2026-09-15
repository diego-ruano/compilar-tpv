// src/domains/login/recuperarPin.ts
//
// Recuperar el PIN de un administrador por correo (LOGIN-07).
//
// Es un código de 6 dígitos que llega al correo de recuperación del negocio y se escribe EN EL TPV:
//
//   1. La Main pide el código (`/v1/login/recuperar-pin/solicitar`). El tenant sale del token
//      firmado —nunca del cuerpo— y el correo, del de recuperación de ESE tenant (el de la compra si
//      nadie lo ha cambiado, ver `correoRecuperacion.ts`).
//   2. La Main manda el código (`/v1/login/recuperar-pin/verificar`). Si vale se consume, y es la
//      Main quien escribe el PIN nuevo en su base local; de ahí sube por el outbox como cualquier
//      otra escritura.
//
// Las reglas del código (HMAC, intentos, caducidad, tope de envíos) están en `codigosPorCorreo.ts`.
// Las propias de esto:
//
//   · El PIN nuevo NUNCA pasa por aquí. La nube sólo dice si el código vale. Si el PIN se fijara
//     arriba habría un sitio en internet desde el que cambiarlo, y tendría que bajar a una Main que
//     puede no estar conectada.
//   · Hacen falta DOS cosas a la vez: el buzón y estar delante de la Main, porque la petición va
//     firmada con la clave de ese equipo. Quien entre en el correo desde casa no puede hacer nada.
//   · No hay enlace, a propósito. Los filtros de correo (Outlook, antivirus) abren los enlaces antes
//     que la persona y gastarían uno de un solo uso; y un enlace se abre en cualquier sitio, que es
//     justo la segunda prueba que se perdería.
//   · Quién es administrador lo decide la Main (su base local manda en el login) y el worker sólo
//     comprueba que quien pide ES una Main. El correo va siempre al del negocio, así que un id de
//     usuario inventado sólo puede molestar al propio titular.

import type { Client } from "@libsql/client/web";

import type { Env } from "../../env";
import { getLicenseByHash, type EmailCodeKey } from "../../server/licenseStore";
import { sendPinChangedNoticeEmail, sendPinRecoveryCodeEmail } from "../licensing/licenseEmails";
import { emailHint } from "../licensing/licensing.helpers";
import {
	anularCodigo,
	comprobarCodigo,
	emitirCodigo,
	fallo,
	type RespuestaCodigo,
} from "./codigosPorCorreo";
import { correoDeRecuperacion } from "./correoRecuperacion";

export type ContextoRecuperacion = {
	tenantId: string;
	deviceId: string;
	/** Claim del token: identifica la licencia exacta de este equipo. */
	licHash: string;
	idUsuario: string;
	ahora: number;
};

function clave(ctx: ContextoRecuperacion): EmailCodeKey {
	return { tenantId: ctx.tenantId, deviceId: ctx.deviceId, purpose: "recuperar_pin" };
}

export async function solicitarCodigoPin(
	db: Client,
	env: Env,
	ctx: ContextoRecuperacion,
): Promise<RespuestaCodigo> {
	const lic = await getLicenseByHash(db, ctx.licHash);
	// La licencia tiene que ser la de este tenant: el token las ata, pero el correo de otro
	// negocio es lo último que se puede mandar por error.
	if (!lic || lic.tenant_id !== ctx.tenantId) {
		return fallo(404, "license_not_found", "No se encuentra la licencia de este equipo.", "license_not_found");
	}

	const correo = await correoDeRecuperacion(db, lic);
	if (!correo) {
		return fallo(404, "sin_correo", "La licencia no tiene un correo al que enviar el código.");
	}

	const emitido = await emitirCodigo(db, env, clave(ctx), ctx.idUsuario, ctx.ahora);
	if (!emitido.ok) return emitido.respuesta;

	// Se espera al envío, a diferencia del cambio de equipo: aquí quien pide está autenticado,
	// así que no hay nada que esconder, y decirle «revisa tu correo» cuando no ha salido
	// ninguno le deja esperando algo que no va a llegar.
	const enviado = await sendPinRecoveryCodeEmail(env, {
		to: correo,
		code: emitido.codigo,
		minutes: emitido.minutos,
	});
	if (!enviado) {
		await anularCodigo(db, clave(ctx), ctx.ahora);
		return fallo(
			502,
			"correo_no_enviado",
			"No se ha podido enviar el correo. Inténtalo de nuevo en unos minutos.",
			"external",
		);
	}

	return { status: 200, body: { ok: true, emailHint: emailHint(correo), minutos: emitido.minutos } };
}

export async function verificarCodigoPin(
	db: Client,
	env: Env,
	ctx: ContextoRecuperacion & { codigo: string },
	/** Para el aviso al titular, que no puede retener la respuesta (`waitUntil` en la ruta). */
	diferir: (p: Promise<unknown>) => void,
): Promise<RespuestaCodigo> {
	const comprobado = await comprobarCodigo(
		db,
		env,
		clave(ctx),
		ctx.codigo,
		ctx.ahora,
		ctx.idUsuario,
	);
	if (!comprobado.ok) return comprobado.respuesta;

	// Aviso al negocio: si no ha sido él, que se entere hoy. Es entrega, no autorización, así que
	// no retiene la respuesta ni la hace fallar.
	const lic = await getLicenseByHash(db, ctx.licHash);
	const correo = lic ? await correoDeRecuperacion(db, lic) : "";
	if (correo) diferir(sendPinChangedNoticeEmail(env, { to: correo }));

	return { status: 200, body: { ok: true } };
}
