// test/oraculo/normalizar.ts
//
// Lo que hace que la salida de un escenario del oráculo (`test/oraculoCentral.test.ts`) sea la
// misma en cada ejecución sin esconder nada de lo que significa.
//
// Lo que no es determinista se cambia por un marcador estable: el mismo valor lleva el mismo
// marcador en todo el escenario, y los marcadores se numeran por orden de aparición (los pasos, en
// orden, y después la foto final de la central).
//
//   · ‹id·N›                 un UUID (licencias, negocios, cobros, auditoría…). También dentro de un
//                            texto.
//   · ‹clave·N›              una clave de licencia en claro (`TPV-XXXXX-…`), también dentro de un
//                            texto (los correos).
//   · ‹hash de clave·N›      el sha256 de la clave N, que es lo que guarda `license_key_hash`.
//   · ‹clave corta·N›        la clave N tal como la enseña la interfaz (`TPV-…-WX7Q`).
//   · ‹cifrado de clave·N›   la clave N cifrada en reposo (`license_key_enc`): se descifra con la
//                            `LICENSE_STORE_KEY` del escenario para saber de qué clave es.
//   · ‹dek·N›                la DEK de un negocio, en claro (lo que entrega la activación).
//   · ‹cifrado de dek·N›     la DEK N cifrada en reposo (`tenants.field_dek`).
//   · ‹cifrado ilegible·N›   algo cifrado que no se deja descifrar con esa clave.
//   · ‹hash·N›               cualquier otro sha256 en hexadecimal (el del cuerpo de un webhook).
//   · { "‹jwt›": {…} }       un token de sesión: lo que lleva dentro (sus claims), normalizado.
//   · ‹clave pública de X›   la clave pública del equipo X: el arnés las conoce de antemano.
//
// Así, si una clave, su hash y su cifrado acabaran en filas distintas, o el token llevara el hash
// de otra licencia, se ve en la foto; con marcadores sueltos por valor no se vería.
//
// Los instantes (un número entero de milisegundos entre 2001 y 2286, una fecha ISO, y el `iat` y el
// `exp` de un token, que van en segundos) se escriben como `T0±Nd hh:mm`: N días de calendario desde
// el día en que empieza el escenario, y la hora UTC. El reloj de los escenarios es simulado
// (`escenario.ts`): empieza a las 00:00 UTC de un día fijo y avanza un minuto exacto antes de cada
// petición, así que no hay ruido que redondear —«00:03» es lo escrito en el tercer paso—, y un mes
// de más son entre 28 y 31 días de más. Si un instante no cae en un minuto exacto, lleva también
// los segundos y los milisegundos.
//
// Un texto que es un objeto o una lista JSON (la auditoría, el cuerpo de un webhook, la dirección
// del cliente) se enseña ya interpretado, con las claves en el orden en que se escribieron.

import { descifrar } from "../../src/server/crypto";

/** Con qué se normaliza la salida de un escenario. */
type Contexto = {
	/** Cuándo empieza el escenario: las 00:00 UTC de su primer día. */
	t0: number;
	/** Valores que se conocen de antemano y se enseñan con su nombre (las claves públicas de los equipos). */
	conocidos: ReadonlyMap<string, string>;
	/** La `LICENSE_STORE_KEY` del escenario, para saber qué hay dentro de lo cifrado. */
	claveDeAlmacen: string;
};

const DIA_MS = 24 * 60 * 60 * 1000;

const SIMBOLO = "[0-9A-HJKMNP-TV-Z]"; // Crockford base32, el alfabeto de `licenseKey.ts`
const CLAVE_DE_LICENCIA = new RegExp(`TPV-${SIMBOLO}{5}(?:-${SIMBOLO}{5}){3}`, "g");
const CLAVE_CORTA = new RegExp(`^TPV-…-(${SIMBOLO}{4})$`);
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const SHA256 = /^[0-9a-f]{64}$/;
const CIFRADO = /^k[0-9a-z]+:[A-Za-z0-9+/]+={0,2}$/;
const JWT = /^eyJ[\w-]*\.[\w-]+\.[\w-]+$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

