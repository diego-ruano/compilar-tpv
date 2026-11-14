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
//   pnpm license:recifrar                             (termina una rotación de LICENSE_STORE_KEY, RI-73)
//
// Y los interruptores remotos de emergencia (PROD-06), que van por el mismo token:
//
//   pnpm interruptor:apagar   -- --nombre reparacion_nube --horas 2 --motivo "…"
//                                [--tenant <tenantId>] [--desde 1.4.0] [--hasta 1.4.2]
//   pnpm interruptor:encender -- --id <interruptorId>
//   pnpm interruptor:lista    -- [--historial]
//
// Y los bares piloto y la promoción de versiones de beta a estable (RI-30):
//
//   pnpm piloto:poner  -- --tenant <tenantId>      (recibe las versiones beta antes que nadie)
//   pnpm piloto:quitar -- --tenant <tenantId>
//   pnpm piloto:lista  -- [--todos]                 (--todos: todos los negocios, para ver su id)
//   pnpm release:lista
//   pnpm release:promocionar -- --version 1.4.0 [--target windows7] [--arch x86_64]
//
// Y la reserva desde la web (docs/estudios/reservas-web.md): las webs donde se puede incrustar el
// widget de un negocio, y su clave:
//
//   pnpm reservas-web:ver            -- --tenant <tenantId>
//   pnpm reservas-web:dominio-poner  -- --tenant <tenantId> --origen https://www.su-web.es
//   pnpm reservas-web:dominio-quitar -- --tenant <tenantId> --origen https://www.su-web.es
//   pnpm reservas-web:revocar-clave  -- --tenant <tenantId>
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
		fail(`${r.status}: ${data.error || text}${data.message ? ` — ${data.message}` : ""}`);
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

/* ── Interruptores (PROD-06) ─────────────────────────────────────────────── */

async function interruptorApagar(args) {
	const interruptor = String(args.nombre || "").trim();
	if (!interruptor) fail("--nombre <interruptor> requerido (p. ej. reparacion_nube)");
	const horas = Number(args.horas);
	if (!Number.isFinite(horas) || horas <= 0) fail("--horas debe ser un número mayor que 0");
	const motivo = String(args.motivo || "").trim();
	if (motivo.length < 3) fail('--motivo "…" requerido: es lo que se ve en la pantalla del bar');

	const res = await api("POST", "/v1/admin/interruptores", {
		interruptor,
		horas,
		motivo,
		...(args.tenant ? { tenantId: String(args.tenant) } : {}),
		...(args.desde ? { versionDesde: String(args.desde) } : {}),
		...(args.hasta ? { versionHasta: String(args.hasta) } : {}),
	});
	console.log(`
  ✔ ${res.interruptor} apagado para ${res.tenantId === "*" ? "TODOS los negocios" : res.tenantId}
    hasta ${res.expiresAt} (se enciende solo).

    Id  ${res.interruptorId}   (pnpm interruptor:encender -- --id ${res.interruptorId})

  Los TPV lo obedecen en unos 5 minutos; el worker (reservas_web), en menos de uno.
`);
}

async function interruptorEncender(args) {
	const id = String(args.id || "").trim();
	if (!id) fail("--id <interruptorId> requerido (sácalo de `pnpm interruptor:lista`)");
	await api("POST", `/v1/admin/interruptores/${id}/encender`);
	console.log(`\n  ✔ Encendido. Los TPV lo notan en unos 5 minutos.\n`);
}

async function interruptorLista(args) {
	const res = await api("GET", `/v1/admin/interruptores${args.historial ? "?historial=1" : ""}`);
	if (!res.interruptores.length) {
		console.log(args.historial ? "\n  (no hay historial)\n" : "\n  (todo encendido)\n");
		return;
	}
	console.table(
		res.interruptores.map((i) => ({
			interruptor: i.interruptor,
			negocio: i.tenantId,
			versiones: i.versionDesde || i.versionHasta ? `${i.versionDesde ?? "…"} – ${i.versionHasta ?? "…"}` : "todas",
			vigente: i.vigente ? "sí" : "no",
			hasta: i.expiresAt,
			motivo: i.motivo,
			id: i.interruptorId,
		})),
	);
}

