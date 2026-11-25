// test/pinSiempreConFreno.test.ts
//
// REV-06: una ruta que verifica un PIN tiene que tener el freno de LOGIN-01.
//
// El bug era `/complete-initial-setup`: comprobaba el PIN y no miraba el bloqueo por intentos
// fallidos, así que desde cualquier Handy vinculada se podían probar las diez mil combinaciones de
// un PIN de cuatro cifras sin ninguna espera, y al acertar se le cambiaban PIN y correo a cualquier
// usuario activo — administrador incluido. Esa ruta ya no existe: el setup inicial lo hace la Main
// contra su propia base y sube por el outbox.
//
// Pero comprobar que aquella ruta no está sólo protege de aquella ruta. Lo que se fija aquí es la
// REGLA, leyendo el fuente: **cada** sitio que verifique un PIN tiene que estar dentro de un handler
// que RESERVE el intento antes (`reservarIntento`, AUD-05), conteste 429 si no se lo conceden y
// limpie el recuento sólo después de acertar. Así el que se equivoque es el próximo que alguien
// escriba, no sólo el que ya arreglamos.
//
// Leer el fuente es la única forma de verlo: el olvido no es un comportamiento que se pueda
// provocar, es una línea que no está. Que la reserva aguante los intentos simultáneos sí es un
// comportamiento, y lo prueba `loginFrenoConcurrente.test.ts`. Y que el freno funciona por el camino
// desplegado (la `app`, `alHub` y la ruta dentro del TenantHub, con el freno en la base del negocio),
// el último caso.

import { describe, expect, it } from "vitest";

import fuente from "../src/domains/login/login.routes.ts?raw";
import { conNegocioFirmado, enLaBaseDe, HANDY, pedirComo } from "./helpers/negocioFirmado";
import { app } from "../src/app";
import { firmarSesion } from "../src/lib/sesion";
import { olvidarLicenciasCacheadas } from "../src/lib/licenciaEnUso";

const deps = { firmarSesion, olvidarLicenciasCacheadas };

