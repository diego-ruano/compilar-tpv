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
//   pnpm license:huerfanos -- [--borrar]              (negocios sin licencia, AUD-09; sin --borrar sólo lista)
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
// Y la base de un negocio en la nube (DO-03, docs/guias/restaurar-un-negocio.md):
//
//   pnpm negocio:estado   -- --tenant <tenantId>   (si nació, si tiene base, su próxima copia y sus copias)
//   pnpm negocio:copiar   -- --tenant <tenantId>   (la copia de hoy a R2, ahora)
//   pnpm negocio:instante -- --tenant <tenantId> --instante 2026-11-20T10:30:00+01:00 --modo nube|main --motivo "…"
//                            (o --marcador <m> en vez de --instante, para deshacer una vuelta)
//   pnpm negocio:restaurar-copia -- --tenant <tenantId> [--dia AAAA-MM-DD] --modo nube|main --motivo "…"
//                            (DO-PERDIDA: un objeto vacío, con la base de su copia de R2; sin --dia, la última)
//   pnpm negocio:base-vacia      -- --tenant <tenantId> --modo nube|main --motivo "…"
//                            (DO-PERDIDA: un objeto vacío de un negocio nacido, con una base nueva y vacía)
//   pnpm negocio:subida          -- --tenant <tenantId> --reabrir --motivo "…"
//                            (DO-SUBIDA: reabre la subida completa de la Main agotada, caducada o huérfana)
//
// Y la base central (su objeto `BaseCentral`). Lo que la cambia pide `--si`: sin él, dice qué haría.
//
//   pnpm central:estado        (si está aprovisionada, sus migraciones, si tiene algo a medias, sus filas)
//   pnpm central:copias        (sus copias en R2, de la más reciente a la más vieja)
//   pnpm central:copiar        (una copia ahora, con la hora en la clave: no pisa la del día)
//   pnpm central:aprovisionar -- [--copia <clave>] --si
//                            (a un objeto sin aprovisionar: el esquema vacío o, con --copia, esa copia)
//   pnpm central:volver -- (--instante 2026-11-20T10:30:00+01:00 | --marcador <m>) --si
//                            (a un instante de los últimos 30 días; dice con qué marcador se deshace)
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

/**
 * Una llamada a la administración del worker. Si no sale, se acaba aquí con lo que ha pasado, y con
 * su motivo si la respuesta lo trae aparte (`detalle`).
 * `comprobar` es cómo mirar si un cambio llegó a entrar cuando la nube no ha podido contestar.
 * `deshacer`, la orden que deshace una vuelta a un instante a partir de su marcador: una vuelta que no
 * ha salido entera dice igualmente con qué se deshace.
 */
async function api(method, path, body, { comprobar = "pnpm license:list", deshacer } = {}) {
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
		if (data.error === "admin_disabled") fail("El worker no tiene ADMIN_API_TOKEN configurado (wrangler secret put).");
		// La nube no ha podido atender (la base central saturada, sin aprovisionar…): la respuesta no
		// dice si el cambio llegó a entrar, y repetir un extend o un shorten lo aplicaría dos veces.
		if (data.code === "external" && r.status === 503) {
			fail(
				`La nube no ha podido atender ahora (${data.error}${data.message ? ` — ${data.message}` : ""}). ` +
					`Si era un cambio, no se sabe si ha entrado: compruébalo con ${comprobar} antes de repetirlo.`,
			);
		}
		const motivo = data.detalle ? `\n    Motivo: ${data.detalle}` : "";
		const paraDeshacer = data.deshacer && deshacer ? `\n    Para deshacerla: ${deshacer(data.deshacer)}` : "";
		fail(`${r.status}: ${data.error || text}${data.message ? ` — ${data.message}` : ""}${motivo}${paraDeshacer}`);
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
	const total = { licencias: 0, deks: 0 };
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
		`\n  ✔ Recifrado con la clave actual: ${total.licencias} claves de licencia y ${total.deks} DEK.`,
	);
	if (ilegibles.size) {
		console.log(`\n  ✖ ${ilegibles.size} no se dejan descifrar con ninguna clave configurada:`);
		console.table([...ilegibles.values()]);
		console.log("  No quites LICENSE_STORE_KEY_ANTERIOR hasta saber qué son.\n");
	} else {
		console.log("  Ya se puede quitar LICENSE_STORE_KEY_ANTERIOR (wrangler secret delete).\n");
	}
}

