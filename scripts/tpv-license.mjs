#!/usr/bin/env node
//
// CLI de administración de licencias. Habla con los endpoints /v1/admin/* del worker `tpv-api`.
//
//   pnpm license:issue  -- --term 12 --email cliente@bar.com --name "Bar La Plaza" [--send-key]
//   pnpm license:list   -- [--limit 50]
//   pnpm license:revoke   -- --id <licenseId>
//   pnpm license:unrevoke -- --id <licenseId>          (deshace una revocacion)
//   pnpm license:extend   -- --id <licenseId> --months 12
//   pnpm license:shorten  -- --id <licenseId> --months 24   (puede dejarla CADUCADA)
//   pnpm license:resend -- --id <licenseId>          (reenvía/recupera la clave por email)
//
// El token NO se versiona. Se lee, por este orden:
//   1. La variable de entorno ADMIN_API_TOKEN (si está puesta).
//   2. Un fichero `.env` en la raíz del repo (gitignoreado) con la línea:
//        ADMIN_API_TOKEN=tu-token
//      Igual para TPV_API_BASE si quieres apuntar a otro host (p. ej. wrangler dev).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Carga un `.env` sencillo (KEY=VALUE por línea, admite comillas y # comentarios) SIN dependencias.
// Lo real del entorno tiene prioridad: el fichero solo rellena lo que falte.
function loadDotEnv() {
	const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
	const file = path.join(root, ".env");
	let txt;
	try {
		txt = fs.readFileSync(file, "utf8");
	} catch {
		return; // sin .env: se usa el entorno tal cual
	}
	for (const raw of txt.split(/\r?\n/)) {
		const line = raw.trim();
		if (!line || line.startsWith("#")) continue;
		const eq = line.indexOf("=");
		if (eq === -1) continue;
		const key = line.slice(0, eq).trim();
		const val = line.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
		if (key && process.env[key] === undefined) process.env[key] = val;
	}
}

loadDotEnv();

const API_BASE = process.env.TPV_API_BASE || "https://tpv-api.altarialights.workers.dev";
const TOKEN = process.env.ADMIN_API_TOKEN;

const TERMS = [1, 3, 12];

function parseArgs(argv) {
	const out = {};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (!a.startsWith("--")) continue;
		const key = a.slice(2);
		const next = argv[i + 1];
		if (!next || next.startsWith("--")) {
			out[key] = true; // flag booleano (--send-key)
		} else {
			out[key] = next;
			i++;
		}
	}
	return out;
}

function fail(msg) {
	console.error(`\n  ✖ ${msg}\n`);
	process.exit(1);
}

async function api(method, path, body) {
	const r = await fetch(`${API_BASE}${path}`, {
		method,
		headers: {
			authorization: `Bearer ${TOKEN}`,
			...(body ? { "content-type": "application/json" } : {}),
		},
		...(body ? { body: JSON.stringify(body) } : {}),
	});

	const text = await r.text();
	let data;
	try {
		data = JSON.parse(text);
	} catch {
		fail(`Respuesta no-JSON del worker (${r.status}): ${text.slice(0, 200)}`);
	}

	if (!r.ok || data.ok === false) {
		if (r.status === 401) fail("Token rechazado. ¿ADMIN_API_TOKEN es el correcto?");
		if (r.status === 503) fail("El worker no tiene ADMIN_API_TOKEN configurado (wrangler secret put).");
		fail(`${r.status}: ${data.error || text}`);
	}

	return data;
}

function requireTerm(value, flag) {
	const n = Number(value);
	if (!TERMS.includes(n)) fail(`--${flag} debe ser uno de: ${TERMS.join(", ")}`);
	return n;
}

/* ── Comandos ────────────────────────────────────────────────────────────── */

async function issue(args) {
	const term = requireTerm(args.term, "term");
	const email = String(args.email || "").trim();
	if (!email.includes("@")) fail("--email es obligatorio (es por donde el cliente recupera la licencia)");

	const res = await api("POST", "/v1/admin/licenses", {
		termMonths: term,
		email,
		name: args.name ? String(args.name) : undefined,
		sendKey: Boolean(args["send-key"]),
	});

	console.log(`
  ✔ Licencia emitida

    Clave        ${res.key}
    Duración     ${term} ${term === 1 ? "mes" : "meses"}
    Cliente      ${res.email}
    licenseId    ${res.licenseId}
    Email        ${res.emailSent === null ? "no enviado (--send-key para mandárselo)" : res.emailSent ? "enviado ✔" : "FALLÓ el envío ✖ (la licencia SÍ existe)"}

  La clave solo se muestra AQUÍ y AHORA: en la base de datos queda cifrada.
`);
}

