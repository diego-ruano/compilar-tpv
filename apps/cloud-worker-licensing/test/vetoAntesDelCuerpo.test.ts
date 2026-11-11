// test/vetoAntesDelCuerpo.test.ts
//
// Todo lo que decide ANTES de leer el cuerpo va delante del validador (ARQ-03 / ARQ-06).
//
// El validador del cuerpo es un MIDDLEWARE, así que corre antes que el handler. Una comprobación
// de rol escrita dentro del handler se ejecuta, por tanto, después de haber leído y parseado el
// cuerpo entero: quien no tenía permiso se lleva un 400 describiéndole el schema en vez de su 403.
//
// Ya pasó dos veces. La primera la cazó `test/anularSoloMain.test.ts`, que sigue vigilando su ruta
// —la del caso del que salió la regla—. La segunda no la cazó nadie: al migrar `sync` a schemas se
// arreglaron sus siete vetos y quedaron cinco rutas de `login` con el mismo fallo, vivas, porque
// aquel test sólo miraba la ruta de anular. Esto es el barrido general que faltaba.
//
// La invariante es estructural y por eso se puede leer del fuente: **un `*.routes.ts` no comprueba
// roles**. Preguntarle a la base qué rol tiene un dispositivo es trabajo del middleware
// (`soloLaMain(...)` en `middleware/tenant.ts`); un router que lo hace por su cuenta es, casi
// siempre, uno que lo está haciendo tarde.

import { describe, expect, it } from "vitest";

/** Leer el fuente con `?raw` (Vite): dentro del pool de workers no hay `node:fs`. */
const fuentes = import.meta.glob("../src/domains/**/*.routes.ts", {
	query: "?raw",
	import: "default",
	eager: true,
}) as Record<string, string>;

/** Las primitivas que resuelven un rol. Su sitio es el middleware, no el handler. */
const PRIMITIVAS_DE_ROL = /\b(isTpvDevice|tieneRol|rolDelDispositivo)\s*\(/g;

/**
 * Los middlewares que vetan, sea por rol, por IP o, en las rutas públicas de la reserva web, por la
 * clave del negocio, por Turnstile y por el tamaño del cuerpo (`domains/reservas_web/puerta.ts`). Y
 * al activar una licencia, por no traer la firma del equipo o traerla con la hora fuera de margen
 * (AUD-01, `exigirFirma`); la firma en sí se comprueba detrás del validador, porque la clave pública
 * viaja en el cuerpo. Y el tope del cuerpo de una ruta anónima (AUD-34, `topeAnonimo` o un
 * `bodyLimit` a mano), si se escribe en la cadena de la ruta.
 */
const VETOS = /\b(soloLaMain\w*|filtroExterior|puertaPublica|limitadorAltas|verificacionHumana|topeDelCuerpo|topeAnonimo|bodyLimit|exigirFirma)\b/g;

/** Dónde empieza el ÚLTIMO veto: con varios en la cadena, todos van delante del validador. */
function ultimoVeto(bloque: string): number {
	return Math.max(-1, ...[...bloque.matchAll(VETOS)].map((m) => m.index!));
}

/** Lo que lee el cuerpo de la petición. */
const VALIDADORES = /\b(cuerpo|cuerpoConIdentificador|cuerpoTolerante)\s*\(/;

/**
 * Cada `X.post("…", …)` con su cadena de middlewares y su handler, y **nada más**.
 *
 * El bloque se corta en el cierre del propio registro (`});` o `);` a columna cero, que es como
 * terminan todos) y no en el registro siguiente: con lo segundo se tragaba los comentarios de en
 * medio, y uno que sólo NOMBRA un veto marcaba en falso a la ruta de arriba. Lo de dentro siempre
 * va indentado, así que la columna cero basta para reconocer el final.
 */
function registrosDeRuta(fuente: string): { ruta: string; bloque: string }[] {
	const inicios = [...fuente.matchAll(/^\w+\.(?:post|get|put|patch|delete)\(\s*\n?\s*"([^"]+)"/gm)];

	return inicios.map((m) => {
		const desde = fuente.slice(m.index!);
		const fin = desde.search(/\n\}?\);/);
		return { ruta: m[1], bloque: fin === -1 ? desde : desde.slice(0, fin) };
	});
}

describe("el veto va delante del validador del cuerpo", () => {
	it("ningún router de dominio resuelve un rol por su cuenta", () => {
		const culpables: string[] = [];

		for (const [fichero, fuente] of Object.entries(fuentes)) {
			for (const m of fuente.matchAll(PRIMITIVAS_DE_ROL)) {
				culpables.push(`${fichero.replace("../src/", "")}: ${m[1]}()`);
			}
		}

		expect(
			culpables,
			"un rol se comprueba con `soloLaMain(...)` en la cadena de la ruta, no dentro del handler",
		).toEqual([]);
	});

	it("cuando una ruta tiene veto y validador, el veto va primero", () => {
		const culpables: string[] = [];

		for (const [fichero, fuente] of Object.entries(fuentes)) {
			for (const { ruta, bloque } of registrosDeRuta(fuente)) {
				const veto = ultimoVeto(bloque);
				const validador = bloque.search(VALIDADORES);
				if (veto === -1 || validador === -1) continue;
				if (veto > validador) culpables.push(`${fichero.replace("../src/", "")} → ${ruta}`);
			}
		}

		expect(culpables, "el validador lee el cuerpo antes de que el veto pueda rechazar").toEqual([]);
	});

	it("el barrido mira de verdad los routers, no una lista vacía", () => {
		// Sin esto, un glob que dejara de casar convertiría los dos tests de arriba en verde
		// permanente — que es exactamente el fallo mudo que vienen a evitar.
		const conVetoYValidador = Object.values(fuentes).flatMap((fuente) =>
			registrosDeRuta(fuente).filter(
				({ bloque }) => ultimoVeto(bloque) !== -1 && bloque.search(VALIDADORES) !== -1,
			),
		);

		expect(Object.keys(fuentes).length).toBeGreaterThan(5);
		expect(conVetoYValidador.length).toBeGreaterThan(3);
	});
});

// ─── AUD-34 · Una ruta anónima con cuerpo lleva su tope delante ───────────────────────────────────
//
// Lo que no ha pasado por una autenticación no tiene por qué hacer leer al worker un cuerpo entero:
// el validador, la firma o el HMAC de Stripe lo leían todo, de cualquier tamaño, antes de saber quién
// llamaba. Una ruta con cuerpo (POST, PUT, PATCH) que no autentica antes de leerlo lleva un tope, en
// su cadena o declarado antes con `xRoutes.use("/ruta", topeAnonimo())`.

/** Lo que autentica sin leer el cuerpo: el token del negocio, el de administración, el de publicar. */
const AUTENTICA = /\b(tenantAuth|laMain|requireAdmin|soloConTokenDeRelease)\b/;

/** Un tope del cuerpo. */
const TOPE = /\b(topeAnonimo|topeDelCuerpo|lecturaPorPost|bodyLimit)\b/;

/** Se montan detrás de un `use("*", requireAdmin)` de otro router (lo comprueba el último test). */
const TRAS_REQUIRE_ADMIN = new Set(["reservas_web/admin.routes.ts"]);

/**
 * Cada ruta con cuerpo de un router: si es anónima y si lleva tope. Cuenta el orden: un
 * `use("*", tenantAuth)` o un `use("/ruta", topeAnonimo())` sólo cubre lo que se registra después.
 * Sólo se mira la cadena de middlewares, hasta el handler, no los comentarios de dentro.
 */
function rutasConCuerpo(fuente: string): { ruta: string; anonima: boolean; conTope: boolean }[] {
	const usos = [...fuente.matchAll(/^\w+\.use\(\s*"([^"]+)",([\s\S]*?)\);/gm)].map((m) => ({
		ruta: m[1],
		cadena: m[2],
		en: m.index!,
	}));
	return [...fuente.matchAll(/^\w+\.(?:post|put|patch)\(\s*\n?\s*"([^"]+)"/gm)].map((m) => {
		const desde = fuente.slice(m.index!);
		const fin = desde.search(/\n\}?\);/);
		const bloque = fin === -1 ? desde : desde.slice(0, fin);
		const handler = bloque.search(/\basync\s*\(\s*c\s*\)/);
		const cadena = handler === -1 ? bloque : bloque.slice(0, handler);
		const antes = usos.filter((u) => u.en < m.index!);
		return {
			ruta: m[1],
			anonima: !AUTENTICA.test(cadena) && !antes.some((u) => u.ruta === "*" && AUTENTICA.test(u.cadena)),
			conTope: TOPE.test(cadena) || antes.some((u) => (u.ruta === m[1] || u.ruta === "*") && TOPE.test(u.cadena)),
		};
	});
}