/**
 * RI-73 · Termina una rotación de LICENSE_STORE_KEY: llama a la ruta hasta que no quede nada cifrado
 * con la clave anterior. Lo que no se deja descifrar con ninguna de las dos se lista para mirarlo a
 * mano. Procedimiento: docs/arquitectura/licencias.md («Rotar LICENSE_STORE_KEY»).
 */
async function recifrar() {
	const total = { licencias: 0, deks: 0, tokensTurso: 0 };
	const ilegibles = new Map();
	for (;;) {
		const r = await api("POST", "/v1/admin/store-key/recifrar");
		for (const k of Object.keys(total)) total[k] += r.recifrados[k] ?? 0;
		for (const i of r.ilegibles) ilegibles.set(`${i.tabla}:${i.id}`, i);
		const avanzo = Object.values(r.recifrados).some((n) => n > 0);
		// Los ilegibles vuelven a salir en cada llamada: si sólo quedan ellos, se para.
		if (!r.quedanMas || !avanzo) break;
	}
	console.log(
		`\n  ✔ Recifrado con la clave actual: ${total.licencias} claves de licencia, ${total.deks} DEK, ` +
			`${total.tokensTurso} tokens de Turso.`,
	);
	if (ilegibles.size) {
		console.log(`\n  ✖ ${ilegibles.size} no se dejan descifrar con ninguna clave configurada:`);
		console.table([...ilegibles.values()]);
		console.log("  No quites LICENSE_STORE_KEY_ANTERIOR hasta saber qué son.\n");
	} else {
		console.log("  Ya se puede quitar LICENSE_STORE_KEY_ANTERIOR (wrangler secret delete).\n");
	}
}

/* ── Bares piloto y promoción de versiones (RI-30) ───────────────────────── */

async function pilotoMarcar(args, piloto) {
	const tenantId = String(args.tenant || "").trim();
	if (!tenantId) fail("--tenant <tenantId> requerido (sácalo de `pnpm piloto:lista -- --todos`)");
	await api("POST", "/v1/admin/pilotos", { tenantId, piloto });
	console.log(
		piloto
			? `\n  ✔ ${tenantId} es bar piloto: recibe las versiones beta en su próxima comprobación.\n`
			: `\n  ✔ ${tenantId} ya no es bar piloto: vuelve al canal estable.\n`,
	);
}

async function pilotoLista(args) {
	const res = await api("GET", `/v1/admin/pilotos${args.todos ? "?todos=1" : ""}`);
	if (!res.negocios.length) {
		console.log(args.todos ? "\n  (no hay negocios)\n" : "\n  (ningún bar piloto; --todos para ver todos los negocios)\n");
		return;
	}
	console.table(res.negocios.map((n) => ({ negocio: n.nombre, piloto: n.piloto ? "sí" : "", tenant: n.tenantId })));
	if (res.hayMas) console.log("  (hay más negocios de los que caben en la lista)\n");
}

async function releaseLista() {
	const res = await api("GET", "/v1/admin/releases");
	if (!res.releases.length) {
		console.log("\n  (no hay versiones publicadas)\n");
		return;
	}
	console.table(res.releases);
}

async function releasePromocionar(args) {
	const version = String(args.version || "").trim();
	if (!version) fail("--version <x.y.z> requerido (sácalo de `pnpm release:lista`)");
	const target = args.target ? String(args.target) : "windows";
	await api("POST", "/v1/admin/releases/promote", {
		version,
		target,
		...(args.arch ? { arch: String(args.arch) } : {}),
	});
	const quien = target === "windows7" ? "los equipos con Windows 7" : "todos los equipos";
	console.log(`\n  ✔ ${version} (${target}) pasa a estable: ${quien} la verán en su próxima comprobación.\n`);
}

