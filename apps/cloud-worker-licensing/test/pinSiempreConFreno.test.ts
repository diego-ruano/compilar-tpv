// test/pinSiempreConFreno.test.ts
//
// REV-06: una ruta que verifica un PIN tiene que tener el freno de LOGIN-01.
//
// El bug era `/complete-initial-setup`: comprobaba el PIN y no miraba el bloqueo por intentos
// fallidos, así que desde cualquier Handy vinculada se podían probar las diez mil combinaciones de
// un PIN de cuatro cifras sin ninguna espera, y al acertar se le cambiaban PIN y correo a cualquier
// usuario activo — administrador incluido. Esa ruta ya no existe: el setup inicial lo hace la Main
// contra su propia base y sube por `/sync-initial-setup`.
//
// Pero comprobar que aquella ruta no está sólo protege de aquella ruta. Lo que se fija aquí es la
// REGLA, leyendo el fuente: **cada** sitio que llame a `ensurePin` tiene que estar dentro de un
// handler que mire `throttleSecondsLeft` antes y llame a `throttleFail` cuando el PIN no valga. Así
// el que se equivoque es el próximo que alguien escriba, no sólo el que ya arreglamos.
//
// Leer el fuente es la única forma de verlo: el olvido no es un comportamiento que se pueda
// provocar, es una línea que no está.

import { describe, expect, it } from "vitest";

import fuente from "../src/domains/login/login.routes.ts?raw";

/** Parte el fichero en handlers: `loginRoutes.post("…", …)` hasta el siguiente. */
function handlers(src: string): { ruta: string; cuerpo: string }[] {
	const re = /loginRoutes\.(get|post|put|delete)\(\s*"([^"]+)"/g;
	const inicios: { ruta: string; desde: number }[] = [];
	for (let m = re.exec(src); m !== null; m = re.exec(src)) {
		inicios.push({ ruta: `${m[1].toUpperCase()} ${m[2]}`, desde: m.index });
	}
	return inicios.map((x, i) => ({
		ruta: x.ruta,
		cuerpo: src.slice(x.desde, inicios[i + 1]?.desde ?? src.length),
	}));
}

describe("REV-06 · verificar un PIN exige el freno de LOGIN-01", () => {
	const conPin = handlers(fuente).filter((h) => h.cuerpo.includes("ensurePin("));

	it("hay rutas que verifican PIN (si no, este test no estaría probando nada)", () => {
		// Sin esto, borrar `ensurePin` del fichero dejaría el test en verde por vacío.
		expect(conPin.map((h) => h.ruta).sort()).toEqual(["POST /login", "POST /punch"]);
	});

	for (const h of conPin) {
		it(`${h.ruta} mira el bloqueo antes de comprobar el PIN`, () => {
			expect(h.cuerpo).toContain("throttleSecondsLeft");
			// Y el 429 con los segundos que faltan, que es lo que la pantalla enseña.
			expect(h.cuerpo).toContain("429");
			// El orden importa: mirar el bloqueo DESPUÉS de verificar convierte el freno en adorno.
			expect(h.cuerpo.indexOf("throttleSecondsLeft")).toBeLessThan(h.cuerpo.indexOf("ensurePin("));
		});

		it(`${h.ruta} cuenta el intento cuando el PIN no vale`, () => {
			// Sin esto el contador nunca sube y el bloqueo no llega a activarse jamás.
			expect(h.cuerpo).toContain("throttleFail");
			expect(h.cuerpo).toContain("throttleReset");
		});
	}

	it("el setup inicial ya no se puede hacer desde la nube", () => {
		// La corrección de REV-06 es una ausencia, así que se fija como tal. El camino bueno —la
		// Main sube el resultado de su setup local— sigue donde estaba.
		// Se mira la tabla de RUTAS y no el texto del fichero: ahí arriba hay un comentario que
		// explica por qué se fue, y ese comentario tiene que poder seguir nombrándola.
		const rutas = handlers(fuente).map((h) => h.ruta);
		expect(rutas).not.toContain("POST /complete-initial-setup");
		expect(rutas).toContain("POST /sync-initial-setup");
	});
});