function anonimas() {
	return Object.entries(fuentes)
		.filter(([fichero]) => !TRAS_REQUIRE_ADMIN.has(fichero.replace("../src/domains/", "")))
		.flatMap(([fichero, fuente]) =>
			rutasConCuerpo(fuente)
				.filter((r) => r.anonima)
				.map((r) => ({ ...r, nombre: `${fichero.replace("../src/domains/", "")} → ${r.ruta}` })),
		);
}

describe("una ruta anónima lleva el tope de su cuerpo delante (AUD-34)", () => {
	it("toda ruta con cuerpo que no autentica antes de leerlo tiene su tope", () => {
		const sinTope = anonimas()
			.filter((r) => !r.conTope)
			.map((r) => r.nombre);
		expect(sinTope, "ponle `xRoutes.use(\"/ruta\", topeAnonimo())` antes de registrarla").toEqual([]);
	});

	it("el barrido ve las anónimas de verdad, y sólo ésas", () => {
		// Si sale una nueva, es una ruta anónima nueva: que lleve su tope y se apunte aquí. Si falta
		// una, el barrido ha dejado de verla y el test de arriba no vigila nada.
		expect(anonimas().map((r) => r.nombre).sort()).toEqual(
			[
				"licensing/licensing.routes.ts → /activate",
				"licensing/licensing.routes.ts → /device-change/request",
				"licensing/licensing.routes.ts → /refresh",
				"pairing/pairing.routes.ts → /cancel",
				"pairing/pairing.routes.ts → /claim",
				"pairing/pairing.routes.ts → /fetch-token",
				"reservas_web/publico.routes.ts → /:clave/cancelar",
				"reservas_web/publico.routes.ts → /:clave/reserva",
				"reservas_web/publico.routes.ts → /:clave/reservas",
				"stripe/stripe.routes.ts → /webhook",
			].sort(),
		);
	});

	it("lo que se monta detrás de requireAdmin lo está de verdad", () => {
		const admin = fuentes["../src/domains/admin/admin.routes.ts"];
		expect(admin).toMatch(/^adminRoutes\.use\("\*", requireAdmin\);[\s\S]*^adminRoutes\.route\("\/reservas-web", reservasWebAdminRoutes\);/m);
		for (const f of TRAS_REQUIRE_ADMIN) expect(fuentes[`../src/domains/${f}`], f).toBeDefined();
	});
});
