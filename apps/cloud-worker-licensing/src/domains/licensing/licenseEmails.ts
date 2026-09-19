// src/domains/licensing/licenseEmails.ts
//
// Los correos del ciclo de vida de una licencia, más los de recuperar el PIN de un administrador
// (LOGIN-07), que van al mismo buzón: el del titular. Backend: Cloudflare Email Service (binding
// `EMAIL`), el mismo que usa el envío de pedidos a proveedores — sin claves de API.
//
// Ninguno de estos envíos puede tumbar la operación que los dispara: si el correo falla, se
// registra y se sigue. Emitir una licencia y cobrarla es lo importante; el email es entrega.

import type { Env } from "../../env";

type Enviar = {
	to: string;
	subject: string;
	html: string;
	text: string;
};

async function enviar(env: Env, msg: Enviar): Promise<boolean> {
	const fromAddress = String(env.EMAIL_FROM_ADDRESS || "").trim();
	if (!fromAddress) {
		console.error("[license-email] falta EMAIL_FROM_ADDRESS");
		return false;
	}

	try {
		await env.EMAIL.send({
			from: { email: fromAddress, name: env.EMAIL_FROM_NAME || "TPV" },
			to: msg.to,
			subject: msg.subject,
			html: msg.html,
			text: msg.text,
		});
		return true;
	} catch (err) {
		const e = err as { code?: string; message?: string };
		console.error("[license-email] envío fallido:", msg.subject, e.code ?? "", e.message ?? err);
		return false;
	}
}

function layout(titulo: string, cuerpo: string): string {
	return `<!DOCTYPE html>
<html lang="es">
<head><meta charset="utf-8"><title>${esc(titulo)}</title></head>
<body style="font-family:system-ui,sans-serif;max-width:600px;margin:0 auto;padding:24px;color:#111827">
  <h2 style="color:#111827;margin-bottom:16px">${esc(titulo)}</h2>
  ${cuerpo}
  <p style="margin-top:24px;font-size:12px;color:#9ca3af">TPV · Altaria Lights</p>
</body>
</html>`;
}

function destacado(valor: string): string {
	return `<p style="margin:20px 0;padding:16px;background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;
    font-family:ui-monospace,monospace;font-size:22px;font-weight:700;letter-spacing:2px;text-align:center">
    ${esc(valor)}</p>`;
}