const fuentes = import.meta.glob("../src/**/*.ts", { query: "?raw", import: "default", eager: true }) as Record<string, string>;

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
	const conPin = handlers(fuente).filter((h) => /\b(ensurePin|verifyPin)\(/.test(h.cuerpo));

	it("hay rutas que verifican PIN (si no, este test no estaría probando nada)", () => {
		// Sin esto, borrar `ensurePin` del fichero dejaría el test en verde por vacío.
		expect(conPin.map((h) => h.ruta).sort()).toEqual(["POST /login", "POST /punch"]);
	});

	it("un PIN sólo se verifica en esas rutas, y siempre por `ensurePin`", () => {
		// `verifyPin` se llama una vez en todo el worker: dentro de `ensurePin`, que no es un handler.
		// Una ruta que lo llamara por su cuenta, aquí o en otro dominio, se saltaría lo de abajo.
		const quienesVerifican = Object.keys(fuentes).filter(
			(ruta) => !ruta.endsWith("/login/login.crypto.ts") && /\bverifyPin\(/.test(fuentes[ruta]),
		);
		expect(quienesVerifican).toHaveLength(1);
		expect(quienesVerifican[0]).toMatch(/\/login\/login\.routes\.ts$/);
		expect(fuente.match(/\bverifyPin\(/g)).toHaveLength(1);
		for (const h of conPin) expect(h.cuerpo).not.toMatch(/\bverifyPin\(/);
	});

	for (const h of conPin) {
		it(`${h.ruta} reserva el intento antes de comprobar el PIN`, () => {
			const reserva = h.cuerpo.indexOf("reservarIntento(");
			const verifica = h.cuerpo.indexOf("ensurePin(");
			expect(reserva).toBeGreaterThan(-1);
			// El orden importa: reservar DESPUÉS de verificar convierte el freno en adorno (AUD-05).
			expect(reserva).toBeLessThan(verifica);
			// Y un solo sitio donde se verifica: un segundo `ensurePin` quedaría fuera de esta cuenta.
			expect(h.cuerpo.match(/\bensurePin\(/g)).toHaveLength(1);
			// Sin reserva no se llega a verificar: se contesta el 429 con los segundos que faltan, que
			// es lo que la pantalla enseña.
			const entreMedias = h.cuerpo.slice(reserva, verifica);
			expect(entreMedias).toContain("!reserva.concedido");
			expect(entreMedias).toContain("429");
			expect(entreMedias).toContain("reserva.segundos");
		});

		it(`${h.ruta} sólo limpia el recuento después de acertar`, () => {
			// El intento reservado ES el fallo contado: si se limpiara antes de verificar, o sin mirar
			// el resultado, el contador nunca subiría y el bloqueo no llegaría a activarse jamás.
			const trasVerificar = h.cuerpo.slice(h.cuerpo.indexOf("ensurePin("));
			expect(h.cuerpo.match(/throttleReset\(/g)).toHaveLength(1);
			expect(trasVerificar).toContain("throttleReset(");
			expect(trasVerificar.indexOf("if (badPin) return badPin;")).toBeGreaterThan(-1);
			expect(trasVerificar.indexOf("if (badPin) return badPin;")).toBeLessThan(
				trasVerificar.indexOf("throttleReset("),
			);
			// Y lo limpia diciendo qué bloqueo fijó SU reserva: es lo que impide que un acierto que
			// llega tarde se lleve el bloqueo que puso un intento posterior.
			expect(trasVerificar).toContain("throttleReset(db, datos.id_usuario, reserva.bloqueadoHastaMs)");
		});
	}

	it("el setup inicial ya no se puede hacer ni subir desde la nube", () => {
		// Las correcciones de REV-06 y de AUD-24 son ausencias, así que se fijan como tales: ni
		// `/complete-initial-setup` (elegía el PIN desde la nube) ni `/sync-initial-setup` (lo
		// subía directo a la base del negocio para cualquier usuario). El PIN inicial sube por el outbox.
		// Se mira la tabla de RUTAS y no el texto del fichero: ahí arriba hay un comentario que
		// explica por qué se fueron, y ese comentario tiene que poder seguir nombrándolas.
		const rutas = handlers(fuente).map((h) => h.ruta);
		// Que la tabla se lee de verdad: sin esto, un `handlers` roto dejaría las ausencias en verde.
		expect(rutas).toContain("POST /login");
		expect(rutas).not.toContain("POST /complete-initial-setup");
		expect(rutas).not.toContain("POST /sync-initial-setup");
	});
});

describe("por el camino desplegado", () => {
	it("una Handy que falla el PIN se frena dentro del TenantHub, con el freno en la base del negocio", async () => {
		await conNegocioFirmado(deps, "pin-desplegado", async (n) => {
			// Un hash que no se deja verificar: cada intento es un fallo, sin las 100.000 vueltas.
			await enLaBaseDe(n, (sql) =>
				sql.exec(
					`INSERT INTO Usuarios (ID_Usuario, ID_Rol, Email, Password_Hash, Nombre, Estado, Requiere_Setup)
					 VALUES ('u-pin', '00000000-0000-7000-8000-000000000001', 'pin@ejemplo.test', 'pbkdf2$no-es-un-hash', 'Pin', 'Activo', 0);`,
				),
			);
			const intentar = () => pedirComo(deps, app, n, HANDY, "POST", "/v1/login/login", { id_usuario: "u-pin", pin: "1234" });

			// Cinco libres y el sexto, que pone el bloqueo: los seis se verifican y fallan.
			for (let i = 1; i <= 6; i++) {
				const r = await intentar();
				expect(r.status, `intento ${i}`).toBe(401);
				expect(r.viajes, `intento ${i}`).toBe(1);
			}
			// El séptimo no se verifica.
			const frenado = await intentar();
			expect(frenado.status).toBe(429);
			expect(frenado.viajes).toBe(1);
			await enLaBaseDe(n, (sql) => {
				const fila = sql.exec("SELECT Intentos_Fallidos AS n, Bloqueado_Hasta_Ms AS hasta FROM Intentos_Login WHERE ID_Usuario = 'u-pin';").one();
				expect(fila.n).toBe(6);
				expect(fila.hasta).toBeGreaterThan(Date.now());
			});
		});
	});
});