/**
 * AUD-09 · Los negocios que ninguna licencia apunta, con su base en el TenantHub: los dejaban las
 * activaciones que perdían la carrera por una clave. Sin `--borrar` sólo los lista; con él, los
 * retira (vacía su TenantHub y los da por borrados), llamando a la ruta hasta que no quede ninguno.
 * Qué cuenta como huérfano: `apps/cloud-worker-licensing/src/domains/admin/huerfanos.ts`.
 */
async function huerfanos(args) {
	const borrar = args.borrar === true;
	const vistos = new Map();
	const fallos = new Map();
	let retirados = 0;
	for (;;) {
		const r = await api("POST", "/v1/admin/negocios-huerfanos", { borrar });
		for (const h of r.huerfanos) vistos.set(h.tenantId, h);
		retirados += r.retirados;
		for (const f of r.fallos) fallos.set(f.tenantId, f);
		// Sin borrar, la lista no avanza: se enseña la primera página. Borrando, se sigue mientras
		// queden y la llamada haya retirado alguno.
		if (!borrar || !r.quedan || r.retirados === 0) {
			if (!borrar && r.quedan) console.log("\n  (hay más de los que caben en una llamada)");
			break;
		}
	}
	if (!vistos.size) {
		console.log("\n  ✔ No hay negocios sin licencia.\n");
		return;
	}
	console.table([...vistos.values()].map((h) => ({ negocio: h.tenantId, creado: h.creadoEn, equipos: h.equipos })));
	if (!borrar) {
		console.log(
			`\n  ${vistos.size} negocios sin licencia. Revisa la lista y, si son todos de activaciones que perdieron, retíralos con:\n` +
				"    pnpm license:huerfanos -- --borrar\n",
		);
		return;
	}
	console.log(`\n  ✔ ${retirados} negocios retirados: su TenantHub vaciado y dados por borrados.`);
	if (fallos.size) {
		console.log(`\n  ✖ ${fallos.size} no se pudieron retirar (se quedan como estaban; vuelve a lanzarlo):`);
		console.table([...fallos.values()]);
	}
	console.log("");
}

/* ── DO-03 · La base de un negocio en la nube (docs/guias/restaurar-un-negocio.md) ── */

function negocioDe(args) {
	const tenantId = String(args.tenant || "").trim();
	if (!tenantId) fail("--tenant <tenantId> requerido (sácalo de `pnpm piloto:lista -- --todos`)");
	return tenantId;
}

function cuando(ms) {
	return ms ? new Date(ms).toISOString() : "(ninguna)";
}

async function negocioEstado(args) {
	const r = await api("POST", "/v1/admin/negocios/estado", { tenantId: negocioDe(args) });
	console.log(`\n  Negocio        ${r.tenantId}`);
	console.log(`  Ha nacido      ${r.nacido ? "sí (alguna licencia suya se activó)" : "no"}`);
	console.log(`  Base           ${r.aprovisionado ? "sí" : "NO: el objeto está vacío"}${r.negocio && r.negocio !== r.tenantId ? ` (sello de ${r.negocio})` : ""}`);
	console.log(`  Vuelta         ${r.vueltaEnCurso ? "PREPARADA Y SIN APLICAR: la base está cerrada" : "ninguna en curso"}`);
	console.log(`  Seq            ${r.seq}`);
	console.log(`  Sesiones       ${r.sesiones}`);
	console.log(`  Próxima copia  ${cuando(r.proximaCopiaMs)}`);
	// DO-SUBIDA: la subida completa que se le pidió a la Main tras devolverle la base en modo «main».
	if (r.subida) {
		const s = r.subida;
		console.log(`  Subida         ${s.estado} (${s.origen}), pedida ${s.desde}${s.terminada ? `, terminada ${s.terminada}` : `, plazo hasta ${s.hasta}`}`);
		console.log(`                 Main ${s.mainDeviceId ?? "(la primera que salude)"}; ${s.paginas} páginas, ${s.filasEscritas} filas escritas de ${s.filasDeclaradas ?? "?"} declaradas`);
	} else {
		console.log("  Subida         (ninguna pedida)");
	}
	if (!r.copias.length) {
		console.log("  Copias         (ninguna en R2)\n");
		return;
	}
	console.log("  Copias en R2:");
	console.table(r.copias.map((c) => ({ dia: c.dia, bytes: c.bytes, subida: c.subida })));
}

