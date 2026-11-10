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
 * viaja en el cuerpo.
 */
const VETOS = /\b(soloLaMain\w*|filtroExterior|puertaPublica|limitadorAltas|verificacionHumana|topeDelCuerpo|exigirFirma)\b/g;

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