function esc(s: string): string {
	return String(s)
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

function meses(n: number): string {
	return n === 1 ? "1 mes" : n === 12 ? "1 año" : `${n} meses`;
}

/* ============================================================
   1. La clave de licencia (compra en Stripe o alta manual)
============================================================ */

export async function sendLicenseKeyEmail(
	env: Env,
	args: { to: string; name?: string | null; key: string; termMonths: number },
): Promise<boolean> {
	const saludo = args.name?.trim() ? `Hola, ${args.name.trim()}:` : "Hola:";

	const html = layout(
		"Tu licencia del TPV",
		`<p>${esc(saludo)}</p>
     <p>Esta es tu clave de licencia (${esc(meses(args.termMonths))}). Introdúcela en el TPV al abrirlo por primera vez:</p>
     ${destacado(args.key)}
     <p style="font-size:14px;color:#6b7280">La cuenta atrás empieza <strong>al activarla</strong>, no hoy: puedes
     guardarla y activar el TPV cuando lo tengas montado.</p>
     <p style="font-size:14px;color:#6b7280">Guarda este correo. Es también el buzón desde el que podrás recuperar la
     licencia si algún día cambias de ordenador.</p>`,
	);

	const text = `${saludo}

Tu clave de licencia del TPV (${meses(args.termMonths)}):

    ${args.key}

Introdúcela en el TPV al abrirlo por primera vez. La cuenta atrás empieza al activarla, no hoy.

Guarda este correo: es también el buzón desde el que podrás recuperar la licencia si cambias de ordenador.`;

	return enviar(env, { to: args.to, subject: "Tu licencia del TPV", html, text });
}

/* ============================================================
   1.b Renovación (el cliente ya tenía licencia: se extiende, no se emite otra)
============================================================ */

export async function sendLicenseRenewedEmail(
	env: Env,
	args: { to: string; name?: string | null; termMonths: number; expiresAtMs: number },
): Promise<boolean> {
	const saludo = args.name?.trim() ? `Hola, ${args.name.trim()}:` : "Hola:";
	const hasta = new Date(args.expiresAtMs).toLocaleDateString("es-ES", {
		day: "numeric",
		month: "long",
		year: "numeric",
		timeZone: "Europe/Madrid",
	});

	const html = layout(
		"Licencia renovada",
		`<p>${esc(saludo)}</p>
     <p>Hemos añadido ${esc(meses(args.termMonths))} a tu licencia. Ya está activa hasta el
     <strong>${esc(hasta)}</strong>.</p>
     <p style="font-size:14px;color:#6b7280">No tienes que hacer nada: tu TPV lo detectará solo la próxima vez que
     compruebe la licencia. La misma clave sigue valiendo.</p>`,
	);

	const text = `${saludo}

Hemos añadido ${meses(args.termMonths)} a tu licencia. Ya está activa hasta el ${hasta}.

No tienes que hacer nada: tu TPV lo detectará solo. La misma clave sigue valiendo.`;

	return enviar(env, { to: args.to, subject: "Licencia renovada", html, text });
}

/* ============================================================
   1.c Aviso de caducidad (REV-13): el único sitio del que sale el enlace de renovación
============================================================ */

/**
 * «Tu licencia caduca el X, renuévala aquí».
 *
 * El enlace **no se compone aquí**: llega hecho desde `avisosDeCaducidad.ts`, con el `license_id`
 * dentro. Es lo que hace que la compra que venga detrás se reconozca como una renovación de ESTA
 * licencia y no como un alta — o sea, lo que impide que el cliente acabe con una clave nueva que
 * tendría que teclear en un TPV que ya funciona.
 *
 * No se menciona la clave de licencia ni se repite: renovar no la cambia, y enseñarla en un correo
 * de recordatorio es repartirla sin motivo.
 */
export async function sendLicenseExpiringEmail(
	env: Env,
	args: {
		to: string;
		name?: string | null;
		expiresAtMs: number;
		diasRestantes: number;
		enlace: string;
	},
): Promise<boolean> {
	const saludo = args.name?.trim() ? `Hola, ${args.name.trim()}:` : "Hola:";
	const hasta = new Date(args.expiresAtMs).toLocaleDateString("es-ES", {
		day: "numeric",
		month: "long",
		year: "numeric",
		timeZone: "Europe/Madrid",
	});
	const cuanto = args.diasRestantes === 1 ? "mañana" : `en ${args.diasRestantes} días`;

	const html = layout(
		"Tu licencia caduca pronto",
		`<p>${esc(saludo)}</p>
     <p>Tu licencia del TPV caduca <strong>${esc(cuanto)}</strong>, el <strong>${esc(hasta)}</strong>.</p>
     <p style="margin:24px 0;text-align:center">
       <a href="${esc(args.enlace)}" style="display:inline-block;padding:12px 24px;background:#111827;color:#ffffff;
          text-decoration:none;border-radius:8px;font-weight:600">Renovar mi licencia</a>
     </p>
     <p style="font-size:14px;color:#6b7280">Renueva desde ese botón y se alargará la licencia que ya tienes:
     <strong>no hace falta cambiar ninguna clave</strong> ni tocar el TPV. Si compras por otro sitio se te
     emitirá una licencia distinta, que es lo que querrás sólo si estás abriendo otro local.</p>
     <p style="font-size:14px;color:#6b7280">Si la dejas caducar, el TPV deja de poder usarse hasta que la
     renueves. Tus datos no se pierden.</p>`,
	);

	const text = `${saludo}

Tu licencia del TPV caduca ${cuanto}, el ${hasta}.

Renuévala aquí: ${args.enlace}

Desde ese enlace se alarga la licencia que ya tienes: no hace falta cambiar ninguna clave ni tocar el TPV.
Si compras por otro sitio se te emitirá una licencia distinta, que es lo que querrás sólo si estás abriendo
otro local.

Si la dejas caducar, el TPV deja de poder usarse hasta que la renueves. Tus datos no se pierden.`;

	return enviar(env, { to: args.to, subject: `Tu licencia del TPV caduca ${cuanto}`, html, text });
}

/* ============================================================
   2. Código de cambio de dispositivo (OTP)
============================================================ */

export async function sendDeviceChangeCodeEmail(
	env: Env,
	args: { to: string; code: string; minutes: number },
): Promise<boolean> {
	const html = layout(
		"Código para activar tu TPV en otro equipo",
		`<p>Alguien (esperamos que tú) está activando tu licencia en un ordenador nuevo. Introduce este código para confirmarlo:</p>
     ${destacado(args.code)}
     <p style="font-size:14px;color:#6b7280">Caduca en ${args.minutes} minutos y solo sirve para ese equipo.</p>
     <p style="font-size:14px;color:#b91c1c"><strong>¿No has sido tú?</strong> No lo compartas con nadie y responde a este
     correo: alguien tiene tu clave de licencia.</p>`,
	);

	const text = `Código para activar tu TPV en otro equipo:

    ${args.code}

Caduca en ${args.minutes} minutos y solo sirve para ese equipo.

¿No has sido tú? No compartas el código y responde a este correo: alguien tiene tu clave de licencia.`;

	return enviar(env, {
		to: args.to,
		subject: "Código para activar tu TPV en otro equipo",
		html,
		text,
	});
}

/* ============================================================
   3. Aviso: la licencia se movió a otro equipo (detección de abuso)
============================================================ */

export async function sendDeviceChangedNoticeEmail(
	env: Env,
	args: { to: string },
): Promise<boolean> {
	const html = layout(
		"Tu TPV se ha activado en un equipo nuevo",
		`<p>Tu licencia acaba de activarse en un ordenador distinto. El equipo anterior ha dejado de tener acceso.</p>
     <p style="font-size:14px;color:#b91c1c"><strong>¿No has sido tú?</strong> Responde a este correo cuanto antes:
     bloquearemos la licencia y te emitiremos una nueva.</p>`,
	);

	const text = `Tu licencia del TPV acaba de activarse en un ordenador distinto. El equipo anterior ha dejado de tener acceso.

¿No has sido tú? Responde a este correo cuanto antes: bloquearemos la licencia y te emitiremos una nueva.`;

	return enviar(env, {
		to: args.to,
		subject: "Tu TPV se ha activado en un equipo nuevo",
		html,
		text,
	});
}

/* ============================================================
   4. Recuperar el PIN de un administrador (LOGIN-07)
============================================================ */

export async function sendPinRecoveryCodeEmail(
	env: Env,
	args: { to: string; code: string; minutes: number },
): Promise<boolean> {
	const html = layout(
		"Código para recuperar el PIN del TPV",
		`<p>Alguien (esperamos que tú) ha pedido desde tu TPV recuperar el PIN de un administrador. Escribe este código en la pantalla del TPV:</p>
     ${destacado(args.code)}
     <p style="font-size:14px;color:#6b7280">Caduca en ${args.minutes} minutos y solo sirve en el TPV desde el que se pidió.</p>
     <p style="font-size:14px;color:#b91c1c"><strong>¿No lo has pedido tú?</strong> No lo compartas con nadie: sin este código
     no se puede cambiar el PIN. Si te siguen llegando, alguien está intentándolo desde tu TPV.</p>`,
	);

	const text = `Código para recuperar el PIN del TPV:

    ${args.code}

Escríbelo en la pantalla del TPV. Caduca en ${args.minutes} minutos y solo sirve en el TPV desde el que se pidió.

¿No lo has pedido tú? No lo compartas con nadie: sin este código no se puede cambiar el PIN.`;

	return enviar(env, {
		to: args.to,
		subject: "Código para recuperar el PIN del TPV",
		html,
		text,
	});
}

export async function sendPinChangedNoticeEmail(
	env: Env,
	args: { to: string },
): Promise<boolean> {
	const html = layout(
		"Se ha cambiado el PIN de un administrador",
		`<p>Se acaba de usar un código enviado a este correo para cambiar el PIN de un administrador de tu TPV.</p>
     <p style="font-size:14px;color:#b91c1c"><strong>¿No has sido tú?</strong> Responde a este correo cuanto antes.</p>`,
	);

	const text = `Se acaba de usar un código enviado a este correo para cambiar el PIN de un administrador de tu TPV.

¿No has sido tú? Responde a este correo cuanto antes.`;

	return enviar(env, {
		to: args.to,
		subject: "Se ha cambiado el PIN de un administrador",
		html,
		text,
	});
}

/* ============================================================
   5. Correo de recuperación (LOGIN-08)
============================================================ */

export async function sendRecoveryEmailCodeEmail(
	env: Env,
	args: { to: string; code: string; minutes: number },
): Promise<boolean> {
	const html = layout(
		"Confirma el correo de recuperación del TPV",
		`<p>Se ha pedido desde un TPV que los códigos para recuperar el PIN de sus administradores lleguen a este correo. Escribe este código en el TPV para confirmarlo:</p>
     ${destacado(args.code)}
     <p style="font-size:14px;color:#6b7280">Caduca en ${args.minutes} minutos.</p>
     <p style="font-size:14px;color:#6b7280">Si no lo has pedido tú, ignora este correo: no cambiará nada.</p>`,
	);

	const text = `Código para confirmar el correo de recuperación del TPV:

    ${args.code}

Escríbelo en el TPV. Caduca en ${args.minutes} minutos.

Si no lo has pedido tú, ignora este correo: no cambiará nada.`;

	return enviar(env, {
		to: args.to,
		subject: "Confirma el correo de recuperación del TPV",
		html,
		text,
	});
}

export async function sendRecoveryEmailChangedNoticeEmail(
	env: Env,
	args: { to: string; nuevoHint: string },
): Promise<boolean> {
	const html = layout(
		"Ha cambiado el correo de recuperación de tu TPV",
		`<p>A partir de ahora, los códigos para recuperar el PIN de un administrador de tu TPV llegarán a
     <strong>${esc(args.nuevoHint)}</strong>.</p>
     <p style="font-size:14px;color:#6b7280">El traslado de la licencia a otro equipo sigue usando el correo de la compra.</p>
     <p style="font-size:14px;color:#b91c1c"><strong>¿No has sido tú?</strong> Responde a este correo cuanto antes.</p>`,
	);

	const text = `A partir de ahora, los códigos para recuperar el PIN de un administrador de tu TPV llegarán a ${args.nuevoHint}.

El traslado de la licencia a otro equipo sigue usando el correo de la compra.

¿No has sido tú? Responde a este correo cuanto antes.`;

	return enviar(env, {
		to: args.to,
		subject: "Ha cambiado el correo de recuperación de tu TPV",
		html,
		text,
	});
}