async function negocioCopiar(args) {
	const r = await api("POST", "/v1/admin/negocios/copiar", { tenantId: negocioDe(args) });
	console.log(`\n  ✔ Copia de ${r.tenantId}: ${r.clave}, ${r.filas} filas en ${r.tablas} tablas, ${r.bytes} bytes comprimida.\n`);
}

function motivoDe(args) {
	const motivo = String(args.motivo || "").trim();
	if (motivo.length < 3) fail('--motivo "…" requerido: queda en la auditoría');
	return motivo;
}

function modoDe(args) {
	const modo = String(args.modo || "");
	if (modo !== "nube" && modo !== "main") {
		fail(
			"--modo nube|main requerido: quién manda después.\n" +
				"    nube → la nube del instante es la buena: cada Main aparta su base y se trae la nube\n" +
				"    main → la Main es la buena: sigue con su base y repara la nube",
		);
	}
	return modo;
}

/** El `--marcador` de una vuelta a un instante (el «deshacer» de otra), si lo hay. Sin valor no vale. */
function marcadorDe(args) {
	if (args.marcador === true) fail("--marcador <marcador> (el «deshacer» de otra vuelta)");
	return args.marcador === undefined ? undefined : String(args.marcador);
}

async function negocioInstante(args) {
	const tenantId = negocioDe(args);
	const modo = modoDe(args);
	const motivo = motivoDe(args);
	const cuerpo = { tenantId, modo, motivo };
	const marcador = marcadorDe(args);
	if (marcador) {
		cuerpo.marcador = marcador;
	} else {
		const ms = Date.parse(String(args.instante || ""));
		if (!Number.isFinite(ms)) {
			fail("--instante <fecha ISO, p. ej. 2026-11-20T10:30:00+01:00> o --marcador <marcador> requerido");
		}
		cuerpo.instanteMs = ms;
	}
	const r = await api("POST", "/v1/admin/negocios/instante", cuerpo, {
		deshacer: (m) => `pnpm negocio:instante -- --tenant ${tenantId} --marcador ${m} --modo ${modo} --motivo "…"`,
	});
	console.log(`\n  ✔ ${tenantId} ha vuelto${r.instanteMs ? ` a ${new Date(r.instanteMs).toISOString()}` : ` al marcador ${r.destino}`}.`);
	console.log(`    Marcador para deshacerlo: ${r.deshacer}`);
	console.log(`    Log abierto en el Seq ${r.inicio ?? "(sin base tras volver)"}${r.purgadoHasta ? `, purgado hasta ${r.purgadoHasta}` : ""}.\n`);
	for (const paso of r.queHacer) console.log(`    · ${paso}`);
	console.log("");
}

/** DO-PERDIDA · Lo que sigue tras darle base a un objeto vacío. */
function trasDarBase(r) {
	console.log(`    Log abierto en el Seq ${r.inicio}${r.purgadoHasta ? `, purgado hasta ${r.purgadoHasta}` : ""}.
`);
	for (const paso of r.queHacer) console.log(`    · ${paso}`);
	console.log("");
}

async function negocioRestaurarCopia(args) {
	const tenantId = negocioDe(args);
	const cuerpo = { tenantId, modo: modoDe(args), motivo: motivoDe(args) };
	if (args.dia) cuerpo.dia = String(args.dia);
	const r = await api("POST", "/v1/admin/negocios/restaurar-copia", cuerpo);
	console.log(`
  ✔ ${tenantId} tiene otra vez su base: ${r.clave}, ${r.filas} filas en ${r.tablas} tablas.`);
	trasDarBase(r);
}

async function negocioBaseVacia(args) {
	const tenantId = negocioDe(args);
	const r = await api("POST", "/v1/admin/negocios/base-vacia", { tenantId, modo: modoDe(args), motivo: motivoDe(args) });
	console.log(`
  ✔ ${tenantId} tiene una base nueva y vacía, con su administrador inicial.`);
	trasDarBase(r);
}