/** ¿Es un instante en milisegundos? Entre 2001 y 2286: ningún importe, cantidad ni plazo llega. */
function esInstante(n: number): boolean {
	return Number.isInteger(n) && n >= 1e12 && n < 1e13;
}

function esTextoJson(texto: string): boolean {
	const t = texto.trimStart();
	return t.startsWith("{") || t.startsWith("[");
}

const dosCifras = (n: number) => String(n).padStart(2, "0");

/** `T0±Nd hh:mm` (ver la cabecera). */
function instante(ms: number, t0: number): string {
	const dias = Math.floor((ms - t0) / DIA_MS);
	const resto = ms - t0 - dias * DIA_MS;
	const horas = Math.floor(resto / 3_600_000);
	const minutos = Math.floor((resto % 3_600_000) / 60_000);
	const segundos = Math.floor((resto % 60_000) / 1000);
	const milis = resto % 1000;
	const hora =
		`${dosCifras(horas)}:${dosCifras(minutos)}` +
		(segundos || milis ? `:${dosCifras(segundos)}.${String(milis).padStart(3, "0")}` : "");
	return `T0${dias < 0 ? "-" : "+"}${Math.abs(dias)}d ${hora}`;
}

/** Los claims de un token, con sus instantes en milisegundos (en el token van en segundos). */
function claimsDe(token: string): Record<string, unknown> {
	const cuerpo = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
	const claims = JSON.parse(atob(cuerpo.padEnd(Math.ceil(cuerpo.length / 4) * 4, "="))) as Record<string, unknown>;
	for (const campo of ["iat", "exp", "nbf"]) {
		if (typeof claims[campo] === "number") claims[campo] = (claims[campo] as number) * 1000;
	}
	return claims;
}

/**
 * Recorre un valor y lo reconstruye, cambiando cada texto con `texto` y cada instante por su forma
 * relativa. Los textos JSON y los tokens se abren y se recorren por dentro. El orden en que se
 * visitan los textos es siempre el mismo: es el que numera los marcadores.
 */
function recorrer(valor: unknown, t0: number, texto: (s: string) => unknown): unknown {
	if (typeof valor === "string") {
		if (esTextoJson(valor)) {
			try {
				return recorrer(JSON.parse(valor), t0, texto);
			} catch {
				// No era JSON: es un texto más.
			}
		}
		if (JWT.test(valor)) return { "‹jwt›": recorrer(claimsDe(valor), t0, texto) };
		if (ISO.test(valor)) return instante(Date.parse(valor), t0);
		return texto(valor);
	}
	if (typeof valor === "number") return esInstante(valor) ? instante(valor, t0) : valor;
	if (Array.isArray(valor)) return valor.map((v) => recorrer(v, t0, texto));
	if (valor && typeof valor === "object") {
		return Object.fromEntries(Object.entries(valor).map(([k, v]) => [k, recorrer(v, t0, texto)]));
	}
	return valor;
}

async function sha256Hex(texto: string): Promise<string> {
	const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(texto));
	return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Numera valores por orden de aparición: el mismo valor, el mismo número. */
class Numeracion {
	private readonly numeros = new Map<string, number>();
	numero(valor: string): number {
		let n = this.numeros.get(valor);
		if (n === undefined) {
			n = this.numeros.size + 1;
			this.numeros.set(valor, n);
		}
		return n;
	}
}

