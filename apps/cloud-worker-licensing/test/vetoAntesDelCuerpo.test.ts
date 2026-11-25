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
//
// Y lo mismo por el camino desplegado: cada ruta con un veto de rol, pedida por una Handy con un
// cuerpo que no vale a la `app` entera, se queda en el veto dentro del TenantHub (el último bloque).

import { describe, expect, it } from "vitest";

import { conNegocioFirmado, HANDY, pedirComo } from "./helpers/negocioFirmado";
import { app } from "../src/app";
import { firmarSesion } from "../src/lib/sesion";
import { olvidarLicenciasCacheadas } from "../src/lib/licenciaEnUso";

const deps = { firmarSesion, olvidarLicenciasCacheadas };

/** Leer el fuente con `?raw` (Vite): dentro del pool de workers no hay `node:fs`. */
const fuentes = import.meta.glob("../src/domains/**/*.routes.ts", {
	query: "?raw",
	import: "default",
	eager: true,
}) as Record<string, string>;
const appFuente = Object.values(
	import.meta.glob("../src/app.ts", { query: "?raw", import: "default", eager: true }) as Record<string, string>,
)[0];

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

// ─── El veto por el camino desplegado ─────────────────────────────────────────────────────────────
//
// Lo de arriba lee el orden del fuente; esto lo comprueba con la petición de verdad: la `app` entera,
// `tenantAuth` en el Worker, `alHub`, `ejecutarRuta` y la ruta dentro del TenantHub, que decide con
// el rol que trae la identidad. Una regresión en cualquiera de esos pasos (la identidad sin el rol, un
// router sin `alHub`, el veto detrás del validador) deja pasar a la Handy hasta el 400 del cuerpo, o
// más allá.

/** Dónde monta la `app` cada router (`app.route("/v1/cuentas", cuentasRoutes)`). */
const MONTAJES = new Map([...appFuente.matchAll(/app\.route\(\s*"([^"]+)",\s*(\w+)\s*\)/g)].map((m) => [m[2], m[1]] as const));

/** Un veto de rol que decide con el rol de la identidad (`soloLaMain…`), no los de la Main vigente. */
const VETO_DE_ROL = /\bsoloLaMain(?!Vigente)\w*/;

/**
 * Las rutas que hoy llevan un veto de rol, escritas a mano. El barrido del fuente encuentra las que se
 * añadan; esta lista es lo que no puede perder: si a una le quitan el veto, o el barrido deja de
 * reconocer su router, se sigue pidiendo y tiene que dar 403. Una ruta nueva con veto se apunta aquí.
 */
const CON_VETO_DE_ROL = [
	"DELETE /v1/cuentas/gastos/:id",
	"POST /v1/cuentas/gastos",
	"POST /v1/cuentas/pagos/:id/anular",
	"POST /v1/login/correo-recuperacion/confirmar",
	"POST /v1/login/correo-recuperacion/estado",
	"POST /v1/login/correo-recuperacion/solicitar",
	"POST /v1/login/correo-recuperacion/usar-el-de-la-compra",
	"POST /v1/login/recuperar-pin/solicitar",
	"POST /v1/login/recuperar-pin/verificar",
	"POST /v1/mesas/cobrar-detalles",
	"POST /v1/sync/bootstrap",
	"POST /v1/sync/changes",
	"POST /v1/sync/historico",
	"POST /v1/sync/initialize-empty",
	"POST /v1/sync/salud",
	"POST /v1/sync/verificar/claves",
	"POST /v1/sync/verificar/filas",
	"POST /v1/sync/verificar/por-clave",
	"POST /v1/sync/verificar/resumen",
	"POST /v1/venta-rapida/cobrar-fraccionado",
	"PUT /v1/cuentas/gastos/:id",
	"PUT /v1/cuentas/pagos/:id",
];

/** Cada ruta de la `app` con un veto de rol en el fuente, en su cadena o en el `use("*")` de su router. */
function rutasConVetoDeRol(): string[] {
	const rutas: string[] = [];
	for (const fuente of Object.values(fuentes)) {
		const prefijo = MONTAJES.get(/export const (\w+)\s*=\s*new Hono/.exec(fuente)?.[1] ?? "");
		if (!prefijo) continue;
		const todoElRouter = [...fuente.matchAll(/^\w+\.use\(\s*"\*",([\s\S]*?)\);/gm)].some((m) => VETO_DE_ROL.test(m[1]));
		for (const m of fuente.matchAll(/^\w+\.(post|get|put|patch|delete)\(\s*\n?\s*"([^"]+)"/gm)) {
			const desde = fuente.slice(m.index!);
			const fin = desde.search(/\n\}?\);/);
			const bloque = fin === -1 ? desde : desde.slice(0, fin);
			const handler = bloque.search(/\basync\s*\(\s*c\s*\)/);
			const cadena = handler === -1 ? bloque : bloque.slice(0, handler);
			if (!todoElRouter && !VETO_DE_ROL.test(cadena)) continue;
			rutas.push(`${m[1].toUpperCase()} ${prefijo}${m[2]}`);
		}
	}
	return rutas;
}

describe("el veto, por el camino desplegado", () => {
	it("el barrido del fuente ve las rutas con veto que hay", () => {
		// Si deja de ver una, o es que ya no lleva el veto (lo pilla la petición de abajo) o es que el
		// barrido ya no reconoce su router: que se vea aquí, no en silencio.
		expect(rutasConVetoDeRol()).toEqual(expect.arrayContaining(CON_VETO_DE_ROL));
	});

	it("una Handy se queda en el veto de cada ruta, dentro del TenantHub, aunque el cuerpo no valga", async () => {
		const rutas = [...new Set([...CON_VETO_DE_ROL, ...rutasConVetoDeRol()])];
		await conNegocioFirmado(deps, "veto-desplegado", async (n) => {
			const mal: string[] = [];
			for (const r of rutas) {
				const [metodo, plantilla] = r.split(" ");
				const ruta = plantilla.replace(/:\w+/g, "x");
				const conCuerpo = metodo !== "GET" && metodo !== "DELETE";
				const res = await pedirComo(deps, app, n, HANDY, metodo, ruta, conCuerpo ? { esto: "no vale" } : undefined);
				if (res.status !== 403 || res.viajes !== 1) {
					mal.push(`${r}: ${res.status}, ${res.viajes} viajes, ${JSON.stringify(res.json).slice(0, 120)}`);
				}
			}
			expect(mal, "la Handy pasó el veto, o se decidió fuera del TenantHub").toEqual([]);
		});
	});
});