/** DO-SUBIDA · Reabre la subida completa de la Main (agotada, caducada o huérfana). */
async function negocioSubida(args) {
	const tenantId = negocioDe(args);
	if (!args.reabrir) fail("--reabrir requerido (lo único que se hace con la subida desde aquí; su estado sale en negocio:estado)");
	const r = await api("POST", "/v1/admin/negocios/subida/reabrir", { tenantId, motivo: motivoDe(args) });
	console.log(`\n  ✔ Subida completa de ${tenantId} reabierta (estaba ${r.antes}). La primera Main vigente que salude se la queda.\n`);
}

/* ── La base central (su objeto BaseCentral) ─────────────────────────────── */

const CENTRAL = { comprobar: "pnpm central:estado" };

/** Lo que cambia la central sólo se hace con `--si`: sin él, se dice qué haría y no se hace nada. */
function confirmado(args, queHaria) {
	if (args.si === true) return;
	fail(`${queHaria}\n    Si es lo que quieres, repite la orden con --si.`);
}

async function centralEstado() {
	const r = await api("GET", "/v1/admin/central/estado", undefined, CENTRAL);
	console.log(`\n  Aprovisionada  ${r.aprovisionada ? "sí" : "NO"}`);
	if (r.enCurso.restauracion) {
		const { clave, desdeMs } = r.enCurso.restauracion;
		console.log(`  A MEDIAS       la restauración desde ${clave} (${cuando(desdeMs)}) no terminó: no atiende. Vuelve a restaurar.`);
	}
	if (r.enCurso.vuelta) {
		const { destino, desdeMs, fase, preparada } = r.enCurso.vuelta;
		if (fase === "preparada") {
			console.log(
				`  VUELTA         preparada a ${destino} (${cuando(desdeMs)}) y sin aplicar: no atiende hasta reiniciarse.\n` +
					"                 Se reinicia repitiendo la misma orden de pnpm central:volver (con su --instante o su --marcador).",
			);
			if (preparada) console.log(`                 Para deshacerla, una vez aplicada: ${centralAlMarcador(preparada.deshacer)}`);
		} else {
			console.log(
				`  VUELTA         preparándose a ${destino} (desde ${cuando(desdeMs)}): no atiende mientras tanto.\n` +
					"                 Espera a que termine y vuelve a mirar con pnpm central:estado.",
			);
		}
	}
	console.log(`  Avería         ${r.averia ? `${r.averia.error}${r.averia.detalle ? ` — ${r.averia.detalle}` : ""}` : "ninguna"}`);
	console.log(`  Migraciones    ${r.migraciones.map((m) => m.nombre).join(", ") || "(ninguna)"}`);
	console.log(`  Tamaño         ${r.bytes} bytes`);
	const filas = Object.entries(r.filas);
	if (!filas.length) {
		console.log("");
		return;
	}
	console.log("  Filas:");
	console.table(filas.map(([tabla, n]) => ({ tabla, filas: n })));
}

async function centralCopias() {
	const r = await api("GET", "/v1/admin/central/copias", undefined, CENTRAL);
	if (!r.copias.length) {
		console.log("\n  (ninguna copia de la central en R2)\n");
		return;
	}
	console.table(
		r.copias.map((c) => ({
			clave: c.clave,
			subida: c.subida,
			bytes: c.bytes,
			filas: c.filas ?? "?",
			tablas: c.tablas ?? "?",
			migracion: c.ultimaMigracion ?? "?",
		})),
	);
	if (r.hayMas) console.log("  (hay más copias de las que caben en la lista)\n");
}

async function centralCopiar() {
	const r = await api("POST", "/v1/admin/central/copiar-ahora", undefined, CENTRAL);
	console.log(`\n  ✔ Copia de la central: ${r.clave}, ${r.filas} filas en ${r.tablas} tablas, ${r.bytes} bytes comprimida.\n`);
}