async function list(args) {
	const limit = Number(args.limit || 50);
	const res = await api("GET", `/v1/admin/licenses?limit=${limit}`);

	if (!res.licenses.length) {
		console.log("\n  (no hay licencias)\n");
		return;
	}

	console.table(
		res.licenses.map((l) => ({
			clave: l.keyShort,
			estado: l.disabled ? "revocada" : l.status,
			meses: l.termMonths,
			origen: l.origin,
			cliente: l.customerEmail,
			correo: l.keyEmailSentAt ? "enviado" : "PENDIENTE",
			caduca: l.expiresAt ? l.expiresAt.slice(0, 10) : "— (sin activar)",
			licenseId: l.licenseId,
		})),
	);
}

async function resend(args) {
	const id = String(args.id || "").trim();
	if (!id) fail("--id <licenseId> requerido (sácalo de `pnpm license:list`)");

	const res = await api("POST", `/v1/admin/licenses/${id}/resend-key`);

	console.log(`
  ✔ Clave recuperada${res.emailSent ? " y reenviada" : ""}

    Clave        ${res.key}
    Cliente      ${res.email}
    Email        ${res.emailSent ? "enviado ✔" : "FALLÓ el envío ✖ (la clave está arriba: pásasela tú)"}

  Dásela al cliente. Sigue guardada cifrada en la base de datos.
`);
}

async function revoke(args) {
	const id = String(args.id || "").trim();
	if (!id) fail("--id <licenseId> requerido (sácalo de `pnpm license:list`)");

	await api("POST", `/v1/admin/licenses/${id}/revoke`);
	console.log(`\n  ✔ Licencia ${id} revocada. El TPV se bloqueará en su próxima comprobación.\n`);
}

async function unrevoke(args) {
	const id = String(args.id || "").trim();
	if (!id) fail("--id <licenseId> requerido (sacalo de `pnpm license:list`)");

	const res = await api("POST", `/v1/admin/licenses/${id}/unrevoke`);
	console.log(`
  ✔ Licencia ${id} vuelve a estar ${res.status}. El TPV se desbloquea en su siguiente comprobacion.
`);
}

/**
 * Resta meses a la caducidad. Puede dejarla en el pasado, que es exactamente "caducada".
 *
 * Es la unica forma de ensayar que hace la aplicacion cuando a un cliente se le acaba la licencia
 * sin esperar meses de calendario; tambien sirve para corregir a mano un `extend` de mas.
 */
async function shorten(args) {
	const id = String(args.id || "").trim();
	if (!id) fail("--id <licenseId> requerido");
	const months = Number(args.months);
	if (!Number.isInteger(months) || months < 1 || months > 120) {
		fail("--months debe ser un entero de 1 a 120");
	}

	const res = await api("POST", `/v1/admin/licenses/${id}/shorten`, { months });
	console.log(
		`
  ✔ Caducidad movida al ${res.expiresAt.slice(0, 10)}` +
			`${res.caducada ? "  — la licencia queda CADUCADA" : ""}
`,
	);
}

async function extend(args) {
	const id = String(args.id || "").trim();
	if (!id) fail("--id <licenseId> requerido");
	const months = requireTerm(args.months, "months");

	const res = await api("POST", `/v1/admin/licenses/${id}/extend`, { months });
	console.log(`\n  ✔ Licencia extendida. Ahora caduca el ${res.expiresAt.slice(0, 10)}.\n`);
}

/* ── Entrada ─────────────────────────────────────────────────────────────── */

const [cmd, ...rest] = process.argv.slice(2);
const args = parseArgs(rest);

if (!TOKEN) {
	fail(
		'Falta ADMIN_API_TOKEN. Ponlo en un fichero .env en la raiz del repo:\n' +
			'    ADMIN_API_TOKEN=tu-token\n' +
			'  (o como variable de entorno: $env:ADMIN_API_TOKEN = "…" en PowerShell)',
	);
}

const comandos = { issue, list, revoke, unrevoke, extend, shorten, resend };

if (!comandos[cmd]) {
	console.error(`
  Uso: pnpm license:<comando> -- [opciones]

    issue   --term 1|3|12 --email <email> [--name "Bar La Plaza"] [--send-key]
    list    [--limit 50]
    revoke   --id <licenseId>
    unrevoke --id <licenseId>
    extend   --id <licenseId> --months 1|3|12
    shorten  --id <licenseId> --months <1-120>   (puede dejarla CADUCADA)
    resend  --id <licenseId>
`);
	process.exit(1);
}

comandos[cmd](args).catch((e) => fail(String(e?.message || e)));