/** La salida de un escenario, normalizada (ver la cabecera). */
export async function normalizar(salida: unknown, ctx: Contexto): Promise<unknown> {
	// 1 · Todos los textos, en el orden en que se van a visitar.
	const textos: string[] = [];
	recorrer(salida, ctx.t0, (s) => textos.push(s));

	// 2 · Lo cifrado, descifrado: así se sabe de qué clave o de qué DEK es cada valor.
	const descifrados = new Map<string, string | null>();
	for (const s of textos) {
		if (!CIFRADO.test(s) || descifrados.has(s)) continue;
		try {
			descifrados.set(s, (await descifrar(ctx.claveDeAlmacen, s)).texto);
		} catch {
			descifrados.set(s, null);
		}
	}

	// 3 · Las claves de licencia que salen en claro o dentro de un cifrado, y lo que se deriva de
	// cada una: su hash y su forma corta. La forma corta sólo lleva los cuatro últimos símbolos: si
	// dos claves del escenario acabaran igual (uno entre un millón por pareja), no se sabría de cuál
	// es, y esa foto saldría distinta.
	const claves = new Set<string>();
	for (const s of [...textos, ...[...descifrados.values()].filter((t): t is string => t !== null)]) {
		for (const m of s.matchAll(CLAVE_DE_LICENCIA)) claves.add(m[0]);
	}
	const claveDelHash = new Map<string, string>();
	const clavesPorFinal = new Map<string, string[]>();
	for (const clave of claves) {
		claveDelHash.set(await sha256Hex(clave), clave);
		const final = clave.slice(-4);
		clavesPorFinal.set(final, [...(clavesPorFinal.get(final) ?? []), clave]);
	}
	const esClave = (t: string) => claves.has(t);
	const deks = new Set([...descifrados.values()].filter((t): t is string => t !== null && !esClave(t)));

	// 4 · Los números de las claves y las DEK: por la primera vez que sale cualquiera de sus formas.
	const numClave = new Numeracion();
	const numDek = new Numeracion();
	const clavesDe = (s: string): string[] => {
		const enClaro = [...s.matchAll(CLAVE_DE_LICENCIA)].map((m) => m[0]);
		const porHash = claveDelHash.get(s);
		const porFinal = clavesPorFinal.get(CLAVE_CORTA.exec(s)?.[1] ?? "");
		const cifrada = descifrados.get(s);
		return [
			...enClaro,
			...(porHash ? [porHash] : []),
			...(porFinal?.length === 1 ? porFinal : []),
			...(cifrada && esClave(cifrada) ? [cifrada] : []),
		];
	};
	for (const s of textos) {
		for (const clave of clavesDe(s)) numClave.numero(clave);
		const dek = deks.has(s) ? s : descifrados.get(s);
		if (dek && deks.has(dek)) numDek.numero(dek);
	}

	// 5 · La sustitución, en el mismo orden.
	const numId = new Numeracion();
	const numHash = new Numeracion();
	const numIlegible = new Numeracion();
	return recorrer(salida, ctx.t0, (s) => {
		const conocido = ctx.conocidos.get(s);
		if (conocido) return conocido;
		if (descifrados.has(s)) {
			const claro = descifrados.get(s);
			if (claro === null || claro === undefined) return `‹cifrado ilegible·${numIlegible.numero(s)}›`;
			return esClave(claro) ? `‹cifrado de clave·${numClave.numero(claro)}›` : `‹cifrado de dek·${numDek.numero(claro)}›`;
		}
		if (deks.has(s)) return `‹dek·${numDek.numero(s)}›`;
		const porHash = claveDelHash.get(s);
		if (porHash) return `‹hash de clave·${numClave.numero(porHash)}›`;
		if (SHA256.test(s)) return `‹hash·${numHash.numero(s)}›`;
		const corta = CLAVE_CORTA.exec(s);
		if (corta) {
			const deEsa = clavesPorFinal.get(corta[1]);
			return deEsa?.length === 1 ? `‹clave corta·${numClave.numero(deEsa[0])}›` : `‹clave corta sin clave conocida›`;
		}
		return s
			.replace(CLAVE_DE_LICENCIA, (clave) => `‹clave·${numClave.numero(clave)}›`)
			.replace(UUID, (id) => `‹id·${numId.numero(id.toLowerCase())}›`);
	});
}