async function centralAprovisionar(args) {
	if (args.copia === true) fail("--copia <clave> (sácala de `pnpm central:copias`)");
	const copia = args.copia === undefined ? undefined : String(args.copia).trim();
	confirmado(
		args,
		copia
			? `Esto restaura la central desde ${copia}. Sólo se hace si el objeto está sin aprovisionar (o con una restauración a medias).`
			: "Esto le da a la central su esquema VACÍO: sin ninguna licencia, y los TPV que pregunten por la suya la borrarían. Sólo se hace si el objeto está sin aprovisionar. Si la central se ha perdido, restáurala desde una copia con --copia <clave>.",
	);
	const r = await api("POST", "/v1/admin/central/aprovisionar", copia ? { claveDeCopia: copia } : {}, CENTRAL);
	if (r.copia) {
		console.log(`\n  ✔ Central restaurada desde ${r.copia.clave}: ${r.copia.filas} filas en ${r.copia.tablas} tablas.`);
	} else {
		console.log("\n  ✔ Central aprovisionada, vacía.");
	}
	console.log(`    Migraciones: ${r.migraciones.map((m) => m.nombre).join(", ")}\n`);
}

/** La orden que devuelve la central a un marcador: la que deshace una vuelta. */
const centralAlMarcador = (marcador) => `pnpm central:volver -- --marcador ${marcador} --si`;

async function centralVolver(args) {
	let cuerpo;
	/** Adónde vuelve, para decirlo: «al marcador …» o «a <instante>». */
	let adonde;
	const marcador = marcadorDe(args);
	if (marcador) {
		cuerpo = { marcador };
		adonde = `al marcador ${marcador}`;
	} else {
		const ms = Date.parse(String(args.instante || ""));
		if (!Number.isFinite(ms)) {
			fail("--instante <fecha ISO, p. ej. 2026-11-20T10:30:00+01:00> o --marcador <marcador> requerido");
		}
		cuerpo = { instanteMs: ms };
		adonde = `a ${new Date(ms).toISOString()}`;
	}
	confirmado(
		args,
		`Esto devuelve la central ENTERA ${adonde}: lo escrito después se pierde (antes se deja una copia de cómo está en R2), y mientras vuelve no atiende.`,
	);
	const r = await api("POST", "/v1/admin/central/volver", cuerpo, { ...CENTRAL, deshacer: centralAlMarcador });
	console.log(`\n  ✔ La central ha vuelto ${adonde}.`);
	console.log(`    Copia de cómo estaba antes: ${r.copiaDeAntes}`);
	console.log(`\n    Para deshacerlo:\n\n      ${centralAlMarcador(r.deshacer)}\n`);
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
	huerfanos,
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
	"negocio-estado": negocioEstado,
	"negocio-copiar": negocioCopiar,
	"negocio-instante": negocioInstante,
	"negocio-restaurar-copia": negocioRestaurarCopia,
	"negocio-base-vacia": negocioBaseVacia,
	"negocio-subida": negocioSubida,
	"central-estado": centralEstado,
	"central-copias": centralCopias,
	"central-copiar": centralCopiar,
	"central-aprovisionar": centralAprovisionar,
	"central-volver": centralVolver,
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
    huerfanos [--borrar]     (negocios sin licencia; sin --borrar sólo los lista)

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

  La base de un negocio en la nube (pnpm negocio:<comando>, docs/guias/restaurar-un-negocio.md):
    estado    --tenant <tenantId>
    copiar    --tenant <tenantId>          (la copia de hoy a R2, ahora)
    instante  --tenant <tenantId> (--instante <fecha ISO> | --marcador <m>) --modo nube|main --motivo "…"
    restaurar-copia --tenant <tenantId> [--dia AAAA-MM-DD] --modo nube|main --motivo "…"   (a un objeto vacío)
    base-vacia      --tenant <tenantId> --modo nube|main --motivo "…"                      (a un objeto vacío)
    subida          --tenant <tenantId> --reabrir --motivo "…"   (reabre la subida completa de la Main)

  La base central (pnpm central:<comando>; lo que la cambia pide --si):
    estado
    copias
    copiar                                         (una copia ahora; no pisa la del día)
    aprovisionar [--copia <clave>] --si            (a un objeto sin aprovisionar: vacía o desde una copia)
    volver (--instante <fecha ISO> | --marcador <m>) --si
`);
	process.exit(1);
}

comandos[cmd](args).catch((e) => fail(String(e?.message || e)));