/* ── Reservas desde la web: dominios y clave (docs/estudios/reservas-web.md) ── */

function tenantDe(args) {
	const tenantId = String(args.tenant || "").trim();
	if (!tenantId) fail("--tenant <tenantId> requerido (sácalo de `pnpm piloto:lista -- --todos`)");
	return encodeURIComponent(tenantId);
}

function pintarReservasWeb(res) {
	console.log(`\n  Negocio  ${res.tenantId}`);
	if ("clave" in res) console.log(`  Clave    ${res.clave ?? "(ninguna: la crea la Main al pedir el código)"}`);
	console.log(`  Webs     ${res.dominios.length ? res.dominios.join("\n           ") : "(ninguna: el widget no se puede incrustar)"}\n`);
}

async function reservasWebVer(args) {
	pintarReservasWeb(await api("GET", `/v1/admin/reservas-web/${tenantDe(args)}`));
}

async function reservasWebDominio(args, poner) {
	const origen = String(args.origen || "").trim();
	if (!origen) fail("--origen https://www.su-web.es requerido (o http://localhost:<puerto> para desarrollar)");
	const ruta = `/v1/admin/reservas-web/${tenantDe(args)}/dominios${poner ? "" : "/quitar"}`;
	const res = await api("POST", ruta, { origen });
	console.log(poner ? `\n  ✔ ${res.origen} puede incrustar el widget.` : `\n  ✔ ${res.origen} ya no puede incrustarlo.`);
	pintarReservasWeb(res);
}

async function reservasWebRevocarClave(args) {
	const res = await api("POST", `/v1/admin/reservas-web/${tenantDe(args)}/revocar-clave`);
	console.log(
		`\n  ✔ Clave ${res.revocada} revocada. En un minuto deja de funcionar en todas partes.\n` +
			"    El restaurante tiene que volver a pedir el código en Configuración → Reservas y cambiarlo en su web.\n",
	);
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

const comandos = {
	issue,
	list,
	revoke,
	unrevoke,
	extend,
	shorten,
	resend,
	recifrar,
	"interruptor-apagar": interruptorApagar,
	"interruptor-encender": interruptorEncender,
	"interruptor-lista": interruptorLista,
	"piloto-poner": (a) => pilotoMarcar(a, true),
	"piloto-quitar": (a) => pilotoMarcar(a, false),
	"piloto-lista": pilotoLista,
	"release-lista": releaseLista,
	"release-promocionar": releasePromocionar,
	"reservas-web-ver": reservasWebVer,
	"reservas-web-dominio-poner": (a) => reservasWebDominio(a, true),
	"reservas-web-dominio-quitar": (a) => reservasWebDominio(a, false),
	"reservas-web-revocar-clave": reservasWebRevocarClave,
};

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
    recifrar                 (termina una rotación de LICENSE_STORE_KEY)

  Interruptores (pnpm interruptor:<comando>):
    apagar    --nombre <interruptor> --horas <n> --motivo "…" [--tenant <id>] [--desde x.y.z] [--hasta x.y.z]
    encender  --id <interruptorId>
    lista     [--historial]

  Bares piloto (pnpm piloto:<comando>):
    poner     --tenant <tenantId>
    quitar    --tenant <tenantId>
    lista     [--todos]

  Versiones (pnpm release:<comando>):
    lista
    promocionar --version <x.y.z> [--target windows7] [--arch x86_64]   (de beta a estable)

  Reservas desde la web (pnpm reservas-web:<comando>):
    ver             --tenant <tenantId>
    dominio-poner   --tenant <tenantId> --origen https://www.su-web.es
    dominio-quitar  --tenant <tenantId> --origen https://www.su-web.es
    revocar-clave   --tenant <tenantId>
`);
	process.exit(1);
}

comandos[cmd](args).catch((e) => fail(String(e?.message || e)));
